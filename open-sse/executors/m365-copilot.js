import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import WsClient from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";

const M365_WS_BASE = "wss://substrate.office.com/m365Copilot/Chathub";
const M365_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.3.1 Safari/605.1.15";
const WS_CONNECT_TIMEOUT_MS = 15_000;
const WS_RESPONSE_TIMEOUT_MS = 120_000;

// Feature variants from the current M365 Copilot web app (2025-06)
const M365_VARIANTS = [
  "EnableMcpServerWidgets", "feature.EnableMcpServerWidgets",
  "feature.EnableLuForChatCIQ", "feature.enableChatCIQPlugin",
  "EnableRequestPlugins", "feature.EnableSensitivityLabels",
  "EnableUnsupportedUrlDetector", "feature.IsCustomEngineCopilotEnabled",
  "feature.bizchatfluxv3", "feature.enablechatpages", "feature.enableCodeCanvas",
  "feature.turnOnWorkTabRecommendation", "feature.turnOnDARecommendation",
  "feature.IsStreamingModeInChatRequestEnabled",
  "IncludeSourceAttributionsConcise", "SkipPublishEmptyMessage",
  "feature.EnableDeduplicatingSourceAttributions",
  "Enable3PActionProgressMessages", "feature.EnableCIQDesktopDisplay",
  "feature.enableClientWebRtc", "feature.EnableMeetingRecapOfSeriesMeetingWithCiq",
  "feature.EnableReferencesListCompleteSignal", "feature.StorageMessageSplitDisabled",
  "feature.EnableCuaTakeControlApi",
  "agt_bizchat_enablePagesCitations", "agt_bizchat_enablePagesCitationsForMultiturn",
  "feature.cwcallowedos", "feature.EnableMergingPureDeltas",
  "feature.disabledisallowedmsgs", "feature.enableCitationsForSynthesisData",
  "feature.EnableConversationShareApis", "feature.enableGenerateGraphicArtOptionsSet",
  "cdximagen", "feature.EnableUpdatedUXForConfirmationDialog",
  "feature.EnableContentApiandDocTypeHtmlInRichAnswers",
  "cdxgrounding_api_v2_rich_web_answers_reference_bottom_force",
  "cdxenablerenderforisocomp",
  "feature.EnableClientFileURLSupportForOfficeWebPaidCopilot",
  "feature.EnableDesignEditorImageGrounding", "feature.EnableDesignerEditor",
  "feature.EnableSkipRehydrationForSpeCIdImages", "feature.EnablePersonalization",
  "agt_bizchat_enableRichResponses", "feature.EnableBase64DataInMessageAnnotations",
  "feature.EnableSkipEmittingMessageOnFlush", "feature.EnableRemoveEmptySourceAttributions",
  "feature.EnableRemoveStreamingMode",
  "feature.OfficeWebToHelix", "feature.OfficeDesktopToHelix",
  "feature.M365TeamsHubToHelix", "feature.OwaHubToHelix",
  "feature.MonarchHubToHelix", "feature.Win32OutlookHubToHelix",
  "feature.MacOutlookHubToHelix", "Agt_bizchat_enableGpt5ForHelix",
].join(",");

/** Decode JWT payload (no verification, just extract claims) */
function decodeJwtPayload(token) {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
  } catch { return null; }
}

/** Extract oid and tid from access token */
function extractTokenClaims(token) {
  const claims = decodeJwtPayload(token);
  if (!claims) return { oid: "unknown", tid: "unknown" };
  return { oid: claims.oid || claims.sub || "unknown", tid: claims.tid || "unknown" };
}

/** Parse OpenAI messages into a single user query string */
function parseOpenAIMessages(messages) {
  const extracted = [];
  for (const msg of messages) {
    let role = String(msg.role || "user");
    if (role === "developer") role = "system";
    let content = "";
    if (typeof msg.content === "string") content = msg.content;
    else if (Array.isArray(msg.content)) content = msg.content.filter((c) => c.type === "text").map((c) => String(c.text || "")).join(" ");
    if (!content.trim()) continue;
    extracted.push({ role, text: content });
  }
  let lastUserIdx = -1;
  for (let i = extracted.length - 1; i >= 0; i--) {
    if (extracted[i].role === "user") { lastUserIdx = i; break; }
  }
  const contextParts = [];
  let userPrompt = "";
  for (let i = 0; i < extracted.length; i++) {
    const { role, text } = extracted[i];
    if (i === lastUserIdx) userPrompt = text;
    else contextParts.push(`${role}: ${text}`);
  }
  if (contextParts.length > 0 && userPrompt) {
    userPrompt = contextParts.join("\n\n") + "\n\nuser: " + userPrompt;
  }
  return userPrompt;
}

/** Map model ID to M365 Copilot model family options */
function resolveCopilotModelOptions(modelId) {
  const normalized = (modelId || "copilot").toLowerCase();
  const modelMap = {
    "gpt-5.5": { optionsSets: ["galileo"], options: { gptModelFamily: "gpt-5.5" } },
    "gpt-5.2": { optionsSets: ["galileo"], options: { gptModelFamily: "gpt-5.2" } },
  };
  return modelMap[normalized] || { optionsSets: [], options: {} };
}

function buildCopilotMessage(text, invocationId, conversationId, sessionId, modelId) {
  const { optionsSets: modelOptionSets, options: modelOptions } = resolveCopilotModelOptions(modelId);
  return {
    arguments: [{
      source: "officeweb",
      clientCorrelationId: crypto.randomUUID(),
      sessionId,
      optionsSets: ["enterprise_flux_handoff_outlook_compose", ...modelOptionSets],
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
 * Safely parse a SignalR text payload that may contain multiple JSON records
 * separated by \u001e (Record Separator). Returns array of parsed objects.
 */
function parseSignalRRecords(rawText) {
  // Convert to string, strip all RS characters, then split on RS boundaries
  const str = typeof rawText === "string" ? rawText : String(rawText);
  // Split by \u001e to handle multi-record frames: "JSON1\u001eJSON2\u001e" → ["JSON1","JSON2",""]
  const parts = str.split("\u001e");
  const results = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      results.push(JSON.parse(trimmed));
    } catch {
      // Retry after stripping embedded control chars (0x00-0x1F except \t \n \r)
      try {
        results.push(JSON.parse(trimmed.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")));
      } catch { /* skip unparseable records */ }
    }
  }
  return results;
}

/**
 * Build streaming SSE response from WebSocket messages
 */
function buildStreamingFromWs(ws, model, cid, created, signal) {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
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

      const responseTimer = setTimeout(() => {
        if (!closed) sendError("M365 Copilot response timed out");
      }, WS_RESPONSE_TIMEOUT_MS);

      const processData = (data) => {
        // Type 1: streaming text updates
        if (data.type === 1) {
          const payload = data.item || data.arguments?.[0];
          if (payload?.messages) {
            for (const msg of payload.messages) {
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
        }
        // Type 2: final complete message (M365 completion signal)
        if (data.type === 2) {
          const payload = data.item || data.arguments?.[0];
          if (payload?.messages) {
            for (const msg of payload.messages) {
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
          }
          // Check for errors (including Throttled) BEFORE closing
          if (payload?.result?.value && payload.result.value !== "Success") {
            sendError(payload.result.message || payload.result.value);
            return;
          }
          clearTimeout(responseTimer);
          close();
          return;
        }
        // Type 3: end of conversation turn
        if (data.type === 3) {
          clearTimeout(responseTimer);
          close();
        }
      };

      ws.onmessage = (event) => {
        const records = parseSignalRRecords(event.data);
        for (const data of records) processData(data);
      };

      ws.onerror = (err) => {
        clearTimeout(responseTimer);
        sendError(`WebSocket error: ${err?.message || String(err)}`);
      };

      ws.onclose = () => {
        clearTimeout(responseTimer);
        close();
      };

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
async function buildNonStreamingFromWs(ws, model, cid, created, signal, log, messageBuffer) {
  return new Promise((resolve) => {
    let fullText = "";
    let resolved = false;

    const doResolve = (response) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(responseTimer);
      try { ws.close(); } catch {}
      resolve(response);
    };

    const responseTimer = setTimeout(() => {
      doResolve(new Response(JSON.stringify({
        error: { message: "M365 Copilot response timed out", type: "upstream_error", code: "TIMEOUT" },
      }), { status: 504, headers: { "Content-Type": "application/json" } }));
    }, WS_RESPONSE_TIMEOUT_MS);

    const makeCompletionResponse = () => {
      const promptTokens = Math.ceil(fullText.length / 4);
      const completionTokens = Math.ceil(fullText.length / 4);
      return new Response(JSON.stringify({
        id: cid, object: "chat.completion", created, model, system_fingerprint: null,
        choices: [{ index: 0, message: { role: "assistant", content: fullText }, finish_reason: "stop", logprobs: null }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const processData = (data) => {
      // Type 1: streaming text updates
      if (data.type === 1) {
        const payload = data.item || data.arguments?.[0];
        if (payload?.messages) {
          for (const msg of payload.messages) {
            if (msg.text && msg.author === "bot" && msg.text.length > fullText.length) {
              fullText = msg.text;
            }
          }
        }
      }
      // Type 2: final complete message (M365 completion signal)
      if (data.type === 2) {
        const payload = data.item || data.arguments?.[0];
        if (payload?.messages) {
          for (const msg of payload.messages) {
            if (msg.text && msg.author === "bot" && msg.text.length > fullText.length) {
              fullText = msg.text;
            }
          }
        }
        if (payload?.result?.value && payload.result.value !== "Success") {
          doResolve(new Response(JSON.stringify({
            error: { message: payload.result.message || payload.result.value, type: "upstream_error", code: "COPILOT_ERROR" },
          }), { status: 502, headers: { "Content-Type": "application/json" } }));
          return;
        }
        doResolve(makeCompletionResponse());
        return;
      }
      // Type 3: end of conversation turn
      if (data.type === 3) {
        doResolve(makeCompletionResponse());
      }
    };

    const handleMessage = (rawText) => {
      const records = parseSignalRRecords(rawText);
      for (const data of records) {
        processData(data);
        if (resolved) return;
      }
    };

    // Set ws.onmessage to forward to handleMessage
    ws.onmessage = (event) => handleMessage(typeof event.data === "string" ? event.data : "");

    ws.onerror = (err) => {
      doResolve(new Response(JSON.stringify({
        error: { message: `WebSocket error: ${err?.message || String(err)}`, type: "upstream_error", code: "WS_ERROR" },
      }), { status: 502, headers: { "Content-Type": "application/json" } }));
    };

    ws.onclose = () => {
      if (fullText) doResolve(makeCompletionResponse());
    };

    if (signal) {
      signal.addEventListener("abort", () => {
        doResolve(new Response(JSON.stringify({
          error: { message: "Request aborted", type: "upstream_error", code: "ABORTED" },
        }), { status: 499, headers: { "Content-Type": "application/json" } }));
      }, { once: true });
    }

    // Process buffered messages (race condition fix)
    for (const buf of messageBuffer) {
      handleMessage(buf);
      if (resolved) return;
    }
    messageBuffer.length = 0;
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

    const accessToken = credentials.accessToken || credentials.apiKey;
    if (!accessToken) {
      return this._errorResponse(
        "M365 Copilot access token is required. Extract it from your browser (substrate.office.com in localStorage) or use the token extraction tool.",
        401, "auth_required"
      );
    }

    const userPrompt = parseOpenAIMessages(messages);
    if (!userPrompt.trim()) {
      return this._errorResponse("Empty query after processing", 400, "invalid_request");
    }

    const { oid, tid } = extractTokenClaims(accessToken);

    // Build WebSocket URL matching browser behavior (2025-06)
    const rawHex = crypto.randomUUID().replace(/-/g, "");
    const sessionIdHex = rawHex;
    const sessionIdUuid = `${rawHex.slice(0,8)}-${rawHex.slice(8,12)}-${rawHex.slice(12,16)}-${rawHex.slice(16,20)}-${rawHex.slice(20)}`;
    const conversationId = crypto.randomUUID();

    const wsParams = new URLSearchParams({
      "chatsessionid": sessionIdHex,
      "XRoutingParameterSessionKey": sessionIdHex,
      "clientrequestid": sessionIdHex,
      "X-SessionId": sessionIdUuid,
      "ConversationId": conversationId,
      "access_token": accessToken,
      "variants": M365_VARIANTS,
      "source": '"officeweb"',
      "product": "Office",
      "agentHost": "Bizchat.FullScreen",
      "licenseType": "Starter",
      "isEdu": "false",
      "agent": "web",
      "scenario": "OfficeWebIncludedCopilot",
    });
    const wsUrl = `${M365_WS_BASE}/${encodeURIComponent(oid)}@${encodeURIComponent(tid)}?${wsParams.toString()}`;

    log?.info?.("M365-COPILOT", `Connecting WebSocket: oid=${oid.slice(0, 8)}..., tid=${tid.slice(0, 8)}..., model=${model}, prompt_len=${userPrompt.length}`);

    // Open WebSocket connection
    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    let ws;

    try {
      const wsHeaders = {
        "User-Agent": M365_USER_AGENT,
        "Origin": "https://m365.cloud.microsoft",
        "Sec-Fetch-Dest": "websocket",
        "Sec-Fetch-Mode": "websocket",
        "Sec-Fetch-Site": "cross-site",
      };
      const wsOpts = { headers: wsHeaders };

      if (proxyUrl) {
        log?.info?.("M365-COPILOT", `Using HTTP proxy: ${proxyUrl}`);
        wsOpts.agent = new HttpsProxyAgent(proxyUrl);
      }

      ws = new WsClient(wsUrl, [], wsOpts);
    } catch (err) {
      log?.error?.("M365-COPILOT", `WebSocket connect failed: ${err.message}`);
      return this._errorResponse(`M365 Copilot connection failed: ${err.message}`, 502, "upstream_error");
    }

    // Wait for WebSocket open
    const connectError = await new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        resolvePromise("WebSocket connection timed out");
      }, WS_CONNECT_TIMEOUT_MS);
      ws.on("open", () => { clearTimeout(timer); resolvePromise(null); });
      ws.on("unexpected-response", (req, res) => {
        clearTimeout(timer);
        const hdrs = {};
        for (const [k, v] of Object.entries(res.headers || {})) {
          if (k.startsWith('x-')) hdrs[k] = v;
        }
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolvePromise(`HTTP ${res.statusCode}: ${JSON.stringify(hdrs)}, body=${body.slice(0, 200)}`));
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        resolvePromise(`WebSocket error: ${err.message || err}`);
      });
    });

    if (connectError) {
      log?.error?.("M365-COPILOT", `WebSocket connect failed: ${connectError}`);
      return this._errorResponse(`M365 Copilot connection failed: ${connectError}`, 502, "upstream_error");
    }

    log?.info?.("M365-COPILOT", `WS readyState=${ws.readyState}, sending SignalR handshake`);

    const RS = "\u001e";

    // Send protocol handshake
    ws.send(JSON.stringify({ protocol: "json", version: 1 }) + RS);

    // Wait for server handshake ack: {}\u001e
    const handshakeError = await new Promise((resolvePromise) => {
      const ackTimer = setTimeout(() => resolvePromise("SignalR handshake timeout (10s)"), 10_000);
      const onAck = (data) => {
        const text = typeof data === "string" ? data : data.toString();
        log?.info?.("M365-COPILOT", `WS handshake ack: ${text.slice(0, 100)}`);
        const payload = text.replace(/\u001e/g, "").trim();
        if (payload) {
          try {
            const parsed = JSON.parse(payload);
            if (parsed.error) {
              clearTimeout(ackTimer);
              ws.removeListener("message", onAck);
              resolvePromise(`Handshake rejected: ${parsed.error}`);
              return;
            }
          } catch { /* not JSON, ignore */ }
        }
        clearTimeout(ackTimer);
        ws.removeListener("message", onAck);
        resolvePromise(null);
      };
      ws.on("message", onAck);
    });

    if (handshakeError) {
      log?.error?.("M365-COPILOT", `SignalR handshake failed: ${handshakeError}`);
      try { ws.close(); } catch {}
      return this._errorResponse(`M365 Copilot handshake failed: ${handshakeError}`, 502, "upstream_error");
    }

    log?.info?.("M365-COPILOT", `WS handshake OK, sending message`);

    // Set up message listener BEFORE sending to avoid race condition
    const messageBuffer = [];
    const messageListener = (data) => {
      let rawStr;
      if (Buffer.isBuffer(data)) rawStr = data.toString("utf8");
      else if (Array.isArray(data)) rawStr = Buffer.concat(data).toString("utf8");
      else if (data instanceof ArrayBuffer || data instanceof Uint8Array) rawStr = Buffer.from(data).toString("utf8");
      else rawStr = String(data);
      // Keep RS (\u001e) delimiters intact for parseSignalRRecords to split multi-record frames
      log?.info?.("M365-COPILOT", `WS recv: ${rawStr.replace(/\u001e/g, "|").slice(0, 200)}`);
      if (ws.onmessage) {
        ws.onmessage({ data: rawStr });
      } else {
        messageBuffer.push(rawStr);
      }
    };
    ws.on("message", messageListener);
    ws.on("close", (code, reason) => {
      log?.info?.("M365-COPILOT", `WS close: code=${code}, reason=${reason?.toString() || ""}`);
      if (ws.onclose) ws.onclose({ code, reason: reason?.toString() || "" });
    });
    ws.on("error", (err) => {
      log?.error?.("M365-COPILOT", `WS error: ${err.message}`);
      if (ws.onerror) ws.onerror({ message: err.message });
    });

    // Send keep-alive ping (type 6)
    ws.send(JSON.stringify({ type: 6 }) + RS);

    // Send user message
    const copilotMsg = buildCopilotMessage(userPrompt, 0, conversationId, sessionIdUuid, model);
    ws.send(JSON.stringify(copilotMsg) + RS);

    log?.info?.("M365-COPILOT", `Message sent (model=${model}), waiting for response stream`);

    const cid = `chatcmpl-m365-${crypto.randomUUID().slice(0, 12)}`;
    const created = Math.floor(Date.now() / 1000);

    let finalResponse;
    if (stream) {
      const sseStream = buildStreamingFromWs(ws, model, cid, created, signal);
      // Process buffered messages
      for (const buf of messageBuffer) {
        if (ws.onmessage) ws.onmessage({ data: buf });
      }
      messageBuffer.length = 0;
      finalResponse = new Response(sseStream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
      });
    } else {
      finalResponse = await buildNonStreamingFromWs(ws, model, cid, created, signal, log, messageBuffer);
    }

    return { response: finalResponse, url: M365_WS_BASE, headers: {}, transformedBody: copilotMsg };
  }

  _errorResponse(message, status, code) {
    return {
      response: new Response(JSON.stringify({
        error: { message, type: code || "upstream_error", code: code || `HTTP_${status}` },
      }), { status, headers: { "Content-Type": "application/json" } }),
      url: M365_WS_BASE, headers: {}, transformedBody: null,
    };
  }
}

export default M365CopilotExecutor;
