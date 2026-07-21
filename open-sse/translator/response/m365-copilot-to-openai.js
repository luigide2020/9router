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
  /\/mnt\/(file_upload|data|home|tmp|usr|var|workspace|sandbox)/,
  /\/mnt\/[a-z_]+\s+is\s+(empty|not found)/,
  /\n\s*count:\s*\d+\s*\n/,
  /file_upload.*\n.*count:/,
];
const JSON_TOOL_RE = /```json-tool\s*\n([\s\S]*?)```/g;
const INLINE_JSON_TOOL_RE = /\{[\s\n]*"name"\s*:\s*"[^"]+"[\s\n]*,\s*[\s\n]*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/g;
const NAKED_CMD_JSON_RE = /\{\s*"(cmd|command|code|run)"\s*:\s*"([^"]+)"\s*\}/g;

const COMMON_COMMANDS_RE = /\b(ls|pwd|cat|find|grep|head|tail|wc|echo|mkdir|rm|cp|mv|chmod|curl|wget|git|npm|node|python|pip|docker|make|gcc|javac|java)\b/;

const COMMAND_INTENT_RE = /\b(run|execute|try|type|enter|issue|invoke)\s+(this\s+)?(command|the\s+following|it|now)|^CMD:/im;

const DESTRUCTIVE_COMMAND_PATTERNS = [
  /^\s*rm\s+(-[rRfF]+\s+|--recursive|--force)\s*\S/im,
  /^\s*rm\s+\S.*\S\s*$/im,
  /^\s*rmdir\b/im,
  /^\s*del\b\s+/im,
  /^\s*shred\b/im,
  /^\s*format\s+\/dev\//im,
  /^\s*erase\b/im,
  /^\s*truncate\s+-s/im,
  /^\s*chmod\s+(0+[0-7]*|000|777)\b/im,
  /^\s*kill\s+(-9\s+)?\d+/im,
  /^\s*killall\b/im,
  /^\s*dd\s+if=.*of=\/dev\//im,
  /^\s*mv\s+.*\s+\/dev\/null/im,
  /^\s*.{0,20}>\s*\/dev\/(sd[a-z]|hd[a-z]|nvme|loop|ram|md|dm-|sdx)/im,
];

function isDestructiveCommand(cmd) {
  const c = cmd.trim();
  if (!c) return false;
  const lines = c.split(/\n/);
  const commandLines = lines.filter(line => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith("#");
  });
  return commandLines.some(line => DESTRUCTIVE_COMMAND_PATTERNS.some(p => p.test(line)));
}

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
  console.log(`[M365-RESP-EXTRACT] textLen=${text.length} hasToolMeta=${!!toolMeta} shellTools=${JSON.stringify(toolMeta?.shellToolNames||[])} preview=${text.slice(0, 150).replace(/\n/g, "\\n")}`);

  JSON_TOOL_RE.lastIndex = 0;
  let match;
  while ((match = JSON_TOOL_RE.exec(text)) !== null) {
    const raw = match[1].trim();
    if (seenTexts.has(raw)) continue;
    seenTexts.add(raw);
    console.log(`[M365-RESP-EXTRACT] rule=JSON_TOOL_RE match_len=${raw.length} preview=${raw.slice(0,100).replace(/\n/g,"\\n")}`);
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.name) {
        const args = parsed.arguments || parsed.input || {};
        console.log(`[M365-RESP-EXTRACT] rule=JSON_TOOL_RE → toolCall name=${parsed.name} args_keys=${Object.keys(args).join(",")}`);
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
        console.log(`[M365-RESP-EXTRACT] rule=JSON_TOOL_RE(fallback) → toolCall name=${nameMatch[1]}`);
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
    console.log(`[M365-RESP-EXTRACT] rule=JSON_BLOCK_RE match_len=${raw.length} preview=${raw.slice(0,100).replace(/\n/g,"\\n")}`);
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.name) {
        const args = parsed.arguments || parsed.input || {};
        console.log(`[M365-RESP-EXTRACT] rule=JSON_BLOCK_RE → toolCall name=${parsed.name}`);
        calls.push(makeToolCall(parsed.name, args));
      }
    } catch { /* skip */ }
  }

  INLINE_JSON_TOOL_RE.lastIndex = 0;
  while ((match = INLINE_JSON_TOOL_RE.exec(text)) !== null) {
    const raw = match[0];
    if (seenTexts.has(raw)) continue;
    seenTexts.add(raw);
    console.log(`[M365-RESP-EXTRACT] rule=INLINE_JSON_TOOL_RE match_len=${raw.length} preview=${raw.slice(0,100).replace(/\n/g,"\\n")}`);
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.name) {
        const args = parsed.arguments || parsed.input || {};
        console.log(`[M365-RESP-EXTRACT] rule=INLINE_JSON_TOOL_RE → toolCall name=${parsed.name}`);
        calls.push(makeToolCall(parsed.name, args));
      }
    } catch {
      const nameMatch = raw.match(/"name"\s*:\s*"([^"]+)"/);
      if (nameMatch) {
        const argMatch = raw.match(/"arguments"\s*:\s*(\{[\s\S]*)/);
        let args = "{}";
        if (argMatch) {
          let argStr = argMatch[1].replace(/\}\s*$/, "");
          try { const p = JSON.parse(argStr); args = argStr; } catch { args = argStr; }
        }
        console.log(`[M365-RESP-EXTRACT] rule=INLINE_JSON_TOOL_RE(fallback) → toolCall name=${nameMatch[1]}`);
        calls.push(makeToolCall(nameMatch[1], args));
      }
    }
  }

  if (calls.length === 0) {
    const truncMatch = text.match(/\{[\s\n]*"name"\s*:\s*"([^"]+)"[\s\n]*,\s*[\s\n]*"arguments"\s*:\s*\{([\s\S]*)/);
    if (truncMatch) {
      const tName = truncMatch[1];
      const rawArgs = truncMatch[2];
      console.log(`[M365-RESP-EXTRACT] rule=TRUNCATED_JSON_TOOL name=${tName} argsLen=${rawArgs.length} preview=${rawArgs.slice(0,80).replace(/\n/g,"\\n")}`);
      const cmdMatch2 = rawArgs.match(/"cmd"\s*:\s*"([\s\S]*)/);
      const commandMatch = rawArgs.match(/"command"\s*:\s*"([\s\S]*)/);
      if (cmdMatch2 || commandMatch) {
        const cmdKey = cmdMatch2 ? "cmd" : "command";
        let cmdVal = (cmdMatch2 || commandMatch)[1];
        cmdVal = cmdVal.replace(/"\s*,?\s*$/, "").replace(/\}\s*$/, "");
        const toolName = extractShellToolName(toolMeta);
        const argName = getShellToolCommandArgName(toolMeta);
        const finalName = tName || toolName;
        const finalArgName = cmdKey === "cmd" ? argName : cmdKey;
        console.log(`[M365-RESP-EXTRACT] rule=TRUNCATED_JSON_TOOL → toolCall name=${finalName} ${finalArgName}_len=${cmdVal.length}`);
        calls.push(makeToolCall(finalName, { [finalArgName]: cmdVal }));
      } else {
        let tArgs = rawArgs.replace(/\}\s*$/, "");
        try {
          const parsed = JSON.parse(`{${tArgs}}`);
          calls.push(makeToolCall(tName, parsed));
        } catch {
          calls.push(makeToolCall(tName, tArgs));
        }
      }
    }
  }

  const cmdMatch = text.match(CMD_PREFIX_RE);
  if (cmdMatch) {
    const command = cmdMatch[1].trim();
    const toolName = extractShellToolName(toolMeta);
    const argName = getShellToolCommandArgName(toolMeta);
    console.log(`[M365-RESP-EXTRACT] rule=CMD_PREFIX_RE command="${command}" toolName=${toolName} argName=${argName}`);
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
      console.log(`[M365-RESP-EXTRACT] rule=NAKED_CMD_JSON_RE argKey="${argKey}" command="${command}" toolName=${toolName}`);
      calls.push(makeToolCall(toolName, { [argName]: command }));
      break;
    }
  }

  if (calls.length === 0) {
    const isRemote = isRemoteExecutionResult(text);
    console.log(`[M365-RESP-EXTRACT] rule=REMOTE_EXEC_CHECK isRemote=${isRemote}`);
    if (isRemote) {
      const toolName = extractShellToolName(toolMeta);
      const argName = getShellToolCommandArgName(toolMeta);
      const backtickContent = text.match(/```(?:text|bash|shell)?\s*\n([\s\S]*?)```/);
      let command = "ls";
      if (backtickContent) {
        const firstLine = backtickContent[1].trim().split("\n")[0];
        if (!/^\/mnt\//.test(firstLine) && COMMON_COMMANDS_RE.test(firstLine)) {
          command = firstLine;
        }
      }
      console.log(`[M365-RESP-EXTRACT] rule=REMOTE_EXEC → toolCall name=${toolName} command="${command}"`);
      calls.push(makeToolCall(toolName, { [argName]: command }));
    }
  }

  if (calls.length === 0) {
    const inlineCmd = text.match(/`([^`]+)`/);
    const inlineResult = inlineCmd ? `match="${inlineCmd[1]}", isCommonCmd=${COMMON_COMMANDS_RE.test(inlineCmd[1])}` : "no_match";
    console.log(`[M365-RESP-EXTRACT] rule=INLINE_BACKTICK ${inlineResult}`);
    if (inlineCmd && COMMON_COMMANDS_RE.test(inlineCmd[1])) {
      const beforeCmd = text.slice(0, text.indexOf(inlineCmd[0]));
      const hasIntent = COMMAND_INTENT_RE.test(beforeCmd);
      console.log(`[M365-RESP-EXTRACT] rule=INLINE_BACKTICK hasIntent=${hasIntent} beforeCmd_preview=${beforeCmd.slice(-80).replace(/\n/g,"\\n")}`);
      if (hasIntent) {
        const toolName = extractShellToolName(toolMeta);
        const argName = getShellToolCommandArgName(toolMeta);
        calls.push(makeToolCall(toolName, { [argName]: inlineCmd[1].trim() }));
      }
    }
  }

  console.log(`[M365-RESP-EXTRACT] total_calls=${calls.length} names=[${calls.map(tc => tc.function.name).join(",")}]`);
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

function buildToolCallResults(toolCalls, textBuffer, chunk, hasToolMeta, choice, isRemote = false) {
  const results = [];

  if (toolCalls.length > 0) {
    const cleanContent = stripToolPatternsFromText(textBuffer);
    if (cleanContent && !isRemote) {
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

  if (textBuffer) {
    results.push({
      id: chunk.id,
      object: "chat.completion.chunk",
      created: chunk.created,
      model: chunk.model,
      system_fingerprint: null,
      choices: [{ index: 0, delta: { content: textBuffer }, finish_reason: null, logprobs: null }],
    });
  }
  results.push(chunk);
  return results;
}

function m365CopilotToOpenAIResponse(chunk, state) {
  if (!chunk || !chunk.choices || !chunk.choices[0]) return [chunk];

  const choice = chunk.choices[0];
  const delta = choice.delta;
  const hasToolMeta = !!state._m365ToolMeta?.needsLocalExec;

  if (!state._m365Init) {
    state._m365Init = true;
    state._m365TextBuffer = "";
    console.log(`[M365-RESP-TRANSLATE] init hasToolMeta=${hasToolMeta} model=${state.model || "unknown"}`);
  }

  if (hasToolMeta && delta?.content) {
    state._m365TextBuffer += delta.content;
    if (delta.content.length > 100 || state._m365TextBuffer.length % 5000 < delta.content.length) {
      console.log(`[M365-RESP-TRANSLATE] buffering: delta=${delta.content.length}, total=${state._m365TextBuffer.length} preview=${delta.content.slice(0,80).replace(/\n/g,"\\n")}`);
    }
    return [];
  }

  if (hasToolMeta && (choice.finish_reason === "stop" || choice.finish_reason === OPENAI_FINISH.STOP)) {
    console.log(`[M365-RESP-TRANSLATE] finish_reason=stop, bufferLen=${state._m365TextBuffer.length}, hasToolMeta=${hasToolMeta}`);
    const isRemoteCheck = isRemoteExecutionResult(state._m365TextBuffer);
    console.log(`[M365-RESP-TRANSLATE] isRemote=${isRemoteCheck} bufferPreview=${state._m365TextBuffer.slice(0, 200).replace(/\n/g,"\\n")}`);
    const toolCalls = extractToolCallsFromText(state._m365TextBuffer, state._m365ToolMeta);
    console.log(`[M365-RESP-TRANSLATE] extracted toolCalls=${toolCalls.length}, names=[${toolCalls.map(tc => tc.function.name).join(",")}]`);
    const isRemote = isRemoteExecutionResult(state._m365TextBuffer);
    const isGpt56 = state.model && (state.model === "gpt-5.6" || state.model.toLowerCase().includes("gpt-5.6"));

    if (isGpt56 && toolCalls.length > 0) {
      console.log(`[M365-RESP-TRANSLATE] gpt-5.6 destructive guardrail active`);
      const safeCalls = toolCalls.filter(tc => {
        try {
          const args = typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function.arguments;
          const cmd = args?.cmd || args?.command || args?.code || args?.run || JSON.stringify(args);
          const isDestructive = isDestructiveCommand(cmd);
          console.log(`[M365-RESP-TRANSLATE] destructive-check cmd="${cmd.slice(0,80)}" isDestructive=${isDestructive}`);
          if (isDestructive) return false;
        } catch { /* passthrough */ }
        return true;
      });

      const blockedCount = toolCalls.length - safeCalls.length;
      if (blockedCount > 0) {
        const blockedNames = toolCalls.filter(tc => !safeCalls.includes(tc)).map(tc => {
          try { const a = JSON.parse(tc.function.arguments); return `${tc.function.name}(${a?.cmd || a?.command || "?"})`; } catch { return tc.function.name; }
        });
        console.log(`[M365-RESP-TRANSLATE] BLOCKED ${blockedCount} destructive call(s): ${JSON.stringify(blockedNames)}`);
        const blockedMsg = `[SAFETY: ${blockedCount} potentially harmful command(s) blocked by guardrail.]`;
        state._m365TextBuffer = state._m365TextBuffer
          ? `${state._m365TextBuffer}\n\n${blockedMsg}`
          : blockedMsg;
      } else {
        console.log(`[M365-RESP-TRANSLATE] all calls passed destructive guardrail`);
      }

      return buildToolCallResults(safeCalls, state._m365TextBuffer, chunk, hasToolMeta, choice, isRemote);
    }

    return buildToolCallResults(toolCalls, state._m365TextBuffer, chunk, hasToolMeta, choice, isRemote);
  }

  return [chunk];
}

register(FORMATS.M365_COPILOT, FORMATS.OPENAI, null, m365CopilotToOpenAIResponse);
