import { createHash } from "crypto";
import { FORMATS } from "../formats.js";
import { register } from "../index.js";

const ROLE = { SYSTEM: "system", DEVELOPER: "developer", USER: "user", ASSISTANT: "assistant", TOOL: "tool" };
const SEEN_CONV_MAX = 500;
const SEEN_CONV_TTL_MS = 30 * 60 * 1000;
const seenConversationFingerprints = new Map();

function getConversationFingerprint(messages) {
  for (const m of messages) {
    if (m.role === ROLE.USER) {
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
      return text.slice(0, 120);
    }
  }
  return null;
}

function computeConversationId(fingerprint, connectionId) {
  const base = fingerprint
    ? `${connectionId || "fc"}:conv:${createHash("sha256").update(fingerprint).digest("hex").slice(0, 16)}`
    : `${connectionId || "fc"}`;
  const hash = createHash("sha256").update(base).digest("hex");
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`;
}

function markConversationSeen(conversationId) {
  seenConversationFingerprints.set(conversationId, Date.now());
  if (seenConversationFingerprints.size > SEEN_CONV_MAX) {
    const now = Date.now();
    for (const [k, ts] of seenConversationFingerprints) {
      if (now - ts > SEEN_CONV_TTL_MS) seenConversationFingerprints.delete(k);
    }
    if (seenConversationFingerprints.size > SEEN_CONV_MAX) {
      const entries = [...seenConversationFingerprints.entries()].sort((a, b) => a[1] - b[1]);
      for (let i = 0; i < entries.length - SEEN_CONV_MAX / 2; i++) {
        seenConversationFingerprints.delete(entries[i][0]);
      }
    }
  }
}

function isConversationSeen(conversationId) {
  const ts = seenConversationFingerprints.get(conversationId);
  if (!ts) return false;
  if (Date.now() - ts > SEEN_CONV_TTL_MS) {
    seenConversationFingerprints.delete(conversationId);
    return false;
  }
  return true;
}

function extractContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(p => p.type === "text" && p.text)
      .map(p => p.text)
      .join("\n");
  }
  return JSON.stringify(content);
}

function detectUserLanguage(messages) {
  const cjkRe = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === ROLE.USER) {
      const text = extractContent(messages[i].content);
      const cjk = (text.match(cjkRe) || []).length;
      if (cjk > 5) return "zh";
    }
  }
  return "en";
}

function flattenMessages(messages) {
  const parts = [];
  console.log(`[FC-REQ-FLATTEN] total_messages=${messages.length}`);

  for (let idx = 0; idx < messages.length; idx++) {
    const msg = messages[idx];
    const role = msg.role || "";
    const preview = (typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "")).slice(0, 80).replace(/\n/g, "\\n");

    if (role === ROLE.SYSTEM || role === ROLE.DEVELOPER) {
      const text = extractContent(msg.content);
      if (text) parts.push(`[System]: ${text}`);
      continue;
    }

    if (role === ROLE.USER) {
      const text = extractContent(msg.content);
      if (text) parts.push(`[User]: ${text}`);
      continue;
    }

    if (role === ROLE.ASSISTANT) {
      const text = extractContent(msg.content);
      const toolParts = [];
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const tcName = tc.function?.name || "unknown";
          const tcArgs = tc.function?.arguments || "{}";
          try {
            const parsed = JSON.parse(tcArgs);
            const cmd = parsed.command || parsed.cmd || parsed.code || JSON.stringify(parsed);
            toolParts.push(`I ran: ${cmd}`);
          } catch {
            toolParts.push(`I ran: ${tcArgs}`);
          }
        }
      }
      const textParts = [];
      if (text) textParts.push(text);
      if (toolParts.length > 0) textParts.push(...toolParts);
      if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
      continue;
    }

    if (role === ROLE.TOOL) {
      const tcName = msg.tool_call_id ? "tool" : "tool";
      const result = extractContent(msg.content) || msg.content || "";
      const resultStr = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      parts.push(`[Output]: ${resultStr}`);
      continue;
    }
  }

  const result = parts.join("\n\n");
  console.log(`[FC-REQ-FLATTEN] result_len=${result.length} parts=${parts.length}`);
  return result;
}

function openaiToM365FoldcraftRequest(body, format) {
  const messages = body.messages || [];
  const fingerprint = getConversationFingerprint(messages);
  const connectionId = body._connectionId || null;
  const conversationId = fingerprint ? computeConversationId(fingerprint, connectionId) : null;

  const isContinuation = conversationId ? isConversationSeen(conversationId) : false;
  if (conversationId) markConversationSeen(conversationId);

  const lang = detectUserLanguage(messages);
  const langHint = lang === "zh" ? "Reply in Chinese (中文)." : "";

  const flatMessages = flattenMessages(messages);
  let prompt = flatMessages;
  if (langHint) prompt = `${langHint}\n\n${prompt}`;

  console.log(`[FC-REQ-TRANSLATE] FINAL: isContinuation=${isContinuation} prompt_len=${prompt.length} lang=${lang}`);

  return {
    ...body,
    messages: [],
    _m365Prompt: prompt,
    _m365IsContinuation: isContinuation,
    _m365ToolMeta: { hasTools: false, needsLocalExec: false, hasSearchTools: false },
    stream: true,
  };
}

register(FORMATS.OPENAI, FORMATS.M365_FOLDCRAFT, openaiToM365FoldcraftRequest, null);
