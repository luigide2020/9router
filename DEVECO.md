# DEVECO.md — DevEco Code Project Rules

## Conventions

- **Do NOT `git commit` or `git push` until the user explicitly confirms verification is complete.** Implement changes, let the user test (e.g. docker build + deploy), then commit/push only after approval.
- **Do NOT run docker commands (build/stop/rm/run/logs) yourself.** The user manages the container lifecycle — just tell them to rebuild and redeploy when code changes are ready.
- **Before finalizing any code change, do a self-review: reason through each modification's impact on existing logic, identify potential side effects or regressions, and explicitly state your findings.** Do not just list what changed — reason about what could break.

## M365 Copilot Architecture

- M365 has a server-side Code Interpreter (CI) that executes commands in a remote sandbox. There is no client-side toggle to fully disable it — we rely on: (1) removing CI flags from optionsSets, (2) anti-execution text prompt, (3) response-side detection + conversion to local tool_call.
- When `needsLocalExec=true` (agent has shell/file tools): `disableCodeInterpreter=false` (M365 needs CI flags for motivation to act; antiExecPrompt redirects action to JSON output), STABLE conversationId for multi-turn memory, antiExecPrompt tells M365 to output JSON instead of executing.
- When `needsLocalExec=false` (pure chat, no tools): CI flags present, STABLE conversationId, no antiExecPrompt. M365 may use CI for calculations/search which is acceptable.
- Loop guard (response-side) blocks duplicate tool_calls based on signature matching. It exists as a safety net but must not interfere with legitimate retries (e.g. failed command with modified arguments).
- FRESH conversationId was previously used for `needsLocalExec` to prevent CI context inheritance across rounds. STABLE is now preferred so M365 has conversation memory and does not repeat commands. If M365 still executes remotely, the response-side detection converts it to a local tool_call (agent re-executes locally).
- Fix32 intentionally reverted `disableCodeInterpreter` to always-false and removed Deep experienceType + Precise tone, because Deep+Precise caused poor response quality (M365 became too conservative). Another reason: removing CI flags makes M365 passive — it only describes what it "would do" instead of outputting JSON tool_calls. Keeping CI flags gives M365 motivation to act; antiExecPrompt redirects that action to JSON output. Current approach: keep CI flags, Default experienceType, Reasoning/Balanced tone, STABLE conversationId.
