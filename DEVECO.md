# DEVECO.md — DevEco Code Project Rules

## Conventions

- **Do NOT `git commit` or `git push` until the user explicitly confirms verification is complete.** Implement changes, let the user test (e.g. docker build + deploy), then commit/push only after approval.
- **Do NOT run docker commands (build/stop/rm/run/logs) yourself.** The user manages the container lifecycle — just tell them to rebuild and redeploy when code changes are ready.
