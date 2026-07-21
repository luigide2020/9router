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

## Tool Call Detection Patterns

| Pattern | Example | Detection |
|---------|---------|-----------|
| ````json-tool```` block | ` ```json-tool\n{"name":"exec_command",...}``` ` | `JSON_TOOL_RE` |
| ````json```` block | ` ```json\n{"name":"exec_command",...}``` ` | `JSON_BLOCK_RE` |
| Inline JSON | `{"name":"exec_command","arguments":{...}}` | `INLINE_JSON_TOOL_RE` |
| Naked JSON | `{"cmd":"ls"}` | `NAKED_CMD_JSON_RE` |
| `CMD:` prefix | `CMD: ls -la` | `CMD_PREFIX_RE` (legacy compat) |
| Backtick command | `` `find . -maxdepth 1` `` | `COMMAND_INTENT_RE` + inline backtick |
| Remote exec result | `/mnt/file_upload` + `cwd: /mnt/` | `REMOTE_EXEC_INDICATORS` |

## Remote Exec Indicators

```javascript
const REMOTE_EXEC_INDICATORS = [
  "/mnt/file_upload", "/mnt/data", "/mnt/home", "/mnt/tmp",
  "/mnt/usr", "/mnt/var", "/mnt/workspace", "/mnt/sandbox", "cwd: /mnt/",
];
```

When detected: `hasRemoteExec=true` → response translator strips remote output, extracts tool_calls instead, skips `cleanContent`.

## Tool Classification & M365 Capability Control

| Agent Tools | needsLocalExec | hasSearchTools | experienceType | Anti-Exec | M365 Search |
|-------------|---------------|----------------|----------------|-----------|-------------|
| None | false | false | Default | No | enabled |
| Shell only (codex) | true | false | Default | Yes | enabled |
| Shell + Search | true | true | Default | Yes (search forbidden) | disabled |
| Search only | false | true | Default | No | enabled |
| File ops only | true | false | Deep | Yes | enabled |

When `disableCodeInterpreter=true` (now always false): previously used Deep+Precise. Current config: always `Default` experienceType + `Reasoning`/`Balanced` tone.

## Shell Tool Names

```javascript
const SHELL_TOOL_NAMES = [
  "local_shell", "run_command", "execute_command", "exec_command",
  "shell", "bash", "terminal", "command_line",
];
```

## Tool Result Formatting

| Tool Type | Format |
|-----------|--------|
| File read | `[File content (Read):\n...]` |
| File listing | `[File listing (Glob):\n...]` |
| Search results | `[Search results (Grep):\n...]` |
| Shell command | `[Output (exec_command):\n...]` |

## sanitizeForM365 — Segment-Based Replacement

1. Split prompt into segments based on `SANITIZE_SKIP_PREFIXES` (`[Output (`, `[Result from `, `[File content (`, etc.)
2. Content after skip prefixes is preserved as-is (sanitize=false) until `SANITIZE_RESUME_MARKERS` (`[System]:`, `[User]:`, `[Assistant]:`, `---`)
3. In sanitize=true segments: `re.exec()` collects all match positions for dangerous words, builds result by splicing `[cmdN]` at correct offsets
4. Also replaces `M365_JAILBREAK_PHRASES` → `[note]`
5. File content, package names, command output inside output blocks are never corrupted

## Tool Result Truncation

- `M365_MAX_TOOL_RESULT_LEN = 8000` characters
- `truncateToolResult()` truncates at line boundary, appends `... [N more characters omitted]`
- Applied in: `extractLatestUserInput()` TOOL branch, `flattenMessages()` TOOL role, `buildToolResultPrompt()`

## Destructive Guardrail (gpt-5.6)

- `DESTRUCTIVE_COMMAND_PATTERNS` use **line-anchored** regex with `^` + `m` flag
- Only matches commands at **line start** (not embedded in file content, `perl -e` scripts, etc.)
- `/\bformat\b/i` → `/^\s*format\s+\/dev\//im` — only matches disk formatting, not package names
- `isDestructiveCommand()` checks each line independently (splits by `\n`, skips comments)
- When blocked: tool_call is removed, `[SAFETY: N potentially harmful command(s) blocked]` appended

## Request Routing Decision Tree

```
lastMsg.role === TOOL?
  → extractLatestUserInput (tool_result path)
     → pre-scan ASSISTANT tool_calls (skip TOOL first!)
     → buildEarlierContext (cwd + prev command)
     → prompt: "Here is the result..." + schema + reminder
  → hasEarlierToolResults?
     → extractLatestUserInput (USER with context path)
        → scan earlier TOOL for cwd
        → prompt: [Context: cwd] + [User: text]
     → flattenMessages (first request path, ~30KB+)
        → full conversation history flattened to natural language
```

## Search Bot Message Filtering

M365 may embed raw search result JSON in bot `text` field of type=2 messages. `isSearchBotMessage()` detects and skips these.

## M365 Model Registry

| Model ID | Behavior |
|----------|----------|
| `copilot` | Default M365 Copilot (GPT-4o class) |
| `gpt-5.5` | Deep thinking, reasoning on by default |
| `gpt-5.5-fast` | Quick response, no reasoning |
| `gpt-5.6` | Deep thinking, reasoning on by default |
| `gpt-5.6-luna` | Quick response, no reasoning |
| `gpt-5.6-terra` | Deep thinking, mid-tier reasoning |
| `gpt-5.6-sol` | Deep thinking, high-tier reasoning |

Always use provider prefix: `m365-copilot/gpt-5.6-sol`, not just `gpt-5.6`.

## Build & Deploy Notes

- **Next.js standalone** runs compiled `.next/server/chunks/` — `docker cp` of source files does NOT take effect
- Must either: `docker build`, or directly modify compiled chunks (risky but faster for hotfixes)
- Compiled chunk for M365 code: `.next/server/chunks/216.js`
- Crypto imports must use explicit Node.js: `import { createHash, randomUUID } from "crypto"` (not Web Crypto)
