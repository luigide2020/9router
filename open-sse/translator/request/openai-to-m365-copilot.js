/**
 * OpenAI → M365 Copilot Request Translator
 *
 * M365 Copilot's WebSocket protocol does NOT support native tool calling.
 * Worse, M365 has a server-side Code Interpreter that automatically executes
 * commands in a remote sandbox when it detects tool-like requests — and there
 * is NO client-side flag to fully disable this behavior.
 *
 * Strategy (dual approach):
 *
 *   A) PROACTIVE: Rephrase the user's message to avoid triggering M365's
 *      Code Interpreter. Instead of passing tool schemas (which M365 sees as
 *      "the user wants me to execute code"), we use a lightweight natural
 *      language instruction that tells M365 to ONLY output the command it
 *      would run, without actually running it.
 *
 *   B) REACTIVE: In the response translator, detect M365's remote execution
 *      results (paths like /mnt/*, format like "cwd: /mnt/...") and convert
 *      them into OpenAI tool_calls so the local agent (codex) can handle them.
 *
 * The translator:
 *   1. Extracts tool names from `tools[]` for response mapping
 *   2. Flattens OpenAI messages[] into a single user prompt
 *   3. Injects a concise instruction to prevent remote execution
 *   4. Stashes tool metadata on `body._m365ToolMeta` for the response translator
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { ROLE } from "../schema/index.js";

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

function buildToolMeta(tools) {
  if (!tools || tools.length === 0) return null;

  const toolNameMap = new Map();
  const shellToolNames = [];
  const shellToolSchemas = {};

  for (const tool of tools) {
    const func = tool.function;
    if (!func) continue;
    const name = func.name || "unknown";
    toolNameMap.set(name, { name });

    const desc = (func.description || "").toLowerCase();
    const isShellTool = desc.includes("shell") || desc.includes("command") || desc.includes("bash") ||
        desc.includes("exec") || desc.includes("terminal") || desc.includes("run") ||
        name.includes("shell") || name.includes("bash") || name.includes("exec") ||
        name === "local_shell" || name === "run_command" || name === "execute_command" ||
        name === "Bash" || name === "bash" ||
        name === "execute_bash" || name === "run_bash" || name === "shell_exec" ||
        name === "computer_terminal" || name === "terminal";
    if (isShellTool) {
      shellToolNames.push(name);
      shellToolSchemas[name] = func.parameters || null;
    }
  }

  return { toolNameMap, shellToolNames, shellToolSchemas };
}

function buildAntiExecutionPrompt(shellToolNames, shellToolSchemas) {
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
      parts.push(`[Command output]: ${resultStr}`);
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
      resultParts.unshift(resultStr);
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

  let finalPrompt;
  if (!hasToolResults && toolMeta && toolMeta.shellToolNames.length > 0) {
    const antiExecPrompt = buildAntiExecutionPrompt(toolMeta.shellToolNames, toolMeta.shellToolSchemas);
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
      toolNameMap: toolMeta?.toolNameMap || new Map(),
      toolCallMetaMap,
      shellToolNames: toolMeta?.shellToolNames || [],
      shellToolSchemas: toolMeta?.shellToolSchemas || {},
    },
    stream,
  };
}

register(FORMATS.OPENAI, FORMATS.M365_COPILOT, openaiToM365CopilotRequest, null);
