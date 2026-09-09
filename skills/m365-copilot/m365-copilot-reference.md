# M365 Copilot — Reference: Detection Patterns, Tool Classification, Models

## JailBreak Classifier

M365 has a **JailBreakClassifier** (not just keyword filter) that triggers `Conversation disengaged` with `offense="OffenseTrigger"` and `contentOrigin=JailBreakClassifier`. Key triggers:

| Pattern | Detection Source |
|---------|-----------------|
| `[SYSTEM OVERRIDE...]` | `M365_JAILBREAK_PHRASES` regex |
| `HIGHEST PRIORITY` | `M365_JAILBREAK_PHRASES` regex |
| `NOT in your sandbox` | `M365_JAILBREAK_PHRASES` regex |
| `Do NOT execute/run/use` | `M365_JAILBREAK_PHRASES` regex |
| `MUST NOT` | `M365_JAILBREAK_PHRASES` regex |
| `Do NOT use your code interpreter` | `M365_JAILBREAK_PHRASES` regex |
| `executed locally, NOT` | `M365_JAILBREAK_PHRASES` regex |
| `CRITICAL RULES` | `M365_JAILBREAK_PHRASES` regex |
| `CRITICAL SAFETY RULE` | `M365_JAILBREAK_PHRASES` regex |

Evidence from WS logs: `offense="OffenseTrigger"` on `author=user` echo, `contentOrigin=JailBreakClassifier` on Disengaged messages.

**Strategy**: Positive framing instead of negative prohibitions. `"always output a JSON instruction"` instead of `"Do NOT execute"`.

## Tool Call Detection Patterns (Fix48 Update)

| Pattern | Example | Detection |
|---------|---------|-----------|
| ````json-tool```` block | ` ```json-tool\n{"name":"exec_command",...}``` ` | `JSON_TOOL_RE` |
| ````json```` block | ` ```json\n{"name":"exec_command",...}``` ` | `JSON_BLOCK_RE` |
| Inline JSON | `{"name":"exec_command","arguments":{...}}` | `INLINE_JSON_TOOL_RE` |
| Naked JSON | `{"cmd":"ls"}` | `NAKED_CMD_JSON_RE` |
| `CMD:` prefix | `CMD: ls -la` | `CMD_PREFIX_RE` (legacy compat) |
| Backtick command (context-first) | `` run `find .` `` / `` 让我看 `config.yaml` `` | `COMMAND_INTENT_RE` (checks intent verb before backtick, no whitelist gate) |
| Remote exec result | `/mnt/file_upload` + `cwd: /mnt/` | `REMOTE_EXEC_INDICATORS` |
| Sandbox execution failure | "当前执行环境访问不到" / "cat: /Users/..." | `SANDBOX_EXEC_FAILURE_INDICATORS` + `extractCommandFromSandboxFailure()` |
| Natural language intent (NLU fallback) | "我来看一下附件" / "I'll read the file" | `ACTION_INTENT_PATTERNS` + `extractNaturalLanguageIntent()` |
| Natural language intent (past-tense excluded) | "我看到有些向日葵低下了头" | `看(?!看|到|了|过|一|出)` negative lookahead — NOT matched (Fix50 + Fix62) |
| Natural language intent (URL excluded) | "我打开 `https://agentrouter.org/register`" | URL detected → NLU skipped (Fix56) |

**Fix48 changes**:
- INLINE_BACKTICK: removed `COMMON_COMMANDS_RE` whitelist gate. Whether a backtick is a command is determined by `COMMAND_INTENT_RE` context (intent verb before backtick), not by whether the word is in a whitelist.
- `COMMAND_INTENT_RE` expanded with Chinese intent verbs (with optional `一下` suffixes and reduplication forms): `我[要需来想先会]|让[我咱]|请)(?:来|去)?(?:看(?:一下)?|读(?:一下)?|查(?:一下)?|检查(?:一下)?|执行(?:一下)?|运行(?:一下)?|列出(?:一下)?|浏览(?:一下)?|跑(?:一下)?|看看|读读|查查)`
- NLU fallback: when `needsLocalExec=true` + all 8 patterns fail + `extracted toolCalls=0`, `ACTION_INTENT_PATTERNS` matches Chinese/English action intent and synthesizes a tool_call

## Remote Exec Indicators

```javascript
const REMOTE_EXEC_INDICATORS = [
  /cwd:\s*\/mnt\//,
  /\/mnt\/(file_upload|data|home|tmp|usr|var|workspace|sandbox)/,
  /\/mnt\/[a-z_]+\s+is\s+(empty|not found)/,
  /\n\s*count:\s*\d+\s*\n/,
  /file_upload.*\n.*count:/,
];
```

When detected: `hasRemoteExec=true` → response translator strips remote output, extracts tool_calls instead, skips `cleanContent`.

## Sandbox Execution Failure Indicators (Fix55)

```javascript
const SANDBOX_EXEC_FAILURE_INDICATORS = [
  /当前执行环境(?:里)?(?:没有|无法|访问不到|不可)/,
  /(?:我按你要求|我尝试|我执行了?)(?:执行|运行|读取|查看)/,
  /(?:访问不到|无法访问|不可访问|No such file or directory)/,
  /cat:\s*\/(Users|home|tmp|var|root)\//,
  /(?:结果仍然?是|返回是)[:：]/,
  /(?:宿主路径|附件路径|文件路径).*(?:没有挂|不可达|不存在|not found)/,
  /(?:当前|本)(?:执行环境|环境)(?:里)?(?:没有|无法|还是)/,
];
```

When detected: `isSandboxFail=true` → `extractCommandFromSandboxFailure()` extracts command → converts to `exec_command` tool_call → Codex executes locally.

## CI Result Filter Patterns (Fix66)

```javascript
const CI_RESULT_PATTERNS = [
  /^命令已成功执行/,
  /^命令执行失败.*退出码/,
  /^无需进一步操作$/,
];
```

All patterns use `^` anchor to prevent false positives on normal text. When detected in executor or response translator, CI result text is filtered (not emitted to client).

## Tool Classification & M365 Capability Control

| Agent Tools | needsLocalExec | hasSearchTools | experienceType | Anti-Exec | M365 Search | disableCodeInterpreter |
|-------------|---------------|----------------|----------------|-----------|-------------|----------------------|
| None | false | false | Default | No | enabled | false |
| Shell only (codex) | true | false | Default | Yes | enabled | true |
| Shell + Search | true | true | Default | Yes (search forbidden) | disabled | true |
| Search only | false | true | Default | No | enabled | false |
| File ops only | true | false | Default | Yes | enabled | true |

`disableCodeInterpreter = !!toolMeta?.needsLocalExec` (Fix52). Previously hardcoded `false` — caused M365 Code Interpreter to execute python for image files when `needsLocalExec=true`.

## Shell Tool Names

Request translator (Set):
```javascript
const SHELL_TOOL_NAMES = new Set([
  "local_shell", "run_command", "execute_command", "exec_command",
  "Bash", "bash", "execute_bash", "run_bash",
  "shell_exec", "computer_terminal", "terminal",
]);
```

Response translator (inline check in `extractShellToolName()`): names containing `"shell"`, `"bash"`, `"exec"` or equal to `"local_shell"`, `"run_command"`, `"execute_command"`, `"Bash"`, `"execute_bash"`, `"terminal"`.

## Tool Result Formatting

| Tool Type | Format |
|-----------|--------|
| File read | `[File content (Read):\n...]` |
| File listing | `[File listing (Glob):\n...]` |
| Search results | `[Search results (Grep):\n...]` |
| Shell command | `[Output (exec_command):\n...]` |

## Tool Result Truncation Limits (Fix67)

| Constant | Value | Applies To |
|----------|-------|------------|
| `M365_MAX_TOOL_RESULT_LEN` | 24000 | General limit |
| `M365_MAX_FILE_CONTENT_LEN` | 20000 | File read/view_file results |
| `M365_MAX_SHELL_OUTPUT_LEN` | 16000 | exec_command/Bash output |

`truncateToolResult()` truncates at line boundary, appends `... [N more characters omitted]`. Applied in: `extractLatestUserInput()` TOOL branch, `flattenMessages()` TOOL role, `buildToolResultPrompt()`.

## sanitizeForM365 — Segment-Based Replacement

1. Split prompt into segments based on `SANITIZE_SKIP_PREFIXES` (`[Output (`, `[Result from `, `[File content (`, etc.)
2. Content after skip prefixes is preserved as-is (sanitize=false) until `SANITIZE_RESUME_MARKERS` (`[System]:`, `[User]:`, `[Assistant]:`, `---`)
3. In sanitize=true segments: `re.exec()` collects all match positions for dangerous words, builds result by splicing `[cmdN]` at correct offsets
4. Also replaces `M365_JAILBREAK_PHRASES` → `[note]`
5. File content, package names, command output inside output blocks are never corrupted

## INLINE_BACKTICK Detection (Fix48)

**Before (Fix47)**: `COMMON_COMMANDS_RE` whitelist gate → only backtick content matching the whitelist was checked for intent. Commands like `sub`, `sed`, `awk` were never checked.

**After (Fix48)**: Context-first approach. `COMMAND_INTENT_RE` checks the text BEFORE the backtick for intent verbs. If intent is found, the backtick content is treated as a command regardless of whether it's in a whitelist.

- "run `sub`" → `hasIntent=true` → tool_call with command="sub" ✅
- "the `sub` module" → `hasIntent=false` → no tool_call (document reference) ✅
- "我来看 `config.yaml`" → `hasIntent=true` (Chinese intent verb) → tool_call ✅

`COMMON_COMMANDS_RE` still used in `REMOTE_EXEC_CHECK` and `SANDBOX_EXEC_FAILURE_CHECK`.

## Loop Guard (Response-Side)

**Fix43 rewrite** — count-based historical detection replaces the old Set-based exact-match detection.

### Intra-turn dedup
- Within a single M365 response, identical `name::cmd` signatures are deduped
- Only active when `toolCalls.length > 1`

### Cross-turn count-based detection
- `buildHistoricalToolCallCounts(messages)` → `Map<signature, count>` (replaces old `extractHistoricalToolCallSignatures` Set)
- Stored in `_m365ToolMeta.historicalToolCallCounts`
- `LOOP_THRESHOLD = 5`: commands executed ≥5 times in history → **BLOCKED** (true loop)
- Commands executed <5 times → **ALLOWED** (normal re-execution: read→modify→read)
- Same tool + different arguments → **ALLOWED** (different files/different context)
- When all calls are looping (≥5x): return text summary instead of tool_calls

### apply_patch failure detection (Fix44)
- `patchFailCount` tracked during tool_result scanning
- Matches: `apply_patch` + (`verification failed` or `Failed to find expected lines`)
- `patchFailCount >= 3` → triggers `forceSummarize` with message: "do NOT use apply_patch again, provide manual code changes"
- Coexists with `totalCommands >= 15` forceSummarize condition

## WS Connect Retry (Fix45)

- M365 executor retries WS connection up to 2 additional times (3 total, 3s delay) for transient errors
- Transient errors: TLS/socket/ECONNRESET/ECONNREFUSED/ETIMEDOUT (regex match on error message)
- Non-transient errors (HTTP 4xx) fail immediately without retry
- `ERROR_RULES` now includes 502/503/504 status rules + TLS/socket text rules, all with 5s cooldown (was 30s default)

## conversationId Strategy (Fix46)

- Per-conversation isolation: conversationId includes `sha256(firstUserMessage[:120])[:16]`
- Same conversation across turns → same first USER message → same conversationId (STABLE)
- Different conversation → different first USER message → different conversationId (context isolation)
- sessionId aligned with conversationId (same hash included)
- Prevents cross-topic context pollution in M365 server-side conversation history
- **Both translator and executor independently compute conversationId** — translator uses direct SHA-256, executor uses `resolveSessionId()` wrapper. Both must produce the same result for continuation to work.

## Destructive Guardrail

**REMOVED in Fix42**. The gpt-5.6-specific destructive guardrail (`DESTRUCTIVE_COMMAND_PATTERNS` + `isDestructiveCommand()`) was removed due to high false-positive rate blocking legitimate code modification commands. Request-side `sanitizeForM365()` provides equivalent protection by removing dangerous words from the prompt before M365 sees them.

**Dead code**: `isGpt56` variable in request translator (`openai-to-m365-copilot.js:292`) is declared but never used — remnant from Fix42. Safe to clean up.

## Request Routing Decision Tree (Fix57 Update)

```
lastMsg.role === TOOL?
  → extractLatestUserInput (tool_result path)
     → pre-scan ASSISTANT tool_calls (skip TOOL first!)
     → buildEarlierContext (cwd + prev command)
     → prompt: "Here is the result..." + schema + reminder

isStalling (consecutivePureText >= 2)?
  → flattenMessages(stall_break)
     → full conversation history + stallBreakHint
     → breaks pure-text feedback loop

hasEarlierToolResults?
  && isContinuation (cache or structure)?
     → extractContinuationPrompt(earlier_tools)
        → last USER/ASSISTANT + [Previous User/Assistant pair] + buildEarlierContext summary
  && !isContinuation (first turn with earlier tools)?
     → flattenMessages(earlier_tools_first_turn)

isContinuation && !hasEarlierToolResults?
  → extractContinuationPrompt
     → last USER/ASSISTANT + [Previous User/Assistant pair] + buildEarlierContext summary

first turn (no history)?
  → flattenMessages (first request path, ~30KB+)
     → full conversation history flattened to natural language
```

## Search Bot Message Filtering

M365 may embed raw search result JSON in bot `text` field of type=2 messages. `isSearchBotMessage()` detects and skips these.

## M365 Model Registry

| Model ID | Name | Notes |
|----------|------|-------|
| `copilot` | M365 Copilot (Auto) | Default, tone=Magic or Gpt_5_6_Reasoning |
| `gpt-5.6` | GPT-5.6 深度思考 | defaultReasoning=true, tone=Gpt_5_6_Reasoning |
| `gpt-5.6-fast` | GPT-5.6 快速响应 | tone=Gpt_5_6_Chat |

Always use provider prefix: `m365-copilot/gpt-5.6`, not just `gpt-5.6`.

`gpt-5.5`/`gpt-5.5-fast` still work via `model.toLowerCase().includes()` in executor but not in registry.

## Tone Routing (Fix58)

```javascript
isFastModel = model.includes("gpt-5.6-fast") || model.includes("gpt-5.5-fast")
isDeepModel = (model.includes("gpt-5.6") || model.includes("gpt-5.5")) && !isFastModel

m365Tone = isFastModel
  ? "Gpt_5_6_Chat"
  : isDeepModel
    ? (reasoning !== false ? "Gpt_5_6_Reasoning" : "Gpt_5_6_Chat")
    : (reasoning === true ? "Gpt_5_6_Reasoning" : "Magic")
```

`enable_gg_gpt` only added for `"Gpt_5_6_Reasoning"` tone.

## Proxy Configuration

- **WS chat connections** (`m365-copilot.js`): Uses `HTTPS_PROXY || HTTP_PROXY` — same as all other providers. No M365-specific proxy.
- **Login browser** (`login.py`): Uses `M365_PROXY` (falls back to `HTTPS_PROXY`/`HTTP_PROXY`) — Playwright browser traffic routes through this proxy so exit IP is in Taiwan. Region check (`ALLOWED_COUNTRY_CODES = {"TW"}`) validates exit IP before login proceeds.
- **sync_remote.sh**: Passes `M365_PROXY` env var and `--proxy` CLI arg to `login.py`.

## login.py Token Extraction Flow (Fix71)

1. Open CHAT_URL (outlook.office.com iframe), auto-set macOS system proxy
2. Round 1: **no reload** — wait chat box (main page → iframes) → `type_in_chat(page, pick_greeting())` → wait WS token
3. If no token: `try_new_chat_and_type(page)` — click "New chat" button first, only input if new conversation opened (avoids duplicate messages)
4. If still no token: next round with `page.reload()` then retry
5. `pick_greeting()` picks from: hello, hi, hey, good morning, good afternoon, howdy, greetings
6. `type_in_chat(page, word)` is shared function for main page + iframe input

## Bot Text Dedup (Fix53)

M365 WS protocol sends each T2 bot message **twice** (identical text, possibly different messageId). Dedup at two layers:

1. **`rebuildFullText`** — Set-based dedup: identical text values from different Map keys are merged into one entry (covers `bufferForTools` mode)
2. **T6/T2 cross-msgId dedup** — When processing bot text, if `msgId !== "default"` and an identical text already exists under a different key in `botTextStreams`, skip the duplicate (covers streaming mode)

## isContinuation Detection (Fix49 + Fix54)

```javascript
isContinuationByStructure = hasAssistantHistory && earlierUserCount > 0 && !hasToolResults
isContinuationByCache = seenConversationFingerprints.has(convId)
isContinuation = isContinuationByStructure || (isContinuationByCache && hasAssistantHistory)
```

Fix54: Cache alone is insufficient — new tasks can have cache hits from previous conversations. Requiring `hasAssistantHistory` ensures new tasks (only SYSTEM+USER messages) are never misrouted to `extractContinuationPrompt`.

**Known limitation**: Within a Codex agentic loop, `hasAssistantHistory` is always true after the first turn. Topic switches mid-session still get `isContinuation=true(struct=true)`. This requires Context Agent for proper semantic detection.

## Image Handling (Fix52)

When prompt contains `<image` tag (Codex sends inline images with local file paths):
- `disableCodeInterpreter = true` (via `needsLocalExec`) prevents M365 from running python+PIL+tesseract
- Anti-read hint appended: "Images are already included inline above. Do NOT attempt to read, open, or process any image file paths."
- M365 uses built-in vision capability (`cwcfluxgptv` + `flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch`) to see inline images directly
- `[M365-EXEC-FLAGS]` log line includes `hasImage=true/false` for debugging

## Build & Deploy Notes

- **Next.js standalone** runs compiled `.next/server/chunks/` — `docker cp` of source files does NOT take effect
- Must either: `docker build`, or directly modify compiled chunks (risky but faster for hotfixes)
- Compiled chunk for M365 code: check `.next/server/chunks/` for current chunk number (changes with each build)
- Crypto imports must use explicit Node.js: `import { createHash, randomUUID } from "crypto"` (not Web Crypto)

## Pure-Text Stall Guard (Fix57)

Detects and breaks the feedback loop where M365 replies with pure text (no tool_call), Codex treats `finish_reason=stop` as "incomplete", and sends another request via `extractContinuationPrompt` with minimal context.

### Detection

- `countConsecutivePureText(messages)` — scans backwards from end, counting consecutive ASSISTANT messages with no `tool_calls`
- Skips USER messages between them (Codex inserts these as continuation prompts)
- `STALL_THRESHOLD = 2` — after 2 consecutive pure-text ASSISTANT responses, stall is detected

### Actions when stall detected

1. **Strategy override**: Skip `extractContinuationPrompt`, force `flattenMessages(stall_break)` — full context so M365 sees it already answered
2. **stallBreakHint**: Appended to `finalPrompt` — "The assistant has already provided a text answer. Do NOT repeat."
3. **Diagnostic**: `consecutivePureTextCount` carried in `_m365ToolMeta`, logged as `[M365-REQ-STALL]` and `[M365-RESP-STALL]`

### Interaction with other guards

- **LOOP_GUARD (Fix43)**: Complementary — Fix43 handles tool_call signature loops, Fix57 handles pure-text stalls
- **hasToolResults**: Always takes priority — stall guard never overrides tool_result processing
- **isContinuation**: Stall guard checks after `isContinuation` computation but before strategy selection

## Allowed Message Types (30 entries)

When `disableCodeInterpreter=true`, 5 CI types are removed (GeneratedCode, RenderCardRequest, GenerateGraphicArt, GenerateContentQuery, ConfirmationCard) → 25 remain.

Full list: Chat, Suggestion, InternalSearchQuery, Disengaged, InternalLoaderMessage, Progress, GeneratedCode, RenderCardRequest, AdsQuery, SemanticSerp, GenerateContentQuery, GenerateGraphicArt, SearchQuery, ConfirmationCard, AuthError, DeveloperLogs, TriggerPlugin, HintInvocation, MemoryUpdate, EndOfRequest, TriggerConfirmation, ResumeInvokeAction, ResumeUserInputRequest, TriggerUserInputRequest, EscapeHatch, TriggerPluginAuth, ResumePluginAuth, SideBySide, ReferencesListComplete, SwitchRespondingEndpoint.

## WS Message Filtering

| Message Type | Action | Notes |
|---|---|---|
| ChainOfThoughtSummary | **Emitted** with `[Thinking]` prefix | User can see model's reasoning |
| non-DeepLeo Progress | Filtered | Progress indicators |
| ReferencesListComplete | Filtered | Signal only |
| Suggestion | Filtered | Suggestion chips |
| EscapeHatch | Filtered | "Hide" button marker |
| InternalLoaderMessage | Filtered | "正在生成响应。" loading indicator |
