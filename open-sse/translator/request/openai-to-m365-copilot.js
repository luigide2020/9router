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

  if (hasSearchTools) {
    return [
      destructiveBlock,
      "You are assisting a user who has a command-line interface. For any action the user requests (checking, searching, reading, listing, etc.), always output a JSON instruction using this schema, and the user will handle the execution:",
      schemaInstr,
      langHint,
      "Use plain text only for explanations or summaries when no action is needed.",
    ].filter(Boolean).join(" ");
  }

  return [
    destructiveBlock,
    "You are assisting a user who has a command-line interface. For any action the user requests, always output a JSON instruction using this schema, and the user will handle the execution:",
    schemaInstr,
    langHint,
    "Use plain text only for explanations or summaries when no action is needed.",
  ].filter(Boolean).join(" ");
}

const M365_MAX_TOOL_RESULT_LEN = 8000;
const M365_MAX_FILE_CONTENT_LEN = 4000;

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
      const truncated = kind === "fileOp" ? truncateFileContent(resultStr) : truncateToolResult(resultStr);
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
  const fileRe = /['"]?((?:\.?\/)?(?:src|lib|test|pkg|cmd|internal|app|config|public|scripts|docs|build|dist)\S*\.(?:java|py|js|ts|jsx|tsx|go|rs|rb|php|c|cpp|h|cs|swift|kt|scala|sh|yaml|yml|json|toml|xml|html|css|md|txt|properties|conf|cfg|ini|env|sql))['"]?/gi;
  let m;
  while ((m = fileRe.exec(cmd)) !== null) {
    paths.push(m[1].replace(/['"]/g, ""));
  }
  const sedCatRe = /(?:sed|cat|head|tail|less|more)\s+(?:-[a-zA-Z]+\s+)*['"]?((?:\.?\/)?\S+\.\w+)['"]?/gi;
  while ((m = sedCatRe.exec(cmd)) !== null) {
    const p = m[1].replace(/['"]/g, "").replace(/\|.*$/, "").trim();
    if (p && !paths.includes(p) && /\.\w{1,10}$/.test(p)) paths.push(p);
  }
  const grepRe = /(?:grep|rg|ag|ack)\s+.*?\s+['"]?((?:\.?\/)?\S+)['"]?/gi;
  while ((m = grepRe.exec(cmd)) !== null) {
    const p = m[1].replace(/['"]/g, "").replace(/\|.*$/, "").trim();
    if (p && /\.\w{1,10}$/.test(p) && !paths.includes(p)) paths.push(p);
  }
  return paths;
}

function buildEarlierContext(messages, stopIndex, toolCallMetaMap) {
  if (stopIndex <= 0) return "";
  const prevCmds = [];
  const filesInContext = new Set();
  for (let k = 0; k < stopIndex; k++) {
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
  if (lastCmd) parts.push(`Previous command: ${lastCmd}`);
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
  return parts.length > 0 ? `[Context]: ${parts.join(". ")}` : "";
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
    const hasEarlierToolResults = messages.slice(0, -1).some(m => m.role === ROLE.TOOL);
    if (hasEarlierToolResults) {
      const earlierContext = buildEarlierContext(messages, messages.length - 1, toolCallMetaMap);
      const result = [earlierContext, `[User]: ${text}`, langHint || ""].filter(Boolean).join("\n\n");
      console.log(`[M365-REQ-EXTRACT] USER with earlier context: earlierCtx=${!!earlierContext} result_len=${result.length}`);
      return result;
    }
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
    while (i >= 0 && messages[i].role === ROLE.TOOL) {
      const tcId = messages[i].tool_call_id || "";
      const tcName = toolCallMetaMap.get(tcId) || "unknown";
      const result = extractContent(messages[i].content) || messages[i].content || "";
      const resultStr = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      const kind = classifyToolName(tcName);
      const truncated = kind === "fileOp" ? truncateFileContent(resultStr) : truncateToolResult(resultStr);
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
    const earlierContext = buildEarlierContext(messages, i, toolCallMetaMap);

    console.log(`[M365-REQ-EXTRACT] tool_result_count=${toolResultCount} earlierContext=${earlierContext?"yes":"no"} combinedResultsLen=${combinedResults.length}`);

    const noReReadHint = earlierContext.includes("Files already read")
      ? "Do NOT re-read files listed as 'already read' above — their content is already available. Use a different command or proceed to the next step."
      : "";
    const result = [
      earlierContext,
      `[User]: Here is the result of the previous step:`,
      combinedResults,
      `Analyze the output above. If the user asked to see file content, include the relevant content in your response. If another step is needed, output a JSON instruction using this schema:`,
      schemaHint,
      noReReadHint,
      `If the task is fully complete, provide a brief summary including any key content the user asked to see. Otherwise, continue with the next JSON instruction.`,
      langHint || "",
    ].filter(Boolean).join("\n\n");

    console.log(`[M365-REQ-EXTRACT] final_extracted_len=${result.length}`);
    return result;
  }

  console.log(`[M365-REQ-EXTRACT] lastMsg role=${lastRole} → returning null (no match)`);
  return null;
}

function openaiToM365CopilotRequest(model, body, stream, credentials) {
  const tools = body.tools;
  const messages = body.messages || [];

  const toolCallMetaMap = new Map();
  const toolMeta = buildToolMeta(tools);

  const lastMsgRole = messages.length > 0 ? messages[messages.length - 1].role : "";
  const hasToolResults = lastMsgRole === ROLE.TOOL;
  const hasEarlierToolResults = messages.slice(0, -1).some(m => m.role === ROLE.TOOL);

  console.log(`[M365-REQ-TRANSLATE] model=${model} messages=${messages.length} tools=${tools?.length||0} hasToolResults=${hasToolResults} hasEarlierToolResults=${hasEarlierToolResults} needsLocalExec=${!!toolMeta?.needsLocalExec} shellTools=${JSON.stringify(toolMeta?.shellToolNames||[])} searchTools=${JSON.stringify(toolMeta?.searchToolNames||[])} fileOpTools=${JSON.stringify(toolMeta?.fileOpToolNames||[])}`);

  let flatMessages;
  let usedExtract = false;
  if (hasToolResults || hasEarlierToolResults) {
    flatMessages = extractLatestUserInput(messages, toolCallMetaMap, toolMeta);
    if (flatMessages) {
      usedExtract = true;
      console.log(`[M365-REQ-TRANSLATE] strategy=extractLatestUserInput result_len=${flatMessages.length}`);
    } else {
      flatMessages = flattenMessages(messages, toolCallMetaMap);
      console.log(`[M365-REQ-TRANSLATE] strategy=flattenMessages(fallback) result_len=${flatMessages.length}`);
    }
  } else {
    flatMessages = flattenMessages(messages, toolCallMetaMap);
    console.log(`[M365-REQ-TRANSLATE] strategy=flattenMessages(no_tool_results) result_len=${flatMessages.length}`);
  }

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
        `If another step is needed, output a JSON instruction using this schema — the user will handle execution:`,
        antiExecPrompt,
        langFooter,
      ].filter(Boolean).join("\n");
      finalPrompt = `${flatMessages}\n\n---\n\n${reminder}`;
      console.log(`[M365-REQ-TRANSLATE] prompt_layout=flatMessages+reminder finalPrompt_len=${finalPrompt.length}`);
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
    },
    stream,
  };
}

register(FORMATS.OPENAI, FORMATS.M365_COPILOT, openaiToM365CopilotRequest, null);
