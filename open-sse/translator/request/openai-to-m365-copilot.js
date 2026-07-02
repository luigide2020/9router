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
  "local_shell", "run_command", "execute_command",
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
    return `[${label} (${tcName})]:\n${resultStr}`;
  }
  return `[Command output (${tcName})]:\n${resultStr}`;
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

function buildAntiExecutionPrompt(shellToolNames, shellToolSchemas, hasSearchTools) {
  if (!shellToolNames || shellToolNames.length === 0) return "";

  const primaryTool = shellToolNames[0];
  const schema = shellToolSchemas?.[primaryTool];

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
      "IMPORTANT: Do NOT execute any shell commands or code. Do NOT use your code interpreter or sandbox.",
      "Do NOT use web search or browse the internet — the user has local search tools for that.",
      "For ANY user request (checking config, reading files, searching, listing, etc.), output a JSON instruction and I will run it locally:",
      schemaInstr,
      "Do NOT run any command yourself. Just output the JSON and stop.",
    ].join(" ");
  }

  return [
    "IMPORTANT: Do NOT execute any commands or code. Do NOT use your code interpreter or sandbox.",
    "You must NOT run commands yourself. Instead, output a JSON instruction and I will run it for you.",
    schemaInstr,
    "Do NOT run the command yourself. Just output the JSON and stop.",
  ].join(" ");
}

function buildToolResultPrompt(toolCallId, toolName, result) {
  const resultStr = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return [
    `[TOOL RESULT (executed locally)]:`,
    `Tool: ${toolName}`,
    `Call ID: ${toolCallId}`,
    resultStr,
  ].join("\n");
}

function flattenMessages(messages, toolCallMetaMap) {
  const parts = [];

  for (const msg of messages) {
    const role = msg.role || "";

    if (role === ROLE.SYSTEM || role === ROLE.DEVELOPER) {
      const text = extractContent(msg.content);
      if (text) parts.push(`[System]: ${text}`);
      continue;
    }

    if (role === ROLE.USER) {
      const text = extractContent(msg.content);
      if (text) parts.push(`[User]: ${text}`);
      continue;
    }

    if (role === ROLE.ASSISTANT) {
      const text = extractContent(msg.content);
      const toolParts = [];

      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const tcName = tc.function?.name || "unknown";
          const tcArgs = tc.function?.arguments || "{}";
          const tcId = tc.id || "";
          toolCallMetaMap.set(tcId, tcName);
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

      if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
      continue;
    }

    if (role === ROLE.TOOL) {
      const tcId = msg.tool_call_id || "";
      const tcName = toolCallMetaMap.get(tcId) || "unknown";
      const result = extractContent(msg.content) || msg.content || "";
      const resultStr = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      parts.push(formatToolResult(tcName, resultStr));
      continue;
    }
  }

  return parts.join("\n\n");
}

function extractLatestUserInput(messages, toolCallMetaMap) {
  if (!messages || messages.length === 0) return null;

  const lastMsg = messages[messages.length - 1];
  const lastRole = lastMsg.role || "";

  if (lastRole === ROLE.USER) {
    const text = extractContent(lastMsg.content);
    if (text) return `[User]: ${text}`;
    return null;
  }

  if (lastRole === ROLE.TOOL) {
    const resultParts = [];
    let i = messages.length - 1;

    while (i >= 0 && messages[i].role === ROLE.TOOL) {
      const tcId = messages[i].tool_call_id || "";
      const tcName = toolCallMetaMap.get(tcId) || "unknown";
      const result = extractContent(messages[i].content) || messages[i].content || "";
      const resultStr = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      resultParts.unshift(formatToolResult(tcName, resultStr));
      i--;
    }

    while (i >= 0 && messages[i].role === ROLE.ASSISTANT) {
      if (messages[i].tool_calls) {
        for (const tc of messages[i].tool_calls) {
          const tcName = tc.function?.name || "unknown";
          const tcArgs = tc.function?.arguments || "{}";
          const tcId = tc.id || "";
          toolCallMetaMap.set(tcId, tcName);
        }
      }
      i--;
    }

    let originalRequest = "";
    if (i >= 0 && messages[i].role === ROLE.USER) {
      originalRequest = extractContent(messages[i].content) || "";
    }

    const combinedResults = resultParts.join("\n");
    return [
      `[User]: I ran the command you suggested. Here is the output:`,
      combinedResults,
      `Based on the command output above, please provide your analysis or next steps. Do NOT suggest running the same command again.`,
    ].join("\n\n");
  }

  return null;
}

function openaiToM365CopilotRequest(model, body, stream, credentials) {
  const tools = body.tools;
  const messages = body.messages || [];

  const toolCallMetaMap = new Map();
  const toolMeta = buildToolMeta(tools);

  const hasToolResults = messages.some(m => m.role === ROLE.TOOL);

  let flatMessages;
  if (hasToolResults) {
    flatMessages = extractLatestUserInput(messages, toolCallMetaMap) || flattenMessages(messages, toolCallMetaMap);
  } else {
    flatMessages = flattenMessages(messages, toolCallMetaMap);
  }

  const needsLocalExec = !!toolMeta?.needsLocalExec;
  let finalPrompt;
  if (!hasToolResults && needsLocalExec) {
    const antiExecPrompt = buildAntiExecutionPrompt(
      toolMeta.shellToolNames,
      toolMeta.shellToolSchemas,
      toolMeta.hasSearchTools,
    );
    finalPrompt = `${antiExecPrompt}\n\n---\n\n${flatMessages}`;
  } else {
    finalPrompt = flatMessages;
  }

  return {
    ...body,
    messages: [],
    _m365Prompt: finalPrompt,
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
