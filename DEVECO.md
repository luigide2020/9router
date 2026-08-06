# deveco.md — Project Rules & Architecture

## Agent behavior rules

- NEVER run `docker build`, `docker restart`, or any deployment command unless the user explicitly asks. Code changes are complete after file edits + syntax check.
- NEVER run `git commit` or `git push` until the user explicitly confirms verification is complete.
- After each plan-level change (a Fix or feature), do a full self-review: re-read all modified files, verify no conflict with previous fixes, and check that earlier fixes are not broken. Do not just list what changed — reason about what could break.

## open-sse Architecture

Provider-agnostic SSE engine: one OpenAI-style request → any provider (LLM chat, image, embedding, tts, stt, search), streamed back in the client's format.

### Request lifecycle (chat)

`handlers/chatCore.js` → `services/model.js` `parseModel` (resolve `provider/model`) → **pre-translate hooks** (`rtk/` tool_result compress, `rtk/headroom.js` proxy compress, `rtk/caveman.js` system inject — all fail-open) → `executors/index.js` `getExecutor(provider)` → `translator/index.js` `translateRequest` (client format → provider format) → `executor.execute()` (streams upstream) → `translateResponse` (provider chunks → client format) → SSE out.

### Directory map

- `config/` — ALL constants/config (no hardcode elsewhere). `providers.js`/`registry/` (provider defs), `providerModels.js` (alias→models matrix), `runtimeConfig.js` (timeouts, token limits), `*Constants.js`.
- `translator/` — format conversion. `request/<from>-to-<to>.js`, `response/<from>-to-<to>.js`, `schema/` (enums: ROLE, CLAUDE_BLOCK…), `concerns/` (shared logic), `formats.js`+`formats/` (per-format). `index.js` is the registry/entry.
- `executors/` — per-provider upstream call. `base.js` (BaseExecutor), one file per special provider, `index.js` map.
- `providers/` — registry build + `capabilities.js` + `pricing.js`. Entry: `index.js` (PROVIDERS).
- `handlers/` — per-modality cores (chat/image/embedding/tts/stt/search) + sub-provider folders. `chatCore/` has the streaming/non-streaming/sse-to-json handlers.
- `rtk/` — request token-killer. `index.js` compresses `tool_result` content in-place (OpenAI/Claude/Kiro shapes); `filters/` per-tool compressors + `autodetect.js`; `headroom.js` external compress proxy; `caveman.js` system-prompt injector.
- `transformer/` — `responsesTransformer.js` (Chat Completions SSE → Codex Responses API SSE), `streamToJsonConverter.js`.
- `shared/` — cross-provider auth/identity: `clineAuth.js`, `machineId.js`, `qoder/`.
- `services/` — `model.js`, `provider.js`, `accountFallback.js`, `combo.js`, `compact.js`, `tokenRefresh/`+`tokenRefresh.js`, `oauthCredentialManager.js`, `usage/`, `projectId.js`, `kiroModels.js`/`qoderModels.js`.
- `utils/` — streamHandler, stream, sse, error, sessionManager, claudeCloaking, clientDetector, proxyFetch (patches global fetch), cursorProtobuf/cursorChecksum, ollamaTransform.

### Conventions

- Config-driven, DRY, camelCase. NEVER hardcode values, models, or block/role strings — use `config/` + `schema/` constants.
- Translator pipeline pivots through OpenAI as the intermediate format. A translator registered on the exact `source:target` pair (e.g. `claude:kiro`) runs as a **direct route**, skipping the lossy double-hop.
- Translators self-register via `register(from, to, reqFn, resFn)` as an import side-effect — new files MUST be imported in `translator/index.js`.

### How to add

- **Provider**: copy `providers/REGISTRY_TEMPLATE.js` → `providers/registry/{id}.js`; add models to `config/providerModels.js`. Generic providers need no executor (DefaultExecutor handles OpenAI-compatible APIs).
- **Executor** (only for non-standard upstream): subclass `BaseExecutor` (override `getBaseUrls`/`buildHeaders`/`buildUrl`/`execute`), register in `executors/index.js` map. `getExecutor` falls back to `DefaultExecutor` when absent.
- **Translator**: add `request|response/<from>-to-<to>.js` calling `register(...)`, then import it in `translator/index.js`. Reuse `schema/` + `concerns/` — don't re-implement parsing.

### Pitfalls

- OpenAI bridge is lossy (thinking, non-base64 images, tool ids, is_error) — prefer a direct route for fragile pairs.
- `registry/index.js` is an auto-generated static import list; regenerate it (don't hand-edit) after adding a `registry/{id}.js`. REGISTRY_TEMPLATE is excluded by design.
- Special binary/protobuf formats (kiro EventStream, cursor protobuf, commandcode NDJSON) don't round-trip through OpenAI — handle in their executor.
- `rtk/` + `headroom.js` mutate the request body in-place and are **fail-open**: any error returns null and leaves the body untouched — never throw out of them. RTK skips `is_error`/`status:"error"` tool results to preserve traces.

## M365 Copilot Architecture

- M365 has a server-side Code Interpreter (CI) that executes commands in a remote sandbox. There is no client-side toggle to fully disable it — we rely on: (1) removing CI flags from optionsSets, (2) anti-execution text prompt, (3) response-side detection + conversion to local tool_call.
- When `needsLocalExec=true` (agent has shell/file tools): `disableCodeInterpreter=false` (M365 needs CI flags for motivation to act; antiExecPrompt redirects action to JSON output), STABLE conversationId for multi-turn memory, antiExecPrompt tells M365 to output JSON instead of executing.
- When `needsLocalExec=false` (pure chat, no tools): CI flags present, STABLE conversationId, no antiExecPrompt. M365 may use CI for calculations/search which is acceptable.
- Loop guard (response-side) blocks duplicate tool_calls based on signature matching. It exists as a safety net but must not interfere with legitimate retries (e.g. failed command with modified arguments).
- FRESH conversationId was previously used for `needsLocalExec` to prevent CI context inheritance across rounds. STABLE is now preferred so M365 has conversation memory and does not repeat commands. If M365 still executes remotely, the response-side detection converts it to a local tool_call (agent re-executes locally).
- Fix32 intentionally reverted `disableCodeInterpreter` to always-false and removed Deep experienceType + Precise tone, because Deep+Precise caused poor response quality (M365 became too conservative). Another reason: removing CI flags makes M365 passive — it only describes what it "would do" instead of outputting JSON tool_calls. Keeping CI flags gives M365 motivation to act; antiExecPrompt redirects that action to JSON output. Current approach: keep CI flags, Default experienceType, Reasoning/Balanced tone, STABLE conversationId.
