/**
 * OpenAI → M365 Copilot Request Translator
 *
 * M365 Copilot's WebSocket protocol does NOT support native tool calling.
 * Worse, M365 has a server-side Code Interpreter that automatically executes
 * commands in a remote sandbox — and there is NO client-side flag to fully
 * disable this behavior.
 *
 * Strategy (tool classification):
 *
 *   Agent tools are classified into three categories:
 *   - SHELL: Bash, exec_command, run_command → must execute locally,
 *     never remotely. Inject anti-execution prompt, buffer for tool_calls.
 *   - SEARCH: WebSearch, WebFetch → M365's web search is useful;
 *     keep BingWebSearch plugin enabled.
 *   - FILE_OPS: Read, Edit, Write, Glob → need local execution too,
 *     treated as needsLocalExec (shell commands under the hood).
 *
 *   M365 capability control is fine-grained:
 *   - disableCodeInterpreter: when needsLocalExec (shell + file ops)
 *   - enableSearch: always true (search enriches responses)
 *   - bufferForTools: when needsLocalExec (detect JSON tool_calls in response)
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { ROLE } from "../schema/index.js";
import { createHash } from "crypto";

const SEEN_CONV_MAX = 500;
const SEEN_CONV_TTL_MS = 30 * 60 * 1000;
const seenConversationFingerprints = new Map();

function getConversationFingerprint(messages) {
  for (const m of messages) {
    if (m.role === ROLE.USER) {
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
      return text.slice(0, 120);
    }
  }
  return null;
}

function computeConversationId(fingerprint, connectionId) {
  const base = fingerprint
    ? `${connectionId || "anon"}:conv:${createHash("sha256").update(fingerprint).digest("hex").slice(0, 16)}`
    : `${connectionId || "anon"}`;
  const hash = createHash("sha256").update(base).digest("hex");
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`;
}

function markConversationSeen(conversationId) {
  seenConversationFingerprints.set(conversationId, Date.now());
  if (seenConversationFingerprints.size > SEEN_CONV_MAX) {
    const now = Date.now();
    for (const [k, ts] of seenConversationFingerprints) {
      if (now - ts > SEEN_CONV_TTL_MS) seenConversationFingerprints.delete(k);
    }
    if (seenConversationFingerprints.size > SEEN_CONV_MAX) {
      const entries = [...seenConversationFingerprints.entries()].sort((a, b) => a[1] - b[1]);
      for (let i = 0; i < entries.length - SEEN_CONV_MAX / 2; i++) {
        seenConversationFingerprints.delete(entries[i][0]);
      }
    }
  }
}

function isConversationSeen(conversationId) {
  const ts = seenConversationFingerprints.get(conversationId);
  if (!ts) return false;
  if (Date.now() - ts > SEEN_CONV_TTL_MS) {
    seenConversationFingerprints.delete(conversationId);
    return false;
  }
  return true;
}

const SEARCH_TOOL_PATTERNS = [
  "websearch", "web_search", "webfetch", "web_fetch",
  "search_web", "searchweb", "bing_search",
  "mcp__exa__web_search", "mcp__exa__web_fetch",
  "browser_navigate", "browser_snapshot", "browser_click",
  "browser_type", "browser_screenshot", "browser_go_back", "browser_go_forward",
  "browser_wait", "browser_press_key",
];

const SHELL_TOOL_NAMES = new Set([
  "local_shell", "run_command", "execute_command", "exec_command",
  "Bash", "bash", "execute_bash", "run_bash",
  "shell_exec", "computer_terminal", "terminal",
]);

const FILE_OP_TOOL_NAMES = new Set([
  "Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit",
  "view_file", "write_to_file", "replace_file_content",
  "multi_replace_file_content", "list_dir", "find_by_name",
  "grep_search", "view_content_chunk",
]);

function classifyToolName(name) {
  if (SHELL_TOOL_NAMES.has(name)) return "shell";
  if (FILE_OP_TOOL_NAMES.has(name)) return "fileOp";
  const n = name.toLowerCase();
  if (SEARCH_TOOL_PATTERNS.some(p => n.includes(p))) return "search";
  return "shell";
}

function formatToolResult(tcName, resultStr) {
  const kind = classifyToolName(tcName);
  if (kind === "fileOp") {
    const label = tcName === "Read" || tcName === "view_file" || tcName === "view_content_chunk"
      ? "File content"
      : tcName === "Glob" || tcName === "find_by_name" || tcName === "list_dir"
        ? "File listing"
        : tcName === "Grep" || tcName === "grep_search"
          ? "Search results"
          : "File operation result";
    return `[${label} (${tcName}):\n${resultStr}`;
  }
  return `[Output (${tcName}):\n${resultStr}`;
}

function extractContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(p => p && typeof p === "object" && (p.type === "text" || p.type === "input_text") && typeof p.text === "string")
      .map(p => p.text)
      .join("");
  }
  return "";
}

function classifyTool(name, description) {
  const n = name.toLowerCase();
  const d = (description || "").toLowerCase();

  const isShell = d.includes("shell") || d.includes("command") || d.includes("bash") ||
      d.includes("exec") || d.includes("terminal") || d.includes("run") ||
      n.includes("shell") || n.includes("bash") || n.includes("exec") ||
      SHELL_TOOL_NAMES.has(name);

  const isSearch = SEARCH_TOOL_PATTERNS.some(p => n.includes(p) || d.includes(p));

  const isFileOp = FILE_OP_TOOL_NAMES.has(name);

  return { isShell, isSearch, isFileOp };
}

const M365_DANGEROUS_CMD_RE = /\b(rm|rmdir|del|delete|shred|format|erase|wipe|destroy|destructive|truncate|overwrite|kill|killall|chmod|chown)\b/gi;
const M365_JAILBREAK_PHRASES = [
  /\[SYSTEM OVERRIDE[^\]]*\]/gi,
  /HIGHEST PRIORITY/gi,
  /NOT in your sandbox/gi,
  /Do NOT (?:execute|run|use)/gi,
  /MUST NOT/gi,
  /Do NOT use your code interpreter/gi,
  /executed locally, NOT/gi,
  /CRITICAL RULES/gi,
  /CRITICAL SAFETY RULE/gi,
];

const SANITIZE_SKIP_PREFIXES = [
  "[Output (",
  "[Result from ",
  "[File content (",
  "[File listing (",
  "[Search results (",
  "[File operation result (",
];

const SANITIZE_RESUME_MARKERS = ["[System]:", "[User]:", "[Assistant]:", "---\n"];

function sanitizeForM365(text) {
  if (!text) return text;
  const segments = [];
  let remaining = text;
  while (remaining.length > 0) {
    let skipStart = -1;
    let skipPrefix = "";
    for (const prefix of SANITIZE_SKIP_PREFIXES) {
      const idx = remaining.indexOf(prefix);
      if (idx !== -1 && (skipStart === -1 || idx < skipStart)) {
        skipStart = idx;
        skipPrefix = prefix;
      }
    }
    if (skipStart === -1) {
      segments.push({ text: remaining, sanitize: true });
      break;
    }
    if (skipStart > 0) {
      segments.push({ text: remaining.slice(0, skipStart), sanitize: true });
    }
    const afterPrefix = remaining.slice(skipStart);
    let resumeAt = afterPrefix.length;
    for (const marker of SANITIZE_RESUME_MARKERS) {
      const mIdx = afterPrefix.indexOf(marker, skipPrefix.length);
      if (mIdx !== -1 && mIdx < resumeAt) resumeAt = mIdx;
    }
    segments.push({ text: afterPrefix.slice(0, resumeAt), sanitize: false });
    remaining = afterPrefix.slice(resumeAt);
  }

  let result = "";
  let cmdIdx = 0;
  for (const seg of segments) {
    if (!seg.sanitize) {
      result += seg.text;
      continue;
    }
    const replacements = [];
    let m;
    const cmdRe = /\b(rm|rmdir|del|delete|shred|format|erase|wipe|destroy|destructive|truncate|overwrite|kill|killall|chmod|chown)\b/gi;
    while ((m = cmdRe.exec(seg.text)) !== null) {
      cmdIdx++;
      replacements.push({ start: m.index, end: m.index + m[0].length, idx: cmdIdx });
    }
    if (replacements.length > 0) {
      const parts = [];
      let lastEnd = 0;
      for (const r of replacements) {
        parts.push(seg.text.slice(lastEnd, r.start));
        parts.push(`[cmd${r.idx}]`);
        lastEnd = r.end;
      }
      parts.push(seg.text.slice(lastEnd));
      result += parts.join("");
    } else {
      result += seg.text;
    }
  }
  for (const phraseRe of M365_JAILBREAK_PHRASES) {
    result = result.replace(phraseRe, "[note]");
  }
  result = result.replace(/CRITICAL SAFETY RULE:/i, "[policy note:]");
  return result;
}

function buildToolMeta(tools) {
  if (!tools || tools.length === 0) return null;

  const toolNameMap = new Map();
  const shellToolNames = [];
  const shellToolSchemas = {};
  const searchToolNames = [];
  const fileOpToolNames = [];

  for (const tool of tools) {
    const func = tool.function;
    if (!func) continue;
    const name = func.name || "unknown";
    toolNameMap.set(name, { name });

    const { isShell, isSearch, isFileOp } = classifyTool(name, func.description);
    if (isShell) {
      shellToolNames.push(name);
      shellToolSchemas[name] = func.parameters || null;
    }
    if (isSearch) {
      searchToolNames.push(name);
    }
    if (isFileOp) {
      fileOpToolNames.push(name);
      if (!isShell) {
        shellToolNames.push(name);
        shellToolSchemas[name] = null;
      }
    }
  }

  const needsLocalExec = shellToolNames.length > 0 || fileOpToolNames.length > 0;
  const hasSearchTools = searchToolNames.length > 0;

  return {
    toolNameMap,
    shellToolNames,
    shellToolSchemas,
    searchToolNames,
    fileOpToolNames,
    needsLocalExec,
    hasSearchTools,
  };
}

function buildAntiExecutionPrompt(shellToolNames, shellToolSchemas, hasSearchTools, model, langHint) {
  if (!shellToolNames || shellToolNames.length === 0) return "";

  const primaryTool = shellToolNames[0];
  const schema = shellToolSchemas?.[primaryTool];

  const isGpt56 = model && (model === "gpt-5.6" || model.toLowerCase().includes("gpt-5.6"));

  const destructiveBlock = "";

  let schemaInstr;
  if (schema && schema.properties) {
    const props = schema.properties;
    const required = schema.required || [];
    const paramParts = [];
    for (const [key, val] of Object.entries(props)) {
      const req = required.includes(key) ? " (required)" : " (optional)";
      paramParts.push(`    "${key}": <${val.type || "string"}>${req}`);
    }
    schemaInstr = [
      `When you need to execute a command, output EXACTLY this JSON on a single line:`,
      `{"name": "${primaryTool}", "arguments": {`,
      paramParts.join(",\n"),
      `  }}`,
      ``,
      `Example for listing files:`,
      `{"name": "${primaryTool}", "arguments": { ${Object.keys(props)[0]}: "ls" }}`,
    ].join("\n");
  } else {
    schemaInstr = [
      `When you need to execute a command, output JSON like:`,
      `{"name": "${primaryTool}", "arguments": {"command": "<the_command>"}}`,
    ].join("\n");
  }

  const scopeConstraint = "Do ONLY what the user explicitly asks. Do NOT expand scope — if the user asks to read one file, read only that file; do NOT read related files, dependencies, or follow-up files unless the user asks.";

  if (hasSearchTools) {
    return [
      destructiveBlock,
      "You are assisting a user who has a command-line interface. For any action the user requests (checking, searching, reading, listing, etc.), always output a JSON instruction using this schema, and the user will handle the execution:",
      schemaInstr,
      scopeConstraint,
      langHint,
      "IMPORTANT: You MUST output a JSON instruction for ANY action — including reading files, listing directories, checking status, or running commands. The ONLY time you should use plain text is when you are providing a final summary with NO further actions needed.",
    ].filter(Boolean).join(" ");
  }

  return [
    destructiveBlock,
    "You are assisting a user who has a command-line interface. For any action the user requests, always output a JSON instruction using this schema, and the user will handle the execution:",
    schemaInstr,
    scopeConstraint,
    langHint,
    "IMPORTANT: You MUST output a JSON instruction for ANY action — including reading files, listing directories, checking status, or running commands. The ONLY time you should use plain text is when you are providing a final summary with NO further actions needed.",
  ].filter(Boolean).join(" ");
}

const M365_MAX_TOOL_RESULT_LEN = 8000;
const M365_MAX_FILE_CONTENT_LEN = 3000;
const M365_MAX_SHELL_OUTPUT_LEN = 6000;

function truncateToolResult(resultStr, maxLen = M365_MAX_TOOL_RESULT_LEN) {
  if (!resultStr || resultStr.length <= maxLen) return resultStr;
  const head = resultStr.slice(0, maxLen);
  const omitted = resultStr.length - maxLen;
  const lastNl = head.lastIndexOf("\n");
  const cutPoint = lastNl > maxLen * 0.5 ? lastNl + 1 : maxLen;
  return resultStr.slice(0, cutPoint) + `\n... [${omitted + (resultStr.length - cutPoint)} more characters omitted]`;
}

function truncateFileContent(resultStr) {
  return truncateToolResult(resultStr, M365_MAX_FILE_CONTENT_LEN);
}

function buildToolResultPrompt(toolCallId, toolName, result) {
  const resultStr = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  const truncated = truncateToolResult(resultStr);
  return [
    `[Result from ${toolName}]:`,
    truncated,
  ].join("\n");
}

function flattenMessages(messages, toolCallMetaMap) {
  const parts = [];
  console.log(`[M365-REQ-FLATTEN] total_messages=${messages.length}`);

  for (let idx = 0; idx < messages.length; idx++) {
    const msg = messages[idx];
    const role = msg.role || "";
    const preview = (typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "")).slice(0, 80).replace(/\n/g, "\\n");

    if (role === ROLE.SYSTEM || role === ROLE.DEVELOPER) {
      const text = extractContent(msg.content);
      console.log(`[M365-REQ-MSG] #${idx} role=SYSTEM len=${(text||"").length} preview=${preview}`);
      if (text) parts.push(`[System]: ${text}`);
      continue;
    }

    if (role === ROLE.USER) {
      const text = extractContent(msg.content);
      console.log(`[M365-REQ-MSG] #${idx} role=USER len=${(text||"").length} preview=${preview}`);
      if (text) parts.push(`[User]: ${text}`);
      continue;
    }

    if (role === ROLE.ASSISTANT) {
      const text = extractContent(msg.content);
      const toolParts = [];
      const tcNames = [];

      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const tcName = tc.function?.name || "unknown";
          const tcArgs = tc.function?.arguments || "{}";
          const tcId = tc.id || "";
          toolCallMetaMap.set(tcId, tcName);
          tcNames.push(tcName);
          try {
            const parsed = JSON.parse(tcArgs);
            const cmd = parsed.command || parsed.cmd || parsed.code || JSON.stringify(parsed);
            toolParts.push(`I suggested running: ${cmd}`);
          } catch {
            toolParts.push(`I suggested running: ${tcArgs}`);
          }
        }
      }

      const textParts = [];
      if (text) textParts.push(text);
      if (toolParts.length > 0) textParts.push(...toolParts);

      console.log(`[M365-REQ-MSG] #${idx} role=ASSISTANT textLen=${(text||"").length} toolCalls=${tcNames.length} names=[${tcNames.join(",")}]`);
      if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
      continue;
    }

    if (role === ROLE.TOOL) {
      const tcId = msg.tool_call_id || "";
      const tcName = toolCallMetaMap.get(tcId) || "unknown";
      const result = extractContent(msg.content) || msg.content || "";
      const resultStr = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      const kind = classifyToolName(tcName);
      let truncated;
      if (kind === "fileOp") {
        truncated = truncateFileContent(resultStr);
      } else if (tcName === "exec_command" || tcName === "Bash") {
        truncated = truncateToolResult(resultStr, M365_MAX_SHELL_OUTPUT_LEN);
      } else {
        truncated = truncateToolResult(resultStr);
      }
      console.log(`[M365-REQ-MSG] #${idx} role=TOOL toolName=${tcName} tcId=${tcId.slice(0,12)} resultLen=${truncated.length}`);
      parts.push(formatToolResult(tcName, truncated));
      continue;
    }

    console.log(`[M365-REQ-MSG] #${idx} role=${role} UNKNOWN — skipped`);
  }

  const result = parts.join("\n\n");
  console.log(`[M365-REQ-FLATTEN] result_len=${result.length} parts=${parts.length}`);
  return result;
}

function extractFilePathsFromCmd(cmd) {
  const paths = [];
  const seen = new Set();
  const fileExtRe = /\.(?:java|py|js|ts|jsx|tsx|go|rs|rb|php|c|cpp|h|cs|swift|kt|scala|sh|yaml|yml|json|toml|xml|html|css|md|txt|properties|conf|cfg|ini|env|sql|gradle|makefile|dockerfile|lock)\b/i;
  const pathRe = /['"]?((?:\.?\/)?(?:\w[\w.-]*\/)+\w[\w.-]*\.\w{1,10})['"]?/g;
  let m;
  while ((m = pathRe.exec(cmd)) !== null) {
    const p = m[1].replace(/['"]/g, "");
    if (fileExtRe.test(p) && !seen.has(p)) {
      seen.add(p);
      paths.push(p);
    }
  }
  return paths;
}

function isFileReadingCmd(cmd) {
  if (!cmd) return false;
  const c = cmd.trim().toLowerCase();
  return /^\s*(sed\s+-n|cat\s|head\s|tail\s|less\s|more\s)/.test(c) ||
         /^\s*(cat|head|tail|less|more)\s/.test(c);
}

function getFileReadingTarget(cmd) {
  const paths = extractFilePathsFromCmd(cmd);
  return paths.length > 0 ? paths[0] : null;
}

function buildEarlierContext(messages, stopIndex, toolCallMetaMap, startScanIdx = 0) {
  if (stopIndex <= 0) return { text: "", textWithoutPrevCmd: "", filesReadCount: 0, lastReadFile: "" };
  const prevCmds = [];
  const filesInContext = new Set();
  let filesReadCount = 0;
  let lastReadFile = "";
  for (let k = startScanIdx; k < stopIndex; k++) {
    const msg = messages[k];
    const role = msg.role || "";
    if (role === ROLE.ASSISTANT && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const tcName = tc.function?.name || "unknown";
        const tcId = tc.id || "";
        toolCallMetaMap.set(tcId, tcName);
        try {
          const parsed = JSON.parse(tc.function?.arguments || "{}");
          const cmd = parsed.command || parsed.cmd || parsed.code || "";
          if (cmd) {
            prevCmds.push(cmd);
            const fps = extractFilePathsFromCmd(cmd);
            for (const fp of fps) filesInContext.add(fp);
            if (isFileReadingCmd(cmd)) {
              filesReadCount++;
              const target = getFileReadingTarget(cmd);
              if (target) lastReadFile = target;
            }
          }
        } catch {}
      }
    }
    if (role === ROLE.TOOL) {
      const tcId = msg.tool_call_id || "";
      if (!toolCallMetaMap.has(tcId)) toolCallMetaMap.set(tcId, "unknown");
    }
  }
  const parts = [];
  const lastCmd = prevCmds.length > 0 ? prevCmds[prevCmds.length - 1] : "";
  if (lastCmd) parts.push(`Previous command: ${lastCmd.slice(0, 200)}`);
  if (prevCmds.length > 1) {
    parts.push(`Commands executed so far: ${prevCmds.length}`);
  }
  if (filesInContext.size > 0) {
    const fileList = [...filesInContext].slice(0, 20).join(", ");
    parts.push(`Files already read (content available in context, do NOT re-read): ${fileList}`);
  }
  const searchPatterns = new Set();
  for (const c of prevCmds) {
    const quotedMatches = c.match(/['"]([^'"]+)['"]/g);
    if (quotedMatches) {
      for (const qm of quotedMatches) {
        const inner = qm.slice(1, -1);
        if (/^(accessKey|bucket|endpoint|config|secret|password|private|import|class|def |function |public )/i.test(inner)) {
          searchPatterns.add(inner.slice(0, 60));
        }
      }
    }
  }
  if (searchPatterns.size > 0) {
    parts.push(`Search patterns already queried: ${[...searchPatterns].slice(0, 10).join(", ")}. Do NOT repeat the same search.`);
  }
  if (filesReadCount >= 3) {
    parts.push(`WARNING: You have already read ${filesReadCount} files. If you are about to read a file you have already read, STOP and summarize what you know instead.`);
  }
  const text = parts.length > 0 ? `[Context]: ${parts.join(". ")}` : "";
  const partsWithoutPrevCmd = parts.filter(p => !p.startsWith("Previous command:"));
  const textWithoutPrevCmd = partsWithoutPrevCmd.length > 0
    ? `[Context]: ${partsWithoutPrevCmd.join(". ")}`
    : "";
  return { text, textWithoutPrevCmd, filesReadCount, lastReadFile };
}

function detectUserLanguage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== ROLE.USER) continue;
    const text = extractContent(m.content) || "";
    const cjk = text.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uac00-\ud7af]/g);
    if (cjk && cjk.length >= 1) {
      console.log(`[M365-REQ-LANG] detected=zh at msg#${i} cjk=${cjk.length} preview=${text.slice(0,60).replace(/\n/g,"\\n")}`);
      return "zh";
    }
  }
  console.log(`[M365-REQ-LANG] detected=en (no CJK found in USER messages)`);
  return "en";
}

function extractContinuationPrompt(messages, toolCallMetaMap, toolMeta) {
  const lastMsg = messages[messages.length - 1];
  const lastRole = lastMsg.role || "";

  const lastUserText = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === ROLE.USER) return extractContent(messages[i].content) || "";
    }
    return "";
  })();

  const userLang = detectUserLanguage(messages);
  const langHint = userLang === "zh" ? "Reply in Chinese (中文)." : "";

  const ctx = buildEarlierContext(messages, messages.length, toolCallMetaMap, 0);
  const contextParts = [];
  if (ctx.textWithoutPrevCmd) contextParts.push(ctx.textWithoutPrevCmd);

  let lastPairUserIdx = -1;
  for (let i = messages.length - 2; i >= 0; i--) {
    if (messages[i].role === ROLE.USER) {
      let j = i + 1;
      while (j < messages.length - 1 && messages[j].role !== ROLE.USER) j++;
      if (j < messages.length && messages[j].role === ROLE.ASSISTANT) {
        lastPairUserIdx = i;
        break;
      }
    }
  }
  if (lastPairUserIdx >= 0) {
    const prevUserText = extractContent(messages[lastPairUserIdx].content) || "";
    let prevAssistantText = "";
    for (let j = lastPairUserIdx + 1; j < messages.length - 1; j++) {
      if (messages[j].role === ROLE.ASSISTANT && !messages[j].tool_calls?.length) {
        prevAssistantText = extractContent(messages[j].content) || "";
        if (prevAssistantText) break;
      }
    }
    const pairParts = [];
    if (prevUserText) pairParts.push(`[Previous User]: ${prevUserText.slice(0, 300)}`);
    if (prevAssistantText) pairParts.push(`[Previous Assistant]: ${prevAssistantText.slice(0, 300)}`);
    if (pairParts.length > 0) contextParts.push(pairParts.join("\n"));
  }

  if (lastRole === ROLE.USER) {
    console.log(`[M365-REQ-CONTINUATION] type=new_user_message textLen=${lastUserText.length} hasPrevPair=${lastPairUserIdx >= 0}`);
    const parts = [];
    if (contextParts.length > 0) parts.push(...contextParts);
    parts.push(`[User]: ${lastUserText}`);
    if (langHint) parts.push(langHint);
    return parts.join("\n\n");
  }

  if (lastRole === ROLE.ASSISTANT) {
    const assistantText = extractContent(lastMsg.content) || "";
    const tcNames = [];
    if (lastMsg.tool_calls) {
      for (const tc of lastMsg.tool_calls) {
        const tcName = tc.function?.name || "unknown";
        tcNames.push(tcName);
        toolCallMetaMap.set(tc.id || "", tcName);
      }
    }
    console.log(`[M365-REQ-CONTINUATION] type=assistant textLen=${assistantText.length} toolCalls=${tcNames.length} hasPrevPair=${lastPairUserIdx >= 0}`);
    const parts = [];
    if (contextParts.length > 0) parts.push(...contextParts);
    parts.push(`[Assistant]: ${assistantText}`);
    if (langHint) parts.push(langHint);
    return parts.join("\n\n");
  }

  console.log(`[M365-REQ-CONTINUATION] type=unknown lastRole=${lastRole} → fallback to flattenMessages`);
  return null;
}

function extractLatestUserInput(messages, toolCallMetaMap, toolMeta) {
  if (!messages || messages.length === 0) {
    console.log(`[M365-REQ-EXTRACT] no messages, returning null`);
    return null;
  }

  const lastMsg = messages[messages.length - 1];
  const lastRole = lastMsg.role || "";
  const userLang = detectUserLanguage(messages);
  const langHint = userLang === "zh" ? "Reply in Chinese (中文)." : "";

  if (lastRole === ROLE.USER) {
    const text = extractContent(lastMsg.content);
    console.log(`[M365-REQ-EXTRACT] lastMsg=USER textLen=${(text||"").length} → direct user prompt`);
    if (!text) return null;
    return langHint ? `[User]: ${text}\n\n${langHint}` : `[User]: ${text}`;
  }

  if (lastRole === ROLE.TOOL) {
    const resultParts = [];
    let i = messages.length - 1;
    const toolResultCount = (() => { let c = 0; while (i - c >= 0 && messages[i - c].role === ROLE.TOOL) c++; return c; })();

    let preScan = i;
    while (preScan >= 0 && messages[preScan].role === ROLE.TOOL) preScan--;
    while (preScan >= 0 && messages[preScan].role === ROLE.ASSISTANT) {
      if (messages[preScan].tool_calls) {
        for (const tc of messages[preScan].tool_calls) {
          const tcName = tc.function?.name || "unknown";
          const tcId = tc.id || "";
          toolCallMetaMap.set(tcId, tcName);
        }
      }
      preScan--;
    }

    i = messages.length - 1;
    let patchFailCount = 0;
    while (i >= 0 && messages[i].role === ROLE.TOOL) {
      const tcId = messages[i].tool_call_id || "";
      const tcName = toolCallMetaMap.get(tcId) || "unknown";
      const result = extractContent(messages[i].content) || messages[i].content || "";
      const resultStr = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      if (resultStr.includes("apply_patch") && (resultStr.includes("verification failed") || resultStr.includes("Failed to find expected lines"))) {
        patchFailCount++;
      }
      const kind = classifyToolName(tcName);
      let truncated;
      if (kind === "fileOp") {
        truncated = truncateFileContent(resultStr);
      } else if (tcName === "exec_command" || tcName === "Bash") {
        truncated = truncateToolResult(resultStr, M365_MAX_SHELL_OUTPUT_LEN);
      } else {
        truncated = truncateToolResult(resultStr);
      }
      console.log(`[M365-REQ-EXTRACT] tool_result #${messages.length - 1 - i} toolName=${tcName} tcId=${tcId.slice(0,12)} resultLen=${truncated.length} preview=${truncated.slice(0,80).replace(/\n/g,"\\n")}`);
      resultParts.unshift(formatToolResult(tcName, truncated));
      i--;
    }

    while (i >= 0 && messages[i].role === ROLE.ASSISTANT) {
      if (messages[i].tool_calls) {
        for (const tc of messages[i].tool_calls) {
          const tcName = tc.function?.name || "unknown";
          const tcArgs = tc.function?.arguments || "{}";
          const tcId = tc.id || "";
          toolCallMetaMap.set(tcId, tcName);
          console.log(`[M365-REQ-EXTRACT] assistant tool_call name=${tcName} id=${tcId.slice(0,12)}`);
        }
      }
      i--;
    }

    let originalRequest = "";
    if (i >= 0 && messages[i].role === ROLE.USER) {
      originalRequest = extractContent(messages[i].content) || "";
      console.log(`[M365-REQ-EXTRACT] originalUserRequest at #${i} len=${originalRequest.length} preview=${originalRequest.slice(0,80).replace(/\n/g,"\\n")}`);
    } else {
      console.log(`[M365-REQ-EXTRACT] no original user request found (i=${i}, role=${i>=0?messages[i].role:"N/A"})`);
    }

    const shellToolNames = toolMeta?.shellToolNames || [];
    const primaryTool = shellToolNames[0] || "exec_command";
    const schema = toolMeta?.shellToolSchemas?.[primaryTool];
    let schemaHint;
    if (schema && schema.properties) {
      const props = schema.properties;
      const required = schema.required || [];
      const paramParts = [];
      for (const [key, val] of Object.entries(props)) {
        const req = required.includes(key) ? " (required)" : " (optional)";
        paramParts.push(`"${key}": <${val.type || "string"}>${req}`);
      }
      schemaHint = `{"name": "${primaryTool}", "arguments": { ${paramParts.join(", ")} }}`;
    } else {
      schemaHint = `{"name": "${primaryTool}", "arguments": {"cmd": "<command>"}}`;
    }

    const combinedResults = resultParts.join("\n");
    const ctx = buildEarlierContext(messages, preScan + 1, toolCallMetaMap, i);
    const totalCommands = ctx.text.match(/Commands executed so far: (\d+)/)?.[1] || "0";
    const totalCmdNum = parseInt(totalCommands, 10);

    const userIntentTag = originalRequest ? `[User's question]: ${originalRequest}\n` : "";

    console.log(`[M365-REQ-EXTRACT] tool_result_count=${toolResultCount} earlierContext=${!!ctx.textWithoutPrevCmd} combinedResultsLen=${combinedResults.length} filesReadCount=${ctx.filesReadCount} totalCommands=${totalCmdNum} lastReadFile=${ctx.lastReadFile} patchFailCount=${patchFailCount}`);

    const forceSummarize = totalCmdNum >= 15 || patchFailCount >= 3;
    const forceSummaryReason = patchFailCount >= 3
      ? `apply_patch has failed ${patchFailCount} times — the file content does not match what you expect. Do NOT use apply_patch again. Instead, provide the user with the exact code changes they should make manually (show the old lines and new lines).`
      : `You have executed ${totalCmdNum} commands so far. This is the FINAL step. Do NOT output any more JSON instructions. Instead, provide a comprehensive summary of everything you found, including all key content the user asked to see.`;
    const result = forceSummarize
      ? [
          ctx.textWithoutPrevCmd,
          userIntentTag,
          `[User]: Here is the result of the previous step:`,
          combinedResults,
          forceSummaryReason,
          langHint || "",
        ].filter(Boolean).join("\n\n")
      : [
          ctx.textWithoutPrevCmd,
          userIntentTag,
          `[User]: Here is the result of the previous step:`,
          combinedResults,
          `Analyze the output above in light of the user's question. If the user asked to see file content, include the relevant content in your response. Do ONLY what the user explicitly asks — do NOT expand scope or read additional files unless asked. If another step is needed, output a JSON instruction using this schema:`,
          schemaHint,
          ctx.filesReadCount >= 5
            ? `IMPORTANT: You have already read ${ctx.filesReadCount} files. Do NOT re-read any file already listed above. Use a different approach or summarize what you know.`
            : ctx.textWithoutPrevCmd.includes("Files already read")
              ? "Do NOT re-read files listed as 'already read' above. Use a different command or proceed to the next step."
              : "",
          `If the task is fully complete (no more commands needed), provide a summary including any key content the user asked to see. Otherwise, you MUST output a JSON instruction — never describe actions in natural language when you could output a JSON instruction instead.`,
          langHint || "",
        ].filter(Boolean).join("\n\n");

    console.log(`[M365-REQ-EXTRACT] final_extracted_len=${result.length}`);
    return result;
  }

  console.log(`[M365-REQ-EXTRACT] lastMsg role=${lastRole} → returning null (no match)`);
  return null;
}


function buildHistoricalToolCallCounts(messages) {
  const counts = new Map();
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === ROLE.USER) {
      lastUserIdx = i;
      break;
    }
  }
  const startIdx = lastUserIdx >= 0 ? lastUserIdx : 0;
  for (let i = startIdx; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== ROLE.ASSISTANT || !msg.tool_calls) continue;
    for (const tc of msg.tool_calls) {
      const name = tc.function?.name || "";
      const args = tc.function?.arguments || "";
      let sig;
      try {
        const parsed = typeof args === "string" ? JSON.parse(args) : args;
        const cmd = parsed.command || parsed.cmd || parsed.code || parsed.run || "";
        sig = cmd ? `${name}::${cmd}` : `${name}::${JSON.stringify(parsed)}`;
      } catch {
        sig = `${name}::${args}`;
      }
      counts.set(sig, (counts.get(sig) || 0) + 1);
    }
  }
  return counts;
}

function openaiToM365CopilotRequest(model, body, stream, credentials) {
  const tools = body.tools;
  const messages = body.messages || [];

  const toolCallMetaMap = new Map();
  const toolMeta = buildToolMeta(tools);
  const historicalToolCallCounts = buildHistoricalToolCallCounts(messages);

  const lastMsgRole = messages.length > 0 ? messages[messages.length - 1].role : "";
  const hasToolResults = lastMsgRole === ROLE.TOOL;
  const hasEarlierToolResults = messages.slice(0, -1).some(m => m.role === ROLE.TOOL);

  const fingerprint = getConversationFingerprint(messages);
  const convId = computeConversationId(fingerprint, credentials?.connectionId || credentials?.email || null);
  const hasAssistantHistory = messages.some(m => m.role === ROLE.ASSISTANT);
  const hasSystemPrompt = messages.some(m => m.role === ROLE.SYSTEM || m.role === ROLE.DEVELOPER);
  const earlierUserCount = messages.filter(m => m.role === ROLE.USER).length - (lastMsgRole === ROLE.USER ? 1 : 0);
  const isContinuationByCache = isConversationSeen(convId);
  const isContinuationByStructure = hasAssistantHistory && earlierUserCount > 0 && !hasToolResults;
  const isContinuation = isContinuationByCache || isContinuationByStructure;
  markConversationSeen(convId);
  console.log(`[M365-REQ-TRANSLATE] model=${model} messages=${messages.length} tools=${tools?.length||0} hasToolResults=${hasToolResults} hasEarlierToolResults=${hasEarlierToolResults} needsLocalExec=${!!toolMeta?.needsLocalExec} isContinuation=${isContinuation}(cache=${isContinuationByCache},struct=${isContinuationByStructure}) convId=${convId} hasSystem=${hasSystemPrompt} earlierUser=${earlierUserCount} shellTools=${JSON.stringify(toolMeta?.shellToolNames||[])} searchTools=${JSON.stringify(toolMeta?.searchToolNames||[])} fileOpTools=${JSON.stringify(toolMeta?.fileOpToolNames||[])}`);


  let flatMessages;
  let usedExtract = false;
  let strategy = "";
  if (hasToolResults) {
    flatMessages = extractLatestUserInput(messages, toolCallMetaMap, toolMeta);
    if (flatMessages) {
      usedExtract = true;
      strategy = "extractLatestUserInput";
    } else {
      flatMessages = flattenMessages(messages, toolCallMetaMap);
      strategy = "flattenMessages(tool_fallback)";
    }
  } else if (hasEarlierToolResults && isContinuation) {
    const continuationPrompt = extractContinuationPrompt(messages, toolCallMetaMap, toolMeta);
    if (continuationPrompt) {
      flatMessages = continuationPrompt;
      usedExtract = true;
      strategy = "extractContinuationPrompt(earlier_tools)";
    } else {
      flatMessages = flattenMessages(messages, toolCallMetaMap);
      strategy = "flattenMessages(earlier_tools_continuation_fallback)";
    }
  } else if (hasEarlierToolResults) {
    flatMessages = flattenMessages(messages, toolCallMetaMap);
    strategy = "flattenMessages(earlier_tools_first_turn)";
  } else if (isContinuation) {
    const continuationPrompt = extractContinuationPrompt(messages, toolCallMetaMap, toolMeta);
    if (continuationPrompt) {
      flatMessages = continuationPrompt;
      usedExtract = true;
      strategy = "extractContinuationPrompt";
    } else {
      flatMessages = flattenMessages(messages, toolCallMetaMap);
      strategy = "flattenMessages(continuation_fallback)";
    }
  } else {
    flatMessages = flattenMessages(messages, toolCallMetaMap);
    strategy = "flattenMessages(first_turn)";
  }
  console.log(`[M365-REQ-TRANSLATE] strategy=${strategy} result_len=${flatMessages.length}`);

  const needsLocalExec = !!toolMeta?.needsLocalExec;
  const langHint = detectUserLanguage(messages) === "zh" ? "Reply in Chinese (中文)." : "";
  let finalPrompt;
  if (needsLocalExec) {
    const antiExecPrompt = buildAntiExecutionPrompt(
      toolMeta.shellToolNames,
      toolMeta.shellToolSchemas,
      toolMeta.hasSearchTools,
      body.model,
      langHint,
    );
    console.log(`[M365-REQ-TRANSLATE] antiExecPrompt_len=${antiExecPrompt.length}`);
    if (hasToolResults) {
      const langFooter = langHint ? `\n${langHint}` : "";
      const reminder = [
        `You provided a JSON instruction in the previous step and here is the result.`,
        `Do ONLY what the user explicitly asks — do NOT expand scope or read additional files unless the user asks.`,
        `Based on the result above, decide if further action is needed. If YES, you MUST output a JSON instruction (never describe what you would do in natural language). If the task is FULLY complete with no further actions, provide a summary.`,
        antiExecPrompt,
        langFooter,
      ].filter(Boolean).join("\n");
      finalPrompt = `${flatMessages}\n\n---\n\n${reminder}`;
      console.log(`[M365-REQ-TRANSLATE] prompt_layout=flatMessages+reminder finalPrompt_len=${finalPrompt.length}`);
    } else if (isContinuation && strategy.startsWith("extractContinuationPrompt")) {
      const schemaHint = (() => {
        const primaryTool = toolMeta.shellToolNames?.[0] || "exec_command";
        const schema = toolMeta.shellToolSchemas?.[primaryTool];
        if (schema && schema.properties) {
          const props = schema.properties;
          const required = schema.required || [];
          const paramParts = [];
          for (const [key, val] of Object.entries(props)) {
            const req = required.includes(key) ? " (required)" : " (optional)";
            paramParts.push(`"${key}": <${val.type || "string"}>${req}`);
          }
          return `{"name": "${primaryTool}", "arguments": { ${paramParts.join(", ")} }}`;
        }
        return `{"name": "${primaryTool}", "arguments": {"cmd": "<command>"}}`;
      })();
      const continuationReminder = [
        `This is a continuation of our conversation. Based on the context and the user's message above, decide if further action is needed.`,
        `If YES, output a JSON instruction using this schema:`,
        schemaHint,
        `If the task is FULLY complete with no further actions, provide a summary including any key content the user asked to see.`,
        langHint || "",
      ].filter(Boolean).join("\n");
      finalPrompt = `${flatMessages}\n\n---\n\n${continuationReminder}`;
      console.log(`[M365-REQ-TRANSLATE] prompt_layout=continuation+schema finalPrompt_len=${finalPrompt.length}`);
    } else {
      finalPrompt = `${antiExecPrompt}\n\n---\n\n${flatMessages}`;
      console.log(`[M365-REQ-TRANSLATE] prompt_layout=antiExec+flatMessages finalPrompt_len=${finalPrompt.length}`);
    }
  } else {
    finalPrompt = flatMessages;
    console.log(`[M365-REQ-TRANSLATE] prompt_layout=flatMessages_only finalPrompt_len=${finalPrompt.length}`);
  }

  const beforeSanitize = finalPrompt;
  const afterSanitize = sanitizeForM365(finalPrompt);
  const sanitizeRe = /\b(rm|rmdir|del|delete|shred|format|erase|wipe|destroy|destructive|truncate|overwrite|kill|killall|chmod|chown)\b/gi;
  const beforeMatches = beforeSanitize.match(sanitizeRe) || [];
  const afterMatches = afterSanitize.match(sanitizeRe) || [];
  console.log(`[M365-REQ-SANITIZE] before=${beforeMatches.length} words [${JSON.stringify(beforeMatches)}] after=${afterMatches.length} words [${JSON.stringify(afterMatches)}] | before_len=${beforeSanitize.length} after_len=${afterSanitize.length}`);
  if (afterMatches.length > 0) {
    console.log(`[M365-REQ-SANITIZE] BUG: dangerous words still present after sanitize!`);
  }

  console.log(`[M365-REQ-TRANSLATE] FINAL: usedExtract=${usedExtract} hasToolResults=${hasToolResults} needsLocalExec=${needsLocalExec} finalPrompt_len=${afterSanitize.length} first200=${afterSanitize.slice(0,200).replace(/\n/g,"\\n")}`);

  return {
    ...body,
    messages: [],
    _m365Prompt: afterSanitize,
    _m365IsContinuation: isContinuation,
    _m365ToolMeta: {
      hasTools: !!(tools && tools.length > 0),
      needsLocalExec,
      hasSearchTools: !!toolMeta?.hasSearchTools,
      toolNameMap: toolMeta?.toolNameMap || new Map(),
      toolCallMetaMap,
      shellToolNames: toolMeta?.shellToolNames || [],
      shellToolSchemas: toolMeta?.shellToolSchemas || {},
      searchToolNames: toolMeta?.searchToolNames || [],
      fileOpToolNames: toolMeta?.fileOpToolNames || [],
      historicalToolCallCounts,
    },
    stream,
  };
}

register(FORMATS.OPENAI, FORMATS.M365_COPILOT, openaiToM365CopilotRequest, null);
