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

const COMMAND_INTENT_RE = /\b(run|execute|try|type|enter|issue|invoke|use)\s+(this\s+)?(command|the\s+following|it|now)|^CMD:|(?:我[要需来想先会]|让[我咱]|请)(?:来|去)?(?:看(?:一下)?|读(?:一下)?|查(?:一下)?|检查(?:一下)?|执行(?:一下)?|运行(?:一下)?|列出(?:一下)?|浏览(?:一下)?|跑(?:一下)?|看看|读读|查查)/im;

const ACTION_INTENT_PATTERNS = [
  /我[要需来想先将会能]*(?:看(?!到|了|过)|读|查|检查|执行|运行|列出|浏览|打开|查看|确认|验证)[一下]*\s*(?:一下\s*)?([^\s，。！？、\n]{2,80})/,
  /让我(?:看|读|查|检查|执行|运行|列出)\s*([^\s，。！？、\n]{2,80})/,
  /I'?(?:ll| will)\s+(?:read|check|run|execute|list|look at|examine|try|inspect|view|verify)\s+(.{2,80}?)(?:\.|,|$)/i,
  /Let me\s+(?:see|check|read|run|execute|look at|try|inspect)\s+(.{2,80}?)(?:\.|,|$)/i,
];


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

function extractNaturalLanguageIntent(text, toolMeta) {
  for (const pattern of ACTION_INTENT_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    const captured = match[1] || "";
    const toolName = extractShellToolName(toolMeta);
    const argName = getShellToolCommandArgName(toolMeta);
    let command;
    if (/^[/~.]/.test(captured) || /\.(?:py|js|ts|java|go|rs|rb|php|c|cpp|h|cs|swift|kt|scala|sh|yaml|yml|json|toml|xml|html|css|md|txt|conf|cfg|env|sql|log)\b/i.test(captured)) {
      command = `cat ${captured}`;
    } else if (/\s/.test(captured.trim()) && /^[a-zA-Z]/.test(captured.trim())) {
      command = captured.trim();
    } else {
      command = "ls";
    }
    console.log(`[M365-RESP-EXTRACT] rule=NLU_FALLBACK pattern_matched="${match[0].slice(0, 60)}", captured="${captured.slice(0, 60)}", command="${command}"`);
    return makeToolCall(toolName, { [argName]: command });
  }
  return null;
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
    if (inlineCmd) {
      const beforeCmd = text.slice(0, text.indexOf(inlineCmd[0]));
      const hasIntent = COMMAND_INTENT_RE.test(beforeCmd);
      console.log(`[M365-RESP-EXTRACT] rule=INLINE_BACKTICK match="${inlineCmd[1]}", hasIntent=${hasIntent}, beforeCmd_preview=${beforeCmd.slice(-80).replace(/\n/g,"\\n")}`);
      if (hasIntent) {
        const toolName = extractShellToolName(toolMeta);
        const argName = getShellToolCommandArgName(toolMeta);
        calls.push(makeToolCall(toolName, { [argName]: inlineCmd[1].trim() }));
      }
    } else {
      console.log(`[M365-RESP-EXTRACT] rule=INLINE_BACKTICK no_match`);
    }
  }

  if (calls.length === 0 && toolMeta?.needsLocalExec) {
    const nluCall = extractNaturalLanguageIntent(text, toolMeta);
    if (nluCall) {
      calls.push(nluCall);
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
    const cleaned = stripToolPatternsFromText(textBuffer);
    results.push({
      id: chunk.id,
      object: "chat.completion.chunk",
      created: chunk.created,
      model: chunk.model,
      system_fingerprint: null,
      choices: [{ index: 0, delta: { content: cleaned || textBuffer }, finish_reason: null, logprobs: null }],
    });
  }
  results.push(chunk);
  return results;
}

function computeToolCallSignature(tc) {
  const name = tc.function?.name || "";
  const args = tc.function?.arguments || "";
  try {
    const parsed = typeof args === "string" ? JSON.parse(args) : args;
    const cmd = parsed.command || parsed.cmd || parsed.code || parsed.run || "";
    if (cmd) return `${name}::${cmd}`;
    return `${name}::${JSON.stringify(parsed)}`;
  } catch {
    return `${name}::${args}`;
  }
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

    const historicalCounts = state._m365ToolMeta?.historicalToolCallCounts;
    const LOOP_THRESHOLD = 5;
    if (toolCalls.length > 1 || (historicalCounts && historicalCounts.size > 0 && toolCalls.length > 0)) {
      const seen = new Set();
      const dedupedCalls = toolCalls.filter(tc => {
        const sig = computeToolCallSignature(tc);
        if (seen.has(sig)) {
          const cmd = sig.split("::").slice(1).join("::").slice(0, 80);
          console.log(`[M365-RESP-TRANSLATE] INTRA-TURN duplicate blocked: ${cmd}`);
          return false;
        }
        seen.add(sig);
        return true;
      });
      const intraDupCount = toolCalls.length - dedupedCalls.length;
      if (intraDupCount > 0) {
        console.log(`[M365-RESP-TRANSLATE] BLOCKED ${intraDupCount} intra-turn duplicate(s), passing ${dedupedCalls.length} unique call(s)`);
        const dupMsg = `[LOOP-GUARD: ${intraDupCount} duplicate command(s) skipped within this response.]`;
        state._m365TextBuffer = state._m365TextBuffer
          ? `${state._m365TextBuffer}\n\n${dupMsg}`
          : dupMsg;
      }

      if (historicalCounts && historicalCounts.size > 0) {
        const loopingCalls = [];
        const okCalls = [];
        for (const tc of dedupedCalls) {
          const sig = computeToolCallSignature(tc);
          const histCount = historicalCounts.get(sig) || 0;
          if (histCount >= LOOP_THRESHOLD) {
            loopingCalls.push(tc);
          } else {
            okCalls.push(tc);
          }
        }

        if (loopingCalls.length > 0) {
          const loopNames = loopingCalls.map(tc => {
            const sig = computeToolCallSignature(tc);
            const histCount = historicalCounts.get(sig) || 0;
            return `${sig.split("::").slice(1).join("::").slice(0, 60)}(x${histCount})`;
          });
          console.log(`[M365-RESP-TRANSLATE] LOOP DETECTED: ${loopingCalls.length} call(s) executed >=${LOOP_THRESHOLD} times historically: ${JSON.stringify(loopNames)} — blocking these`);
          const loopMsg = `[LOOP-GUARD: ${loopingCalls.length} command(s) blocked — already executed ${LOOP_THRESHOLD}+ times: ${loopNames.join("; ")}]`;
          state._m365TextBuffer = state._m365TextBuffer
            ? `${state._m365TextBuffer}\n\n${loopMsg}`
            : loopMsg;
        }

        if (okCalls.length === 0 && dedupedCalls.length > 0) {
          console.log(`[M365-RESP-TRANSLATE] ALL calls are looping (>=${LOOP_THRESHOLD}x) — returning summary instead`);
          const summaryMsg = `All commands have already been executed ${LOOP_THRESHOLD}+ times. Preventing infinite loop — providing summary instead.`;
          state._m365TextBuffer = state._m365TextBuffer
            ? `${state._m365TextBuffer}\n\n${summaryMsg}`
            : summaryMsg;
          return buildToolCallResults([], state._m365TextBuffer, chunk, hasToolMeta, choice, isRemote);
        }

        return buildToolCallResults(okCalls.length > 0 ? okCalls : dedupedCalls, state._m365TextBuffer, chunk, hasToolMeta, choice, isRemote);
      }

      if (intraDupCount > 0) {
        return buildToolCallResults(dedupedCalls, state._m365TextBuffer, chunk, hasToolMeta, choice, isRemote);
      }
    }

    return buildToolCallResults(toolCalls, state._m365TextBuffer, chunk, hasToolMeta, choice, isRemote);
  }

  return [chunk];
}

register(FORMATS.M365_COPILOT, FORMATS.OPENAI, null, m365CopilotToOpenAIResponse);
