import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import WsClient from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";

const M365_WS_BASE = "wss://substrate.office.com/m365chat/SecuredChathub";
const M365_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const WS_CONNECT_TIMEOUT_MS = 15_000;
const WS_RESPONSE_TIMEOUT_MS = 120_000;

// X-variants features from the M365 Business Chat web app
const M365_X_VARIANTS = [
  "feature.includeExternal",
  "feature.AssistantConnectorsContentSources",
  "3S.BizChatWprBoostAssistant",
  "3S.EnableMEFromSkillDiscovery",
  "feature.EnableAuthErrorMessage",
  "EnableRequestPlugins",
  "feature.EnableSensitivityLabels",
  "feature.IsEntityAnnotationsEnabled",
  "EnableUnsupportedUrlDetector",
].join(",");

/**
 * Decode JWT payload (no verification, just extract claims)
 */
function decodeJwtPayload(token) {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * Extract oid and tid from access token
 */
function extractTokenClaims(token) {
  const claims = decodeJwtPayload(token);
  if (!claims) return { oid: "unknown", tid: "unknown" };
  return {
    oid: claims.oid || claims.sub || "unknown",
    tid: claims.tid || "unknown",
  };
}

/**
 * Parse OpenAI messages into a single user query string + conversation history
 */
function parseOpenAIMessages(messages) {
  const extracted = [];
  for (const msg of messages) {
    let role = String(msg.role || "user");
    if (role === "developer") role = "system";
    let content = "";
    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content.filter((c) => c.type === "text").map((c) => String(c.text || "")).join(" ");
    }
    if (!content.trim()) continue;
    extracted.push({ role, text: content });
  }

  // Find last user message
  let lastUserIdx = -1;
  for (let i = extracted.length - 1; i >= 0; i--) {
    if (extracted[i].role === "user") { lastUserIdx = i; break; }
  }

  // Build context: prepend system + history as context, send last user message as prompt
  const contextParts = [];
  let userPrompt = "";
  for (let i = 0; i < extracted.length; i++) {
    const { role, text } = extracted[i];
    if (i === lastUserIdx) {
      userPrompt = text;
    } else {
      contextParts.push(`${role}: ${text}`);
    }
  }

  // If there's context, prepend it
  if (contextParts.length > 0 && userPrompt) {
    userPrompt = contextParts.join("\n\n") + "\n\nuser: " + userPrompt;
  }

  return userPrompt;
}

/**
 * Build Copilot WebSocket message frame
 */
/**
 * Map model ID to M365 Copilot model family option
 * M365 backend uses optionsSets / options to route to different model backends
 */
function resolveCopilotModelOptions(modelId) {
  const normalized = (modelId || "copilot").toLowerCase();
  // Map of model IDs to their optionsSets and gptModelFamily
  const modelMap = {
    "gpt-5.5": { optionsSets: ["galileo"], options: { gptModelFamily: "gpt-5.5" } },
    "gpt-5.4": { optionsSets: ["galileo"], options: { gptModelFamily: "gpt-5.4" } },
    "gpt-5.4-mini": { optionsSets: ["galileo"], options: { gptModelFamily: "gpt-5.4-mini" } },
    "gpt-5.2": { optionsSets: ["galileo"], options: { gptModelFamily: "gpt-5.2" } },
    "gpt-5": { optionsSets: ["galileo"], options: { gptModelFamily: "gpt-5" } },
    "gpt-5-mini": { optionsSets: ["galileo"], options: { gptModelFamily: "gpt-5-mini" } },
    "gpt-4o": { optionsSets: [], options: { gptModelFamily: "gpt-4o" } },
    "gpt-4.1": { optionsSets: [], options: { gptModelFamily: "gpt-4.1" } },
    "o3": { optionsSets: ["reasoning"], options: { gptModelFamily: "o3" } },
    "o4-mini": { optionsSets: ["reasoning"], options: { gptModelFamily: "o4-mini" } },
  };
  return modelMap[normalized] || { optionsSets: [], options: {} };
}

function buildCopilotMessage(text, invocationId, conversationId, sessionId, modelId) {
  const { optionsSets: modelOptionSets, options: modelOptions } = resolveCopilotModelOptions(modelId);
  const baseOptionsSets = ["enterprise_flux_handoff_outlook_compose"];
  const optionsSets = [...baseOptionsSets, ...modelOptionSets];

  return {
    arguments: [{
      source: "officeweb",
      clientCorrelationId: crypto.randomUUID(),
      sessionId,
      optionsSets,
      options: { ...modelOptions },
      allowedMessageTypes: [
        "Chat", "Suggestion", "InternalSearchQuery", "InternalSearchResult",
        "Disengaged", "InternalLoaderMessage", "RenderCardRequest",
        "AdsQuery", "SemanticSerp", "GenerateContentQuery", "SearchQuery",
        "ConfirmationCard", "AuthError", "DeveloperLogs",
      ],
      sliceIds: [],
      threadLevelGptId: {},
      conversationId,
      traceId: crypto.randomUUID(),
      isStartOfSession: invocationId === 0,
      productThreadType: "Office",
      clientInfo: { clientPlatform: "web" },
      message: {
        author: "user",
        inputMethod: "Keyboard",
        text,
        entityAnnotationTypes: ["People", "File", "Event"],
        requestId: crypto.randomUUID(),
        locationInfo: {
          timeZoneOffset: new Date().getTimezoneOffset() / -60,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        },
        locale: "en-US",
        messageType: "Chat",
        experienceType: "Default",
      },
      plugins: [{ Id: "BingWebSearch", Source: "BuiltIn" }],
    }],
    invocationId: String(invocationId),
    target: "chat",
    type: 4,
  };
}

function sseChunk(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/**
 * Build streaming SSE response from WebSocket messages
 */
function buildStreamingFromWs(ws, model, cid, created, signal) {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      // Send initial role chunk
      controller.enqueue(encoder.encode(sseChunk({
        id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null, logprobs: null }],
      })));

      let fullText = "";
      let closed = false;

      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.enqueue(encoder.encode(sseChunk({
            id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
            choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }],
          })));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch { /* already closed */ }
        controller.close();
        try { ws.close(); } catch { /* already closed */ }
      };

      const sendError = (msg) => {
        if (closed) return;
        controller.enqueue(encoder.encode(sseChunk({
          id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
          choices: [{ index: 0, delta: { content: `[Error: ${msg}]` }, finish_reason: null, logprobs: null }],
        })));
        close();
      };

      // Timeout for response
      const responseTimer = setTimeout(() => {
        if (!closed) sendError("M365 Copilot response timed out");
      }, WS_RESPONSE_TIMEOUT_MS);

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(typeof event.data === "string" ? event.data : "");
          // Type 1: intermediate streaming text
          if (data.type === 1 && data.item?.messages) {
            for (const msg of data.item.messages) {
              if (msg.text && msg.author === "bot") {
                const delta = msg.text.slice(fullText.length);
                if (delta) {
                  fullText = msg.text;
                  controller.enqueue(encoder.encode(sseChunk({
                    id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
                    choices: [{ index: 0, delta: { content: delta }, finish_reason: null, logprobs: null }],
                  })));
                }
              }
            }
          }
          // Type 2: final complete message
          if (data.type === 2 && data.item?.messages) {
            for (const msg of data.item.messages) {
              if (msg.text && msg.author === "bot" && msg.text.length > fullText.length) {
                const delta = msg.text.slice(fullText.length);
                fullText = msg.text;
                if (delta) {
                  controller.enqueue(encoder.encode(sseChunk({
                    id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
                    choices: [{ index: 0, delta: { content: delta }, finish_reason: null, logprobs: null }],
                  })));
                }
              }
            }
            // Check for result message (some variants use item.result)
            if (data.item.result?.value && data.item.result.value !== "Success") {
              sendError(data.item.result.message || data.item.result.value);
              return;
            }
          }
          // Type 3: end of conversation turn
          if (data.type === 3) {
            clearTimeout(responseTimer);
            close();
          }
          // Error from server
          if (data.type === 2 && data.item?.result?.value === "Throttled") {
            sendError("M365 Copilot rate limited (Throttled)");
          }
        } catch {
          // Non-JSON frames (e.g. empty init response) — ignore
        }
      };

      ws.onerror = (err) => {
        clearTimeout(responseTimer);
        sendError(`WebSocket error: ${err?.message || String(err)}`);
      };

      ws.onclose = () => {
        clearTimeout(responseTimer);
        close();
      };

      // Handle client abort
      if (signal) {
        signal.addEventListener("abort", () => {
          clearTimeout(responseTimer);
          close();
        }, { once: true });
      }
    },
  });
}

/**
 * Build non-streaming response by collecting full text from WebSocket
 */
async function buildNonStreamingFromWs(ws, model, cid, created, signal) {
  return new Promise((resolve) => {
    let fullText = "";
    const thinkingParts = [];

    const responseTimer = setTimeout(() => {
      try { ws.close(); } catch {}
      resolve(new Response(JSON.stringify({
        error: { message: "M365 Copilot response timed out", type: "upstream_error", code: "TIMEOUT" },
      }), { status: 504, headers: { "Content-Type": "application/json" } }));
    }, WS_RESPONSE_TIMEOUT_MS);

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(typeof event.data === "string" ? event.data : "");
        if (data.type === 1 && data.item?.messages) {
          for (const msg of data.item.messages) {
            if (msg.text && msg.author === "bot" && msg.text.length > fullText.length) {
              fullText = msg.text;
            }
          }
        }
        if (data.type === 2 && data.item?.messages) {
          for (const msg of data.item.messages) {
            if (msg.text && msg.author === "bot" && msg.text.length > fullText.length) {
              fullText = msg.text;
            }
          }
          if (data.item.result?.value && data.item.result.value !== "Success") {
            clearTimeout(responseTimer);
            try { ws.close(); } catch {}
            resolve(new Response(JSON.stringify({
              error: { message: data.item.result.message || data.item.result.value, type: "upstream_error", code: "COPILOT_ERROR" },
            }), { status: 502, headers: { "Content-Type": "application/json" } }));
            return;
          }
        }
        if (data.type === 3) {
          clearTimeout(responseTimer);
          try { ws.close(); } catch {}
          const promptTokens = Math.ceil(fullText.length / 4);
          const completionTokens = Math.ceil(fullText.length / 4);
          const msg = { role: "assistant", content: fullText };
          resolve(new Response(JSON.stringify({
            id: cid, object: "chat.completion", created, model, system_fingerprint: null,
            choices: [{ index: 0, message: msg, finish_reason: "stop", logprobs: null }],
            usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
          }), { status: 200, headers: { "Content-Type": "application/json" } }));
        }
      } catch { /* ignore non-JSON frames */ }
    };

    ws.onerror = (err) => {
      clearTimeout(responseTimer);
      try { ws.close(); } catch {}
      resolve(new Response(JSON.stringify({
        error: { message: `WebSocket error: ${err?.message || String(err)}`, type: "upstream_error", code: "WS_ERROR" },
      }), { status: 502, headers: { "Content-Type": "application/json" } }));
    };

    ws.onclose = () => {
      clearTimeout(responseTimer);
      if (fullText) {
        const promptTokens = Math.ceil(fullText.length / 4);
        const completionTokens = Math.ceil(fullText.length / 4);
        resolve(new Response(JSON.stringify({
          id: cid, object: "chat.completion", created, model, system_fingerprint: null,
          choices: [{ index: 0, message: { role: "assistant", content: fullText }, finish_reason: "stop", logprobs: null }],
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
    };

    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(responseTimer);
        try { ws.close(); } catch {}
        resolve(new Response(JSON.stringify({
          error: { message: "Request aborted", type: "upstream_error", code: "ABORTED" },
        }), { status: 499, headers: { "Content-Type": "application/json" } }));
      }, { once: true });
    }
  });
}

export class M365CopilotExecutor extends BaseExecutor {
  constructor() {
    super("m365-copilot", PROVIDERS["m365-copilot"]);
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const messages = body?.messages;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return this._errorResponse("Missing or empty messages array", 400, "invalid_request");
    }

    // Extract access token
    const accessToken = credentials.accessToken || credentials.apiKey;
    if (!accessToken) {
      return this._errorResponse(
        "M365 Copilot access token is required. Extract it from your browser (substrate.office.com in localStorage) or use the token extraction tool.",
        401, "auth_required"
      );
    }

    // Parse user prompt
    const userPrompt = parseOpenAIMessages(messages);
    if (!userPrompt.trim()) {
      return this._errorResponse("Empty query after processing", 400, "invalid_request");
    }

    // Extract user identity from token
    const { oid, tid } = extractTokenClaims(accessToken);
    const sessionId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const clientRequestId = crypto.randomUUID();

    // Build WebSocket URL following the M365 Copilot protocol
    // Ref: https://labs.zenity.io/p/access-copilot-m365-terminal
    // URL format: wss://substrate.office.com/m365chat/SecuredChathub/{oid}@{tid}?params...
    const wsParams = new URLSearchParams({
      "X-ClientRequestId": clientRequestId,
      "X-SessionId": sessionId,
      "access_token": accessToken,
      "X-variants": M365_X_VARIANTS,
      "source": '"officeweb"',
      "scenario": "officeweb",
    });
    const wsUrl = `${M365_WS_BASE}/${encodeURIComponent(oid)}@${encodeURIComponent(tid)}?${wsParams.toString()}`;

    log?.info?.("M365-COPILOT", `Connecting WebSocket: oid=${oid.slice(0, 8)}..., tid=${tid.slice(0, 8)}..., model=${model}, prompt_len=${userPrompt.length}`);

    // Open WebSocket connection (proxy-aware via https-proxy-agent)
    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    let ws;

    try {
      const wsOpts = { headers: { "User-Agent": M365_USER_AGENT } };
      if (proxyUrl) {
        log?.info?.("M365-COPILOT", `Using HTTP proxy: ${proxyUrl}`);
        wsOpts.agent = new HttpsProxyAgent(proxyUrl);
      }
      ws = new WsClient(wsUrl, [], wsOpts);
    } catch (err) {
      return this._errorResponse(`WebSocket creation failed: ${err.message}`, 502, "upstream_error");
    }

    // Wait for connection open (ws library API)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error("WebSocket connection timed out"));
      }, WS_CONNECT_TIMEOUT_MS);

      ws.on("open", () => { clearTimeout(timer); resolve(); });
      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`WebSocket error: ${err.message || err}`));
      });
    }).catch((err) => {
      log?.error?.("M365-COPILOT", `WebSocket connect failed: ${err.message}`);
      return this._errorResponse(`M365 Copilot connection failed: ${err.message}`, 502, "upstream_error");
    });

    if (ws.readyState !== WsClient.OPEN) {
      return this._errorResponse("M365 Copilot WebSocket failed to connect", 502, "upstream_error");
    }

    // Adapt ws library API: wrap onmessage for streaming code
    // ws library emits 'message' event; existing code uses ws.onmessage = fn
    ws.on("message", (data) => {
      if (ws.onmessage) ws.onmessage({ data: typeof data === "string" ? data : data.toString() });
    });
    ws.on("close", (code, reason) => {
      if (ws.onclose) ws.onclose({ code, reason: reason?.toString() || "" });
    });
    ws.on("error", (err) => {
      if (ws.onerror) ws.onerror({ message: err.message });
    });

    // Send protocol init frame
    ws.send(JSON.stringify({ protocol: "json", version: 1 }));

    // Wait briefly for server ack, then send ping + user message
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Send keep-alive ping (type 6)
    ws.send(JSON.stringify({ type: 6 }));

    // Send user message
    const copilotMsg = buildCopilotMessage(userPrompt, 0, conversationId, sessionId, model);
    ws.send(JSON.stringify(copilotMsg));

    log?.info?.("M365-COPILOT", `Message sent (model=${model}), waiting for response stream`);

    const cid = `chatcmpl-m365-${crypto.randomUUID().slice(0, 12)}`;
    const created = Math.floor(Date.now() / 1000);

    let finalResponse;
    if (stream) {
      const sseStream = buildStreamingFromWs(ws, model, cid, created, signal);
      finalResponse = new Response(sseStream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
      });
    } else {
      finalResponse = await buildNonStreamingFromWs(ws, model, cid, created, signal);
    }

    return { response: finalResponse, url: M365_WS_BASE, headers: {}, transformedBody: copilotMsg };
  }

  _errorResponse(message, status, code) {
    const errResp = new Response(JSON.stringify({
      error: { message, type: code || "upstream_error", code: code || `HTTP_${status}` },
    }), { status, headers: { "Content-Type": "application/json" } });
    return { response: errResp, url: M365_WS_BASE, headers: {}, transformedBody: null };
  }
}

export default M365CopilotExecutor;
