# M365 Copilot — Reference: Detection Patterns, Tool Classification, Models

## Tool Call Detection Patterns

M365 may return tool calls in various formats. The response translator detects all of them:

| Pattern | Example | Detection |
|---------|---------|-----------|
| ````json-tool```` block | ` ```json-tool\n{"name":"exec_command",...}``` ` | `JSON_TOOL_RE` |
| ````json```` block | ` ```json\n{"name":"exec_command",...}``` ` | `JSON_BLOCK_RE` |
| Inline JSON | `{"name":"exec_command","arguments":{...}}` | `INLINE_JSON_TOOL_RE` |
| Naked JSON | `{"cmd":"ls"}` | `NAKED_CMD_JSON_RE` |
| `CMD:` prefix | `CMD: ls -la` | `CMD_PREFIX_RE` (legacy compat) |
| Backtick command | `` `find . -maxdepth 1` `` | `COMMAND_INTENT_RE` + inline backtick (requires intent verb before backtick) |
| Remote exec result | `/mnt/file_upload` + `cwd: /mnt/` | `REMOTE_EXEC_INDICATORS` |

When any pattern is detected, the text is converted to an OpenAI `tool_calls` chunk with `finish_reason: "tool_calls"`.

## M365 Safety Filter (Content Policy)

M365 has a **keyword-based safety filter** that triggers `Conversation disengaged` → "Sorry, it looks like I can't chat about this." It does NOT distinguish context — mentioning `rm, delete` even in a "do NOT execute" rule triggers the filter.

**Trigger words**: `rm`, `rmdir`, `del`, `delete`, `shred`, `format`, `erase`, `wipe`, `destroy`, `truncate`, `overwrite`

**Sources of trigger words in 9router**:
1. Codex system prompt: `CRITICAL SAFETY RULE: ... NEVER suggest ... rm, del, delete...`
2. `buildAntiExecutionPrompt()` `destructiveBlock` for gpt-5.6 models
3. Tool result output: `rm: cannot remove...`, `Permission denied` after `del` etc.

**Mitigation**: `sanitizeForM365()` in `openai-to-m365-copilot.js` replaces dangerous words with `[cmd1]` placeholders, applied at final prompt construction (`_m365Prompt: sanitizeForM365(finalPrompt)`).

## Remote Exec Indicators

Full set of indicators that M365 executed in its remote sandbox:

```javascript
const REMOTE_EXEC_INDICATORS = [
  "/mnt/file_upload",
  "/mnt/data",
  "/mnt/home",
  "/mnt/tmp",
  "/mnt/usr",
  "/mnt/var",
  "/mnt/workspace",
  "/mnt/sandbox",
  "cwd: /mnt/",
];
```

When detected: `hasRemoteExec=true` → response translator strips remote output and extracts tool_calls instead.

## Inline Command Intent Detection

Backtick commands must NOT be blindly converted to tool calls. Tutorial text like "Install with npm install express" should remain as text. `COMMAND_INTENT_RE` requires an **intent verb** before the backtick command:

```
// Converted to tool_call:
"Run `find . -maxdepth 1`"      → intent verb "Run"
"Execute `ls -la`"              → intent verb "Execute"
"CMD: find /tmp -name core"     → CMD: prefix

// NOT converted (no intent verb):
"To install, run npm install express"  → tutorial context
"The server runs on node server.mjs"   → description
```

## Tool Classification & M365 Capability Control

Agent tools are classified as **shell** / **search** / **fileOp** with derived flags:

- `needsLocalExec` = shell or fileOp tools present → triggers anti-exec prompt + content buffering
- `hasSearchTools` = search tools present → affects anti-exec prompt variant + experienceType

### Decision Matrix

| Agent Tools | needsLocalExec | hasSearchTools | experienceType | Anti-Exec Prompt | M365 Search |
|-------------|---------------|----------------|----------------|------------------|-------------|
| None | false | false | Default | No | enabled |
| Shell only (codex) | true | false | **Deep** | Yes (search OK) | enabled |
| Shell + Search (hermes) | true | true | Default | Yes (**search forbidden**) | disabled |
| Search only | false | true | Default | No | enabled |
| File ops only | true | false | Deep | Yes (search OK) | enabled |

When `disableCodeInterpreter=true` (needsLocalExec), strip CI/image flags from `optionsSets`.
When `enableSearch=true` (always), keep `BingWebSearch` plugin and search message types.

### Anti-Exec Prompt Variants

- **hasSearchTools=true**: "Do NOT use web search — the user has local search tools for that"
- **hasSearchTools=false**: "Do NOT execute commands" (M365 may search to enrich responses)

### Special Tool Notes

`browser_navigate`/`browser_*` are classified as search tools (not shell), so they set `hasSearchTools=true` but do NOT trigger `needsLocalExec` on their own.

### Shell Tool Names

```javascript
const SHELL_TOOL_NAMES = [
  "local_shell", "run_command", "execute_command", "exec_command",
  "shell", "bash", "terminal", "command_line",
];
```

## Tool Result Formatting

`formatToolResult()` distinguishes tool types for M365 round-trip:

| Tool Type | Format | Example |
|-----------|--------|---------|
| File read | `[File content (Read, executed locally)]` | `[File content (Read, executed locally)]\nfile contents...` |
| File listing | `[File listing (Glob, executed locally)]` | `[File listing (Glob, executed locally)]\nsrc/\npackage.json` |
| Search results | `[Search results (Grep, executed locally)]` | `[Search results (Grep, executed locally)]\nfile.js:10: match` |
| Shell command | `[Command output (exec_command, executed locally, NOT in your sandbox)]` | `[Command output (exec_command, executed locally, NOT in your sandbox)]\noutput...` |

## Search Bot Message Filtering

M365 may embed raw search result JSON in bot `text` field of type=2 messages:

```json
{"query":"Next.js","result":{"WebPages":[{"name":"Next.js","url":"..."}]}}
```

If this text is longer than the real answer, it overwrites `fullText`. `isSearchBotMessage()` detects and skips these messages by checking:
- `messageType` in `SEARCH_MESSAGE_TYPES` set (InternalSearchQuery, InternalSearchResult, SemanticSerp, etc.)
- `text` starts with `{"query"` and contains `"WebPages"`
- `hiddenText` contains `"WebPages"`

Applied in both streaming `processData()` and non-streaming handler.

## M365 Model Registry

| Model ID | Behavior | When to Use |
|----------|----------|-------------|
| `copilot` | Default M365 Copilot (GPT-4o class) | General use |
| `gpt-5.5` | Deep thinking, reasoning on by default | Complex analysis, multi-step reasoning |
| `gpt-5.5-fast` | Quick response, no reasoning | Simple Q&A, fast turnaround |
| `gpt-5.6` | Deep thinking, reasoning on by default | Latest model, needs M365 backend support (unverified) |
| `gpt-5.6-luna` | Quick response, no reasoning | Lightweight variant |
| `gpt-5.6-terra` | Deep thinking, reasoning on by default | Mid-tier reasoning |
| `gpt-5.6-sol` | Deep thinking, reasoning on by default | High-tier reasoning |

GPT-5.2 is no longer available on M365. GPT-5.6 series availability depends on M365 backend — verify by sending `m365-copilot/gpt-5.6` after deployment.

## Crypto Import Compatibility

Next.js webpack bundles `crypto` as the Web Crypto API (no `createHash`). Always use explicit Node.js imports:

```javascript
import { createHash, randomUUID } from "crypto";
// NOT: crypto.randomUUID() — fails at runtime
// NOT: crypto.createHash() — fails at runtime
```

## Model Routing Pitfall

When a client sends `model: "gpt-5.5"` (no provider prefix), `inferProviderFromModelName()` routes to `openai` provider by prefix heuristic. Always use:

```bash
# WRONG — gets routed to openai
model: "gpt-5.5"

# CORRECT — goes to m365-copilot executor
model: "m365-copilot/gpt-5.5"
model: "m365/gpt-5.5"
model: "m365/copilot"
```

## Build Pitfalls

- **Dead PROVIDER_MODELS block** in `providerModels.js`: orphaned object entries after `export` line cause syntax errors. Delete entirely.
- **Duplicate export declarations**: `grep -n 'export const X' file.js` finds duplicates. Common in `providers.js` and `constants/providers.js`.
- **docker cp doesn't work for Next.js standalone**: Compiled `.next/server/chunks/` are what runs. Must `docker build` for real deployment.
