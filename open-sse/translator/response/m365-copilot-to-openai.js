/**
 * M365 Copilot → OpenAI Response Translator
 *
 * M365 Copilot has a server-side Code Interpreter that may execute commands
 * in a remote sandbox even when we ask it not to. This translator handles
 * two scenarios:
 *
 *   1. PROACTIVE (M365 obeyed our CMD: instruction): M365 outputs "CMD: <command>"
 *      — we convert this to an OpenAI tool_call for local execution
 *
 *   2. REACTIVE (M365 executed in remote sandbox): M365 returns output from
 *      its /mnt/* sandbox with format like "cwd: /mnt/file_upload\ncount: 0"
 *      — we detect this pattern and convert to a tool_call, so the local
 *        agent gets a chance to re-execute locally
 *
 *   3. NORMAL: No tool patterns found — pass through content as-is
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { OPENAI_FINISH } from "../schema/index.js";
import { randomUUID } from "crypto";

const CMD_PREFIX_RE = /^CMD:\s*(.+)$/m;
const JSON_BLOCK_RE = /```(?:json|tool)?\s*\n([\s\S]*?)```/g;
const REMOTE_EXEC_INDICATORS = [
  /cwd:\s*\/mnt\//,
  /\/mnt\/file_upload/,
  /\/mnt\/[a-z_]+\s+is\s+(empty|not found)/,
  /\n\s*count:\s*\d+\s*\n/,
  /file_upload.*\n.*count:/,
];
const JSON_TOOL_RE = /```json-tool\s*\n([\s\S]*?)```/g;
const INLINE_JSON_TOOL_RE = /\{[\s\n]*"name"\s*:\s*"[^"]+"[\s\n]*,\s*[\s\n]*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/g;
const NAKED_CMD_JSON_RE = /\{\s*"(cmd|command|code|run)"\s*:\s*"([^"]+)"\s*\}/g;

const COMMON_COMMANDS_RE = /\b(ls|pwd|cat|find|grep|head|tail|wc|echo|mkdir|rm|cp|mv|chmod|curl|wget|git|npm|node|python|pip|docker|make|gcc|javac|java)\b/;

function isRemoteExecutionResult(text) {
  return REMOTE_EXEC_INDICATORS.some(re => re.test(text));
}

function extractShellToolName(toolMeta) {
  const names = toolMeta?.shellToolNames || [];
  if (names.length > 0) return names[0];
  const map = toolMeta?.toolNameMap;
  if (map) {
    for (const [name] of map) {
      if (name.includes("shell") || name.includes("bash") || name.includes("exec") ||
          name === "local_shell" || name === "run_command" || name === "execute_command" ||
          name === "Bash" || name === "execute_bash" || name === "terminal") {
        return name;
      }
    }
  }
  return "local_shell";
}

function getShellToolCommandArgName(toolMeta) {
  const name = extractShellToolName(toolMeta);
  const schema = toolMeta?.shellToolSchemas?.[name];
  if (schema && schema.properties) {
    const keys = Object.keys(schema.properties);
    if (keys.length > 0) return keys[0];
  }
  return "command";
}

function makeToolCall(name, argumentsObj) {
  const callId = `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  return {
    id: callId,
    type: "function",
    function: {
      name: String(name),
      arguments: typeof argumentsObj === "string" ? argumentsObj : JSON.stringify(argumentsObj),
    },
  };
}

function extractToolCallsFromText(text, toolMeta) {
  const calls = [];
  const seenTexts = new Set();

  JSON_TOOL_RE.lastIndex = 0;
  let match;
  while ((match = JSON_TOOL_RE.exec(text)) !== null) {
    const raw = match[1].trim();
    if (seenTexts.has(raw)) continue;
    seenTexts.add(raw);
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.name) {
        const args = parsed.arguments || parsed.input || {};
        calls.push(makeToolCall(parsed.name, args));
      }
    } catch {
      const nameMatch = raw.match(/"name"\s*:\s*"([^"]+)"/);
      if (nameMatch) {
        const argMatch = raw.match(/"arguments"\s*:\s*(\{[\s\S]*\})/);
        let args = "{}";
        if (argMatch) {
          try { JSON.parse(argMatch[1]); args = argMatch[1]; } catch { args = argMatch[1]; }
        }
        calls.push(makeToolCall(nameMatch[1], args));
      }
    }
  }

  JSON_BLOCK_RE.lastIndex = 0;
  while ((match = JSON_BLOCK_RE.exec(text)) !== null) {
    const raw = match[1].trim();
    if (seenTexts.has(raw)) continue;
    if (!raw.includes('"name"')) continue;
    seenTexts.add(raw);
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.name) {
        const args = parsed.arguments || parsed.input || {};
        calls.push(makeToolCall(parsed.name, args));
      }
    } catch { /* skip */ }
  }

  INLINE_JSON_TOOL_RE.lastIndex = 0;
  while ((match = INLINE_JSON_TOOL_RE.exec(text)) !== null) {
    const raw = match[0];
    if (seenTexts.has(raw)) continue;
    seenTexts.add(raw);
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.name) {
        const args = parsed.arguments || parsed.input || {};
        calls.push(makeToolCall(parsed.name, args));
      }
    } catch { /* skip */ }
  }

  const cmdMatch = text.match(CMD_PREFIX_RE);
  if (cmdMatch) {
    const command = cmdMatch[1].trim();
    const toolName = extractShellToolName(toolMeta);
    const argName = getShellToolCommandArgName(toolMeta);
    calls.push(makeToolCall(toolName, { [argName]: command }));
  }

  if (calls.length === 0) {
    NAKED_CMD_JSON_RE.lastIndex = 0;
    let nakedMatch;
    while ((nakedMatch = NAKED_CMD_JSON_RE.exec(text)) !== null) {
      const argKey = nakedMatch[1];
      const command = nakedMatch[2];
      const toolName = extractShellToolName(toolMeta);
      const argName = getShellToolCommandArgName(toolMeta);
      calls.push(makeToolCall(toolName, { [argName]: command }));
      break;
    }
  }

  if (calls.length === 0 && isRemoteExecutionResult(text)) {
    const toolName = extractShellToolName(toolMeta);
    const argName = getShellToolCommandArgName(toolMeta);
    const backtickContent = text.match(/```(?:text|bash|shell)?\s*\n([\s\S]*?)```/);
    const command = backtickContent ? backtickContent[1].trim().split("\n")[0] : "ls";
    calls.push(makeToolCall(toolName, { [argName]: command }));
  }

  if (calls.length === 0) {
    const inlineCmd = text.match(/`([^`]+)`/);
    if (inlineCmd && COMMON_COMMANDS_RE.test(inlineCmd[1])) {
      const toolName = extractShellToolName(toolMeta);
      const argName = getShellToolCommandArgName(toolMeta);
      calls.push(makeToolCall(toolName, { [argName]: inlineCmd[1].trim() }));
    }
  }

  return calls;
}

function stripToolPatternsFromText(text) {
  let cleaned = text.replace(JSON_TOOL_RE, "").trim();
  cleaned = cleaned.replace(JSON_BLOCK_RE, (full, inner) => {
    return inner.trim().startsWith('{"name"') ? "" : full;
  }).trim();
  cleaned = cleaned.replace(INLINE_JSON_TOOL_RE, "").trim();
  cleaned = cleaned.replace(NAKED_CMD_JSON_RE, "").trim();
  cleaned = cleaned.replace(CMD_PREFIX_RE, "").trim();
  if (isRemoteExecutionResult(cleaned)) {
    const backtickMatch = cleaned.match(/```(?:text|bash|shell)?\s*\n([\s\S]*?)```/);
    if (backtickMatch) {
      cleaned = cleaned.replace(backtickMatch[0], "").trim();
    }
    cleaned = cleaned.replace(/`[^`]*\/mnt[^`]*`(?:\s+is\s+(?:empty|not found)[.:])?/g, "").trim();
    cleaned = cleaned.replace(/cwd:\s*\/mnt[^\n]*/g, "").trim();
    cleaned = cleaned.replace(/count:\s*\d+/g, "").trim();
  }
  return cleaned;
}

function m365CopilotToOpenAIResponse(chunk, state) {
  if (!chunk || !chunk.choices || !chunk.choices[0]) return [chunk];

  const choice = chunk.choices[0];
  const delta = choice.delta;
  const hasToolMeta = !!state._m365ToolMeta?.needsLocalExec;

  if (!state._m365Init) {
    state._m365Init = true;
    state._m365TextBuffer = "";
  }

  if (hasToolMeta && delta?.content) {
    state._m365TextBuffer += delta.content;
    return [];
  }

  if (hasToolMeta && (choice.finish_reason === "stop" || choice.finish_reason === OPENAI_FINISH.STOP)) {
    const toolCalls = extractToolCallsFromText(state._m365TextBuffer, state._m365ToolMeta);
    const results = [];

    if (toolCalls.length > 0) {
      const cleanContent = stripToolPatternsFromText(state._m365TextBuffer);
      if (cleanContent) {
        results.push({
          id: chunk.id,
          object: "chat.completion.chunk",
          created: chunk.created,
          model: chunk.model,
          system_fingerprint: null,
          choices: [{ index: 0, delta: { content: cleanContent }, finish_reason: null, logprobs: null }],
        });
      }

      results.push({
        id: chunk.id,
        object: "chat.completion.chunk",
        created: chunk.created,
        model: chunk.model,
        system_fingerprint: null,
        choices: [{
          index: 0,
          delta: { role: "assistant", tool_calls: toolCalls.map((tc, idx) => ({ index: idx, id: tc.id, type: "function", function: tc.function })) },
          finish_reason: null,
          logprobs: null,
        }],
      });

      results.push({
        id: chunk.id,
        object: "chat.completion.chunk",
        created: chunk.created,
        model: chunk.model,
        system_fingerprint: null,
        choices: [{ index: 0, delta: {}, finish_reason: OPENAI_FINISH.TOOL_CALLS, logprobs: null }],
      });

      return results;
    }

    if (state._m365TextBuffer) {
      results.push({
        id: chunk.id,
        object: "chat.completion.chunk",
        created: chunk.created,
        model: chunk.model,
        system_fingerprint: null,
        choices: [{ index: 0, delta: { content: state._m365TextBuffer }, finish_reason: null, logprobs: null }],
      });
    }
    results.push(chunk);
    return results;
  }

  return [chunk];
}

register(FORMATS.M365_COPILOT, FORMATS.OPENAI, null, m365CopilotToOpenAIResponse);
