# M365 Copilot 远程执行检测 & 多流文本累积修复日志

> 日期: 2026-07-13 (初版) / 2026-07-14 (第二轮修复)
> 状态: 已部署待验证 (第二轮)

## 根因分析

### 问题1: M365 忽略 anti-exec prompt，在返回 tool_result 后仍然远程执行

M365 收到 Codex 的本地执行结果 (tool_result) 后，9router **不再注入 anti-exec prompt**，导致 M365 不知道"不要自己执行命令"，又触发远程沙箱执行。

**根因**: `openai-to-m365-copilot.js` L342-353，条件判断 `!hasToolResults && needsLocalExec`，导致有 tool_result 时不注入 prompt。

### 问题2: 多消息流 fullText 重复追加

M365 的 `type:1` 消息按 `messageId`/`responseIdentifier` 分为多个独立流，每个流独立累积文本。之前的单一 `fullText` 变量在检测到"新流"时追加，但后续的 type:1 增量更新（同流内累积增长）又被当作新内容追加，导致重复。

### 问题3: 远程沙箱路径变更

M365 远程沙箱路径从 `/mnt/file_upload` 变为 `/mnt/data`，`REMOTE_EXEC_INDICATORS` 未更新。

---

## 已实施的修复

### 修复1: anti-exec prompt 对 tool_result 请求也注入 (关键修复)

**文件**: `open-sse/translator/request/openai-to-m365-copilot.js`

**Before**:
```javascript
if (!hasToolResults && needsLocalExec) {
  const antiExecPrompt = buildAntiExecutionPrompt(...);
  finalPrompt = `${antiExecPrompt}\n\n---\n\n${flatMessages}`;
} else {
  finalPrompt = flatMessages;
}
```

**After**:
```javascript
if (needsLocalExec) {
  const antiExecPrompt = buildAntiExecutionPrompt(...);
  if (hasToolResults) {
    finalPrompt = `${antiExecPrompt}\n\n---\n\n[IMPORTANT REMINDER: Do NOT execute any commands yourself. The results below were run locally. If you need to run more commands, output JSON only.]\n\n${flatMessages}`;
  } else {
    finalPrompt = `${antiExecPrompt}\n\n---\n\n${flatMessages}`;
  }
} else {
  finalPrompt = flatMessages;
}
```

### 修复2: tool_result 提示语强化

**文件**: `open-sse/translator/request/openai-to-m365-copilot.js`

- `formatToolResult()`: shell 命令结果从 `[Command output (${tcName})]` → `[Command output (${tcName}, executed locally, NOT in your sandbox)]`
- `formatToolResult()`: 文件操作结果从 `[${label} (${tcName})]` → `[${label} (${tcName}, executed locally)]`
- `buildToolResultPrompt()`: 从 `[TOOL RESULT (executed locally)]` → `[TOOL RESULT (executed locally, NOT in your sandbox)]`
- `extractLatestUserInput()`: 从 `I ran the command you suggested. Here is the output` → `I ran the command you suggested LOCALLY (not in your sandbox). Here is the LOCAL output`，结尾加 `Do NOT execute any commands yourself. Do NOT use your code interpreter. If you need to run another command, output JSON only.`

### 修复3: botTextStreams Map 替代单一 fullText

**文件**: `open-sse/executors/m365-copilot.js`

**Before**:
```javascript
let fullText = "";
let closed = false;
// type:1 处理:
if (msg.text && msg.author === "bot") {
  const delta = msg.text.slice(fullText.length);
  if (delta) {
    fullText = msg.text;
    if (!bufferForTools) emitContent(delta);
  } else if (fullText.length > 0 && !msg.text.startsWith(fullText.slice(0, 20))) {
    fullText += "\n" + msg.text;
    if (!bufferForTools) emitContent("\n" + msg.text);
  }
}
```

**After**:
```javascript
let fullText = "";
let botTextStreams = new Map();
let closed = false;

const rebuildFullText = () => {
  const parts = [];
  for (const text of botTextStreams.values()) {
    if (text) parts.push(text);
  }
  fullText = parts.join("\n");
};

// type:1 处理:
if (msg.text && msg.author === "bot") {
  const msgId = msg.messageId || msg.responseIdentifier || "default";
  const prev = botTextStreams.get(msgId) || "";
  if (msg.text.length > prev.length) {
    const delta = msg.text.slice(prev.length);
    botTextStreams.set(msgId, msg.text);
    if (!bufferForTools) emitContent(delta);
  }
}

// type:2 处理: 同样按 msgId 追踪
// close(): 先 rebuildFullText() 再处理
// sendError(): 同样先 rebuildFullText()
```

### 修复4 (更早): 远程执行检测路径扩展

**文件**: `open-sse/executors/m365-copilot.js` L270, `open-sse/translator/response/m365-copilot-to-openai.js` L25-31

`REMOTE_EXEC_INDICATORS` 增加 `/mnt/data`, `/mnt/home`, `/mnt/tmp` 等。
`hasRemoteExec` 正则改为 `/\/mnt\/(file_upload|data|home|tmp|usr|var|workspace|sandbox)\//`。

### 修复5 (2026-07-14): SHELL_TOOL_NAMES 显式加入 exec_command

**文件**: `open-sse/translator/request/openai-to-m365-copilot.js` L37-41

Codex 使用 `exec_command` 而非 `execute_command`，之前靠 `classifyTool()` 的 `n.includes("exec")` 兜底匹配，不可靠。

**Before**: `"local_shell", "run_command", "execute_command", ...`
**After**: `"local_shell", "run_command", "execute_command", "exec_command", ...`

### 修复6 (2026-07-14): extractLatestUserInput 增强 JSON schema 提示

**文件**: `open-sse/translator/request/openai-to-m365-copilot.js` L272-323

M365 收到 tool_result 后回复自然语言而非 JSON tool_call (`extracted toolCalls=0`)。根因：提示语太弱，没有给出具体 JSON schema 格式。

**改进**:
- `extractLatestUserInput()` 新增 `toolMeta` 参数，根据实际 shell tool schema 生成精确的 JSON 格式示例
- 提示语从模糊的 "output JSON only" 改为 4 条 CRITICAL RULES，明确列出 JSON 格式模板
- 允许 M365 在仅分析/解释时用纯文本回复（不需要命令时不强制 JSON）

### 修复7 (2026-07-14): anti-exec reminder 放在 tool_result 内容之后

**文件**: `open-sse/translator/request/openai-to-m365-copilot.js` L350-357

M365 可能在看到命令输出后被"触发" CI 执行。将 reminder 从 tool_result 前面移到后面，让 M365 看完输出后立即看到禁执行指令。

**Before**: `finalPrompt = ${antiExecPrompt}\n\n---\n\n[IMPORTANT REMINDER:...]\n\n${flatMessages}`
**After**: `finalPrompt = ${flatMessages}\n\n---\n\n${reminder}`（reminder 包含 SYSTEM OVERRIDE + antiExecPrompt）

### 修复8 (2026-07-14): experienceType 改为 "Deep" 当 disableCodeInterpreter

**文件**: `open-sse/executors/m365-copilot.js` L151

`experienceType: "Deep"` 比 `"Default"` 更好抑制 Code Interpreter。之前仅当 `disableCodeInterpreter && !enableSearch` 时才用 Deep，改为 `disableCodeInterpreter` 时始终用 Deep。

### 修复9 (2026-07-14): tone 改为 "Precise" 当 disableCodeInterpreter

**文件**: `open-sse/executors/m365-copilot.js` L160

`Precise` tone 比 `Balanced` 更保守，更不容易触发 CI 执行。

**Before**: `tone: enableReasoning ? "Reasoning" : "Balanced"`
**After**: `tone: disableCodeInterpreter ? "Precise" : (enableReasoning ? "Reasoning" : "Balanced")`

### 修复10 (2026-07-14): buildCopilotOptionsSets 精简 CI flags

**文件**: `open-sse/executors/m365-copilot.js` L109-125

之前 `disableCodeInterpreter` 时也移除了 `rich_responses`、`pages_citations`、`pages_citations_multiturn`，这些不是 CI 相关的，移除后可能导致 M365 不返回富文本/引用。

**After**: 只移除真正 CI 相关的 flags，保留 `rich_responses` 和 `pages_citations`

### 修复11 (2026-07-14): needsLocalExec 时随机化 conversationId 和 sessionId

**文件**: `open-sse/executors/m365-copilot.js`

**根因**: M365 通过稳定的 `conversationId` 和 `sessionId` 关联多轮对话上下文。一旦某轮触发了 CI（Code Interpreter），后续轮次 M365 会"继承"CI 上下文，继续在沙箱中执行命令。即使 Deep experienceType + Precise tone 对新对话有效，但复用旧 conversationId 会让 M365 沿用之前的行为模式。

**修复**: 当 `needsLocalExec=true` 时，每次请求使用随机 `conversationId` 和 `sessionId`，确保 M365 将每次请求视为全新对话，不继承 CI 上下文。

**日志验证**:
- WS#1 (prompt_len=48424, 首次请求): `hasRemoteExec=true` — M365 初次请求自动触发 CI
- WS#2 (prompt_len=1939, tool_result后): `hasRemoteExec=true` — 复用 conversationId 导致继承 CI
- WS#3 (prompt_len=4757, tool_result后): `hasRemoteExec=true` — 同上
- WS#4 (prompt_len=1942, 新请求): `hasRemoteExec=false` — 新 conversationId 成功 ✅
- WS#5 (prompt_len=4757, tool_result后): `hasRemoteExec=false` — 新 conversationId 成功 ✅

### 修复12 (2026-07-14): 远程执行 fallback 不把 /mnt/ 路径当作命令

**文件**: `open-sse/translator/response/m365-copilot-to-openai.js` L184-190

**根因**: 当检测到远程执行结果但无 JSON tool_call 时，fallback 从 backtick 提取第一行作为命令。M365 远程执行结果可能是：

```
当前可访问的工作目录是：

```text
/mnt/data
```
```

提取第一行 `/mnt/data` 作为命令 → Codex 执行 → `zsh:1: no such file or directory: /mnt/data`。

**修复**: fallback 提取命令时，跳过以 `/mnt/` 开头的行（远程沙箱路径），回退到 `ls`。

### 修复13 (2026-07-14): 远程执行时 strip 掉全部文本，只保留 tool_calls

**文件**: `open-sse/translator/response/m365-copilot-to-openai.js` L233-247

**根因**: 当 M365 远程执行了命令（`hasRemoteExec=true`），响应翻译器提取了 tool_calls 后，还会把 `cleanContent`（strip tool patterns 后的文本）一起发给 Codex。但远程沙箱输出（如"当前可访问的工作目录是：/mnt/data"）对本地 agent 完全无意义，反而混淆 Codex（让它以为有本地结果）。

**修复**: `buildToolCallResults()` 增加 `isRemote` 参数。当 `isRemote=true` 时，**跳过 cleanContent**，只发送 tool_calls。Codex 收到 tool_call 后本地执行，得到正确的本地结果。

### 修复14 (2026-07-14): needsLocalExec 时随机化 conversationId/sessionId 调试增强

**文件**: `open-sse/executors/m365-copilot.js`

增加 `console.log` 调试输出 `[M365-SESSION-CHECK]` 和 `[M365-SESSION-RANDOM]`，确认随机化逻辑是否执行。

---

## 当前验证状态

| 场景 | 状态 |
|------|------|
| 远程执行检测 (`hasRemoteExec=true`) | OK |
| tool_call 提取 (`extracted toolCalls=1, names=exec_command`) | OK |
| 多流 fullText 不再重复 | OK (修复3) |
| `SHELL_TOOL_NAMES` 显式包含 `exec_command` | OK (修复5) |
| M365 收到 tool_result 后不再远程执行 | 待验证 (修复6-11，关键) |
| M365 回复 JSON tool_call 而非自然语言 | 待验证 (修复6-7) |
| 远程 fallback 不把 /mnt/ 路径当命令 | OK (修复12) |
| Codex 本地执行命令成功 | 待验证 |

---

## 待验证/后续事项

1. **清理 debug 日志**: `[M365-RESP-TRANSLATOR]`、`[M365-CLOSE]`、`[M365-CLOSE-FULL]` 等调试日志在问题解决后应移除
2. **M365 仍可能在初次请求时远程执行**: `disableCodeInterpreter=true` + Deep + Precise 对新对话有效，但 M365 对首次包含"执行命令"意图的请求仍可能自动触发 CI。reactive 检测+转换策略正确处理了这种情况。
3. ~~**`experienceType: "Deep"` 效果待验证**~~: 已验证有效（修复8+11），对 tool_result 后续请求 `hasRemoteExec=false` ✅
4. ~~**`SHELL_TOOL_NAMES` 缺 `exec_command`**~~: 已修复 (修复5)
5. ~~**远程结果 fallback 命令提取**~~: 已修复 (修复12)，跳过 `/mnt/` 路径
6. **docker cp 部署不持久**: 当前修改通过 `docker cp` 注入容器，容器重建后会丢失。需要在网络好时 `docker build -t 9router:local .` 本地构建镜像

---

## 关键架构说明

### 请求流程
```
Codex → OpenAI格式请求 → 9router
  → openai-to-m365-copilot.js (请求翻译)
    → buildToolMeta() 分类工具 (shell/file/search)
    → buildAntiExecutionPrompt() 生成禁执行指令
    → flattenMessages() / extractLatestUserInput() 扁平化消息
  → m365-copilot.js (WebSocket执行器)
    → bufferForTools=true 时缓冲全部文本
    → hasRemoteExec 检测远程执行结果
  → m365-copilot-to-openai.js (响应翻译)
    → extractToolCallsFromText() 从文本提取 tool_call
    → buildToolCallResults() 生成 OpenAI 格式 tool_call 响应
  → Codex 收到 tool_call → 本地执行 → 发回 tool_result → 循环
```

### M365 type:1 消息特性
- 每个 type:1 包含**完整累积文本**（从开头到当前位置），不是增量 delta
- 多个 bot 消息流通过 `messageId`/`responseIdentifier` 区分
- 流1: 标题/思考, 流2: 实际回答含远程执行结果
- type:2 (final message) 通常只含简短摘要

### Codex 工具映射
- Codex 工具名: `exec_command`, `write_stdin`, `update_goal`
- `SHELL_TOOL_NAMES` 已显式包含 `exec_command` (修复5)
- `classifyTool()` 通过 `n.includes("exec")` 兜底匹配其他 exec 类工具
- Shell 工具触发 `needsLocalExec=true` → 注入 anti-exec prompt → `bufferForTools=true`

### Docker 日志分析 (2026-07-14)

3轮交互流程：
1. 第1轮(Codex初始请求) → M365 远程执行 `pwd && ls -la` → `hasRemoteExec=true` → 提取 `exec_command` tool_call → Codex 收到 tool_call
2. Codex 本地执行 → 发回 tool_result → M365 **又远程执行** → `hasRemoteExec=true` → 提取 tool_call
3. Codex 本地执行 → 发回 tool_result → M365 没远程执行(`hasRemoteExec=false`)，但也没输出 JSON tool_call → `extracted toolCalls=0` → 流结束

第2轮问题：anti-exec prompt 虽然注入了，但 M365 服务端仍然触发 CI
第3轮问题：M365 没远程执行也没输出 JSON，而是用中文自然语言解释错误
