import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import WsClient from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import { resolveSessionId } from "../utils/sessionManager.js";
import { createHash, randomUUID } from "crypto";

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

/** Default M365 Copilot feature flags (captured from real browser traffic) */
const M365_DEFAULT_OPTIONS_SETS = [
  "search_result_progress_messages_with_search_queries",
  "update_textdoc_response_after_streaming",
  "deepleo_networking_timeout_10minutes_canmore",
  "cwc_flux_image",
  "cwc_code_interpreter",
  "cwc_code_interpreter_amsfix",
  "cwcfluxgptv",
  "flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch",
  "gptvnorm2048",
  "cwc_code_interpreter_citation_fix",
  "code_interpreter_interactive_charts",
  "cwc_code_interpreter_interactive_charts_inline_image",
  "code_interpreter_matplotlib_patching",
  "cwc_fileupload_odb",
  "update_memory_plugin",
  "add_custom_instructions",
  "cwc_flux_v3",
  "flux_v3_progress_messages",
  "enable_batch_token_processing",
  "flux_v3_image_gen_enable_dimensions",
  "flux_v3_image_gen_enable_non_watermarked_storage",
  "flux_v3_image_gen_enable_icon_dimensions",
  "flux_v3_image_gen_enable_system_text_with_params",
  "flux_v3_image_gen_enable_designer_dimensions_meta_prompting_in_system_prompts",
  "flux_v3_image_gen_enable_story",
  "rich_responses",
  "pages_citations",
  "pages_citations_multiturn",
];

/**
 * Build M365 Copilot feature flags.
 * @param {boolean} enableReasoning - if true, add "enable_gg_gpt" for deep thinking
 * @param {boolean} disableCodeInterpreter - if true, strip code interpreter / image generation flags
 * @param {boolean} keepSearch - if true, keep search-related flags (web search is useful)
 * @returns {string[]}
 */
function buildCopilotOptionsSets(enableReasoning = false, disableCodeInterpreter = false, keepSearch = true) {
  const sets = [...M365_DEFAULT_OPTIONS_SETS];
  if (enableReasoning && !sets.includes("enable_gg_gpt")) {
    sets.push("enable_gg_gpt");
  }
  if (disableCodeInterpreter) {
    const ciFlags = [
      "cwc_code_interpreter", "cwc_code_interpreter_amsfix",
      "cwc_code_interpreter_citation_fix", "code_interpreter_interactive_charts",
      "cwc_code_interpreter_interactive_charts_inline_image",
      "code_interpreter_matplotlib_patching", "cwc_fileupload_odb",
      "cwc_flux_image", "cwcfluxgptv",
      "flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch",
      "cwc_flux_v3", "flux_v3_image_gen_enable_dimensions",
      "flux_v3_image_gen_enable_non_watermarked_storage",
      "flux_v3_image_gen_enable_icon_dimensions",
      "flux_v3_image_gen_enable_system_text_with_params",
      "flux_v3_image_gen_enable_designer_dimensions_meta_prompting_in_system_prompts",
      "flux_v3_image_gen_enable_story",
      "update_textdoc_response_after_streaming",
      "rich_responses",
      "pages_citations", "pages_citations_multiturn",
    ];
    if (!keepSearch) {
      ciFlags.push("search_result_progress_messages_with_search_queries");
    }
    for (let i = sets.length - 1; i >= 0; i--) {
      if (ciFlags.includes(sets[i])) sets.splice(i, 1);
    }
  }
  return sets;
}

function buildCopilotMessage(text, invocationId, conversationId, sessionId, enableReasoning = false, modelId = null, m365Flags = {}) {
  const { disableCodeInterpreter = false, enableSearch = true } = m365Flags;
  const threadLevelGptId = modelId ? { [conversationId]: modelId } : {};

  const allowedMessageTypes = [
    "Chat", "Suggestion", "InternalSearchQuery", "InternalSearchResult",
    "Disengaged", "InternalLoaderMessage", "RenderCardRequest",
    "AdsQuery", "SemanticSerp", "GenerateContentQuery", "SearchQuery",
    "ConfirmationCard", "AuthError", "DeveloperLogs",
  ];

  const plugins = enableSearch
    ? [{ Id: "BingWebSearch", Source: "BuiltIn" }]
    : [];

  const experienceType = (disableCodeInterpreter && !enableSearch) ? "Deep" : "Default";

  return {
    arguments: [{
      source: "officeweb",
      clientCorrelationId: randomUUID(),
      sessionId,
      optionsSets: ["enterprise_flux_handoff_outlook_compose", ...buildCopilotOptionsSets(enableReasoning, disableCodeInterpreter, enableSearch)],
      options: {},
      tone: enableReasoning ? "Reasoning" : "Balanced",
      allowedMessageTypes,
      sliceIds: [],
      threadLevelGptId,
      conversationId,
      traceId: randomUUID(),
      isStartOfSession: invocationId === 0,
      productThreadType: "Office",
      clientInfo: { clientPlatform: "web" },
      message: {
        author: "user",
        inputMethod: "Keyboard",
        text,
        entityAnnotationTypes: ["People", "File", "Event"],
        requestId: randomUUID(),
        locationInfo: {
          timeZoneOffset: new Date().getTimezoneOffset() / -60,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        },
        locale: "en-US",
        messageType: "Chat",
        experienceType,
      },
      plugins,
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
 * When toolMeta.needsLocalExec is true, content is buffered until stream end so the
 * response translator can detect ```json-tool blocks and convert them to
 * proper OpenAI tool_calls. Without local exec tools, content streams normally.
 */
function buildStreamingFromWs(ws, model, cid, created, signal, toolMeta) {
  const encoder = new TextEncoder();
  const bufferForTools = !!toolMeta?.needsLocalExec;

  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseChunk({
        id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null, logprobs: null }],
      })));

      let fullText = "";
      let closed = false;

      const emitContent = (text) => {
        if (!text || closed) return;
        controller.enqueue(encoder.encode(sseChunk({
          id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
          choices: [{ index: 0, delta: { content: text }, finish_reason: null, logprobs: null }],
        })));
      };

      const close = () => {
        if (closed) return;
        // When buffering for tools, emit all accumulated text as one chunk
        // BEFORE setting closed=true (emitContent checks the closed flag)
        if (bufferForTools && fullText) {
          const hasCmd = /^CMD:/m.test(fullText);
          const hasRemoteExec = /\/mnt\//.test(fullText) && /cwd:/m.test(fullText);
          console.log(`[M365-CLOSE] Buffering tools: textLen=${fullText.length}, needsLocalExec=${!!toolMeta?.needsLocalExec}, hasJsonTool=${fullText.includes('```json-tool')}, hasCmd=${hasCmd}, hasRemoteExec=${hasRemoteExec}`);
          console.log(`[M365-CLOSE-FULL] ${fullText.slice(0, 1000)}`);
          emitContent(fullText);
        }
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
        if (bufferForTools && fullText) emitContent(fullText);
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
        if (data.type === 1) {
          const payload = data.item || data.arguments?.[0];
          if (payload?.messages) {
            for (const msg of payload.messages) {
              if (msg.author !== "bot") {
                const msgType = msg.messageType || msg.type || "unknown";
                console.log(`[M365-T1-NONBOT] author=${msg.author} messageType=${msgType} keys=${Object.keys(msg).join(",")} text=${(msg.text||"").slice(0,200)}`);
                if (msgType === "InternalSearchQuery" || msgType === "InternalSearchResult" ||
                    msgType === "SemanticSerp" || msgType === "SearchQuery" ||
                    msgType === "AdsQuery" || msgType === "GenerateContentQuery") {
                  console.log(`[M365-SEARCH] type=${msgType} text=${(msg.text||"").slice(0,300)}`);
                }
              }
              if (msg.text && msg.author === "bot") {
                const delta = msg.text.slice(fullText.length);
                if (delta) {
                  fullText = msg.text;
                  if (!bufferForTools) emitContent(delta);
                }
              }
            }
          }
        }
        if (data.type === 2) {
          const payload = data.item || data.arguments?.[0];
          if (payload?.messages) {
            for (const msg of payload.messages) {
              const msgKeys = Object.keys(msg || {}).join(",");
              const msgAuthor = msg?.author || "NONE";
              const msgText = (msg?.text || "").slice(0, 100);
              console.log(`[M365-T2] author=${msgAuthor} keys=${msgKeys} text=${msgText}`);
              if (msg.text && msg.author === "bot" && msg.text.length > fullText.length) {
                const delta = msg.text.slice(fullText.length);
                fullText = msg.text;
                if (!bufferForTools && delta) emitContent(delta);
              }
            }
          }
          if (payload?.result?.value && payload.result.value !== "Success") {
            sendError(payload.result.message || payload.result.value);
            return;
          }
          clearTimeout(responseTimer);
          close();
          return;
        }
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
    const accessToken = credentials.accessToken || credentials.apiKey;
    if (!accessToken) {
      return this._errorResponse(
        "M365 Copilot access token is required. Extract it from your browser (substrate.office.com in localStorage) or use the token extraction tool.",
        401, "auth_required"
      );
    }

    const userPrompt = body._m365Prompt || "";
    if (!userPrompt.trim()) {
      return this._errorResponse("Empty query after processing", 400, "invalid_request");
    }

    const toolMeta = body._m365ToolMeta || { hasTools: false, toolNameMap: new Map(), toolCallMetaMap: new Map() };

    const { oid, tid } = extractTokenClaims(accessToken);

    const isGpt55 = model === "gpt-5.5" || model.toLowerCase().includes("gpt-5.5");
    const enableReasoning = isGpt55
      ? body?.reasoning !== false && body?.enable_deep_thinking !== false
      : (body?.reasoning === true || body?.enable_deep_thinking === true);

    // Use session manager for stable conversation/session IDs (enables multi-turn tool calling)
    const connectionId = credentials?.connectionId || credentials?.email || `${oid}@${tid}`;
    
    // Generate stable conversationId for multi-turn dialogue
    const conversationIdBase = resolveSessionId({
      headers: credentials?.rawHeaders,
      body,
      connectionId,
      scope: "m365-copilot"
    });
    
    // Generate stable sessionId
    const sessionIdBase = resolveSessionId({
      headers: credentials?.rawHeaders,
      body,
      connectionId: `${connectionId}:session`,
      scope: "m365-copilot-session"
    });
    
    // Convert to UUID format (M365 requires UUID format for conversationId)
    const conversationIdHash = createHash("sha256").update(conversationIdBase).digest("hex");
    const conversationId = `${conversationIdHash.slice(0,8)}-${conversationIdHash.slice(8,12)}-${conversationIdHash.slice(12,16)}-${conversationIdHash.slice(16,20)}-${conversationIdHash.slice(20,32)}`;
    
    // Convert to UUID format for sessionId
    const sessionIdHash = createHash("sha256").update(sessionIdBase).digest("hex");
    const sessionIdUuid = `${sessionIdHash.slice(0,8)}-${sessionIdHash.slice(8,12)}-${sessionIdHash.slice(12,16)}-${sessionIdHash.slice(16,20)}-${sessionIdHash.slice(20,32)}`;
    const sessionIdHex = sessionIdHash.slice(0, 32);

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

    log?.info?.("M365-COPILOT", `Session: conversationId=${conversationId}, sessionId=${sessionIdUuid}`);
    log?.info?.("M365-COPILOT", `Tool meta: hasTools=${toolMeta.hasTools}, needsLocalExec=${!!toolMeta.needsLocalExec}, hasSearchTools=${!!toolMeta.hasSearchTools}, toolCount=${toolMeta.toolNameMap?.size || 0}, shellTools=${JSON.stringify(toolMeta.shellToolNames || [])}`);
    if (toolMeta.searchToolNames?.length) {
      log?.info?.("M365-COPILOT", `  Search tools: ${JSON.stringify(toolMeta.searchToolNames)}`);
    }
    const schemas = toolMeta.shellToolSchemas || {};
    for (const [name, schema] of Object.entries(schemas)) {
      log?.info?.("M365-COPILOT", `  Shell tool schema: ${name} → ${JSON.stringify(schema)?.slice(0, 300)}`);
    }
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

    // Send user message — pass model so M365 uses the correct GPT variant
    // "copilot" (auto) means let M365 decide the model
    const modelId = model === "copilot" ? null : model;
    const m365Flags = {
      disableCodeInterpreter: !!toolMeta.needsLocalExec,
      enableSearch: true,
    };
    const copilotMsg = buildCopilotMessage(userPrompt, 0, conversationId, sessionIdUuid, enableReasoning, modelId, m365Flags);
    log?.info?.("M365-COPILOT", `WS send: optionsSets=${JSON.stringify(copilotMsg.arguments[0].optionsSets)}, plugins=${JSON.stringify(copilotMsg.arguments[0].plugins)}, allowedMessageTypes=${JSON.stringify(copilotMsg.arguments[0].allowedMessageTypes)}`);
    ws.send(JSON.stringify(copilotMsg) + RS);

    log?.info?.("M365-COPILOT", `Message sent (model=${model}), waiting for response stream`);

    const cid = `chatcmpl-m365-${randomUUID().slice(0, 12)}`;
    const created = Math.floor(Date.now() / 1000);

    let finalResponse;
    if (stream) {
      const sseStream = buildStreamingFromWs(ws, model, cid, created, signal, toolMeta);
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
