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

function decodeJwtPayload(token) {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
  } catch { return null; }
}

function extractTokenClaims(token) {
  const claims = decodeJwtPayload(token);
  if (!claims) return { oid: "unknown", tid: "unknown" };
  return { oid: claims.oid || claims.sub || "unknown", tid: claims.tid || "unknown" };
}

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
  "async_client_interaction",
  "flux_v3_references",
  "flux_v3_references_entities",
  "flux_v3_references_ci",
  "add_filestore_filetype",
  "cwc_code_interpreter_citation_sourceannotations",
  "cdxcwc_code_interpreter_hallucinated_url_filter",
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

function buildCopilotOptionsSets(tone = "Magic") {
  const sets = [...M365_DEFAULT_OPTIONS_SETS];
  if (tone === "Gpt_5_6_Reasoning" && !sets.includes("enable_gg_gpt")) {
    sets.push("enable_gg_gpt");
  }
  const ciFlags = [
    "cwc_code_interpreter", "cwc_code_interpreter_amsfix",
    "cwc_code_interpreter_citation_fix", "cwc_code_interpreter_citation_sourceannotations",
    "cdxcwc_code_interpreter_hallucinated_url_filter",
    "code_interpreter_interactive_charts",
    "cwc_code_interpreter_interactive_charts_inline_image",
    "code_interpreter_matplotlib_patching", "cwc_fileupload_odb",
    "add_filestore_filetype",
    "cwc_flux_image", "cwcfluxgptv",
    "flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch",
    "cwc_flux_v3", "flux_v3_references", "flux_v3_references_entities",
    "flux_v3_references_ci",
    "flux_v3_image_gen_enable_non_watermarked_storage",
    "flux_v3_image_gen_enable_icon_dimensions",
    "flux_v3_image_gen_enable_system_text_with_params",
    "flux_v3_image_gen_enable_designer_dimensions_meta_prompting_in_system_prompts",
    "flux_v3_image_gen_enable_story",
    "update_textdoc_response_after_streaming",
  ];
  for (let i = sets.length - 1; i >= 0; i--) {
    if (ciFlags.includes(sets[i])) sets.splice(i, 1);
  }
  return sets;
}

function buildCopilotMessage(text, invocationId, conversationId, sessionId, tone = "Magic") {
  const threadLevelGptId = {};

  const allAllowedMessageTypes = [
    "Chat", "Suggestion", "InternalSearchQuery", "Disengaged",
    "InternalLoaderMessage", "Progress", "GeneratedCode", "RenderCardRequest",
    "AdsQuery", "SemanticSerp", "GenerateContentQuery", "GenerateGraphicArt",
    "SearchQuery", "ConfirmationCard", "AuthError", "DeveloperLogs",
    "TriggerPlugin", "HintInvocation", "MemoryUpdate", "EndOfRequest",
    "TriggerConfirmation", "ResumeInvokeAction", "ResumeUserInputRequest",
    "TriggerUserInputRequest", "EscapeHatch", "TriggerPluginAuth",
    "ResumePluginAuth", "SideBySide", "ReferencesListComplete",
    "SwitchRespondingEndpoint",
  ];

  const ciMessageTypes = new Set([
    "GeneratedCode", "RenderCardRequest", "GenerateGraphicArt",
    "GenerateContentQuery", "ConfirmationCard",
  ]);

  const allowedMessageTypes = allAllowedMessageTypes.filter(t => !ciMessageTypes.has(t));

  console.log(`[M365-FC-MSG-TYPES] disableCodeInterpreter=true allowedCount=${allowedMessageTypes.length} removed=${ciMessageTypes.size}`);

  const plugins = [{ Id: "BingWebSearch", Source: "BuiltIn" }];

  const experienceType = "Default";

  return {
    arguments: [{
      source: "officeweb",
      clientCorrelationId: randomUUID(),
      sessionId,
      optionsSets: ["enterprise_flux_handoff_outlook_compose", ...buildCopilotOptionsSets(tone)],
      streamingMode: "ConciseWithPadding",
      options: {},
      extraExtensionParameters: {},
      tone,
      allowedMessageTypes,
      sliceIds: [],
      threadLevelGptId,
      conversationId,
      traceId: randomUUID(),
      isStartOfSession: invocationId === 0,
      clientInfo: {
        clientPlatform: "mcmcopilot-web",
        clientAppName: "Office",
        clientEntrypoint: "mcmcopilot-officeweb",
        clientSessionId: sessionId,
        ProductCategory: "Chat",
        clientAppType: "Web",
        productEntryPoint: "ChatPanel",
        deviceOS: "macOS",
        deviceType: "Desktop",
        clientPlatformVersion: "10.15.7",
      },
      message: {
        author: "user",
        inputMethod: "Keyboard",
        text,
        entityAnnotationTypes: ["People", "File", "Event", "Email", "TeamsMessage"],
        requestId: randomUUID(),
        locationInfo: {
          timeZoneOffset: new Date().getTimezoneOffset() / -60,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        },
        locale: "zh-cn",
        messageType: "Chat",
        experienceType,
        adaptiveCards: [],
        clientPreferences: {},
      },
      plugins,
      isSbsSupported: true,
      renderReferencesBehindEOS: true,
    }],
    invocationId: String(invocationId),
    target: "chat",
    type: 4,
  };
}

function sseChunk(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function parseSignalRRecords(rawText) {
  const str = typeof rawText === "string" ? rawText : String(rawText);
  const parts = str.split("\u001e");
  const results = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      results.push(JSON.parse(trimmed));
    } catch {
      try {
        results.push(JSON.parse(trimmed.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")));
      } catch { /* skip unparseable records */ }
    }
  }
  return results;
}

function buildStreamingFromWs(ws, model, cid, created, signal) {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseChunk({
        id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null, logprobs: null }],
      })));

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
        console.log(`[M365-FC-CLOSE] stream closing`);
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
        if (!closed) sendError("M365 Foldcraft response timed out");
      }, WS_RESPONSE_TIMEOUT_MS);

       const processData = (data) => {
         if (data.type === 1) {
           const payload = data.item || data.arguments?.[0];

           if (payload?.writeAtCursor) {
             const cursorText = payload.writeAtCursor;
             if (cursorText) {
               emitContent(cursorText);
             }
           } else if (payload?.patches) {
             console.log(`[M365-FC-WS-PATCHES] ${JSON.stringify(payload.patches).slice(0, 200)}`);
           }

           if (payload?.messages) {
             for (const msg of payload.messages) {
               console.log(`[M365-FC-WS-T1] author=${msg.author || "NONE"} type=${msg.messageType || msg.type || "unknown"} textLen=${(msg.text||"").length} contentOrigin=${msg.contentOrigin || "none"}`);
             }
           }
         }
         if (data.type === 2) {
           const payload = data.item || data.arguments?.[0];
           if (payload?.messages) {
             const firstNew = payload.firstNewMessageIndex ?? 0;
             for (let mi = firstNew; mi < payload.messages.length; mi++) {
               const msg = payload.messages[mi];
               console.log(`[M365-FC-WS-T2] author=${msg?.author || "NONE"} type=${msg?.messageType || msg?.type || "unknown"} textLen=${(msg?.text||"").length} contentOrigin=${msg?.contentOrigin || "none"}`);
             }
           }
           if (payload?.result?.value && payload.result.value !== "Success") {
             console.log(`[M365-FC-WS-T2] result=NOT_SUCCESS value=${payload.result.value} message=${payload.result.message || "none"}`);
             sendError(payload.result.message || payload.result.value);
             return;
           }
           clearTimeout(responseTimer);
           close();
           return;
         }
         if (data.type === 3) {
           console.log(`[M365-FC-WS-T3] end of conversation turn`);
           clearTimeout(responseTimer);
           close();
         }
         if (data.type === 6) {
           console.log(`[M365-FC-WS-T6] keep-alive ping received`);
         }
         if (data.type !== 1 && data.type !== 2 && data.type !== 3 && data.type !== 6) {
           console.log(`[M365-FC-WS-OTHER] type=${data.type} keys=${Object.keys(data).join(",")}`);
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

function extractMessageId(msg) {
  return msg.messageId || msg.responseIdentifier || "default";
}

export class M365FoldcraftExecutor extends BaseExecutor {
  constructor() {
    super("m365-foldcraft", PROVIDERS["m365-foldcraft"]);
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const accessToken = credentials.accessToken || credentials.apiKey;
    if (!accessToken) {
      return this._errorResponse(
        "M365 Foldcraft access token is required. Extract it from your browser (substrate.office.com in localStorage) or use the token extraction tool.",
        401, "auth_required"
      );
    }

    const messages = body?.messages || [];
    let userPrompt = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        const c = messages[i].content;
        userPrompt = typeof c === "string" ? c : Array.isArray(c) ? c.filter(p => p.type === "text").map(p => p.text).join("\n") : "";
        break;
      }
    }
    console.log(`[M365-FC-EXEC] ========== NEW REQUEST ==========`);
    console.log(`[M365-FC-EXEC] model=${model} stream=${stream} msg_count=${messages.length} prompt_len=${userPrompt.length}`);
    if (!userPrompt.trim()) {
      return this._errorResponse("No user message found in request", 400, "invalid_request");
    }

    const { oid, tid } = extractTokenClaims(accessToken);

    const isFastModel = model.toLowerCase().includes("gpt-5.6-fast") || model.toLowerCase().includes("gpt-5.5-fast");
    const isDeepModel = (model.toLowerCase().includes("gpt-5.6") || model.toLowerCase().includes("gpt-5.5")) && !isFastModel;
    const m365Tone = isFastModel
      ? "Gpt_5_6_Chat"
      : isDeepModel
        ? (body?.reasoning !== false && body?.enable_deep_thinking !== false ? "Gpt_5_6_Reasoning" : "Gpt_5_6_Chat")
        : (body?.reasoning === true || body?.enable_deep_thinking === true ? "Gpt_5_6_Reasoning" : "Magic");

    const connectionId = credentials?.connectionId || credentials?.email || `${oid}@${tid}`;

    let firstUserFingerprint = "";
    for (const m of messages) {
      if (m.role === "user") {
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
        firstUserFingerprint = text.slice(0, 120);
        break;
      }
    }

    const conversationIdBase = resolveSessionId({
      headers: credentials?.rawHeaders,
      body,
      connectionId: firstUserFingerprint
        ? `${connectionId}:conv:${createHash("sha256").update(firstUserFingerprint).digest("hex").slice(0, 16)}`
        : connectionId,
      scope: "m365-foldcraft"
    });

    const sessionIdBase = resolveSessionId({
      headers: credentials?.rawHeaders,
      body,
      connectionId: firstUserFingerprint
        ? `${connectionId}:conv:${createHash("sha256").update(firstUserFingerprint).digest("hex").slice(0, 16)}:session`
        : `${connectionId}:session`,
      scope: "m365-foldcraft-session"
    });

    const conversationIdHash = createHash("sha256").update(conversationIdBase).digest("hex");
    let conversationId = `${conversationIdHash.slice(0,8)}-${conversationIdHash.slice(8,12)}-${conversationIdHash.slice(12,16)}-${conversationIdHash.slice(16,20)}-${conversationIdHash.slice(20,32)}`;

    const isContinuation = messages.length > 1;
    console.log(`[M365-FC-EXEC-CID] strategy=STABLE conversationId=${conversationId} isContinuation=${isContinuation}`);

    const sessionIdHash = createHash("sha256").update(sessionIdBase).digest("hex");
    let sessionIdUuid = `${sessionIdHash.slice(0,8)}-${sessionIdHash.slice(8,12)}-${sessionIdHash.slice(12,16)}-${sessionIdHash.slice(16,20)}-${sessionIdHash.slice(20,32)}`;
    let sessionIdHex = sessionIdHash.slice(0, 32);

    console.log(`[M365-FC-EXEC-SID] strategy=STABLE sessionId=${sessionIdUuid}`);

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

    log?.info?.("M365-FC", `Session: conversationId=${conversationId}, sessionId=${sessionIdUuid}`);
    log?.info?.("M365-FC", `Connecting WebSocket: oid=${oid.slice(0, 8)}..., tid=${tid.slice(0, 8)}..., model=${model}, prompt_len=${userPrompt.length}`);

    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    const WS_CONNECT_RETRIES = 2;
    const WS_CONNECT_RETRY_DELAY_MS = 3000;
    let ws;
    let lastConnectError = null;

    for (let attempt = 0; attempt <= WS_CONNECT_RETRIES; attempt++) {
      if (attempt > 0) {
        log?.warn?.("M365-FC", `WS connect retry ${attempt}/${WS_CONNECT_RETRIES} after ${WS_CONNECT_RETRY_DELAY_MS / 1000}s`);
        await new Promise(r => setTimeout(r, WS_CONNECT_RETRY_DELAY_MS));
      }

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
          if (attempt === 0) log?.info?.("M365-FC", `Using HTTP proxy: ${proxyUrl}`);
          wsOpts.agent = new HttpsProxyAgent(proxyUrl);
        }

        ws = new WsClient(wsUrl, [], wsOpts);
      } catch (err) {
        lastConnectError = err.message;
        log?.error?.("M365-FC", `WebSocket construct failed (attempt ${attempt + 1}): ${err.message}`);
        continue;
      }

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

      if (!connectError) {
        lastConnectError = null;
        break;
      }

      lastConnectError = connectError;
      const isTransient = /tls|socket disconnected|network socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT/i.test(connectError);
      log?.error?.("M365-FC", `WebSocket connect failed (attempt ${attempt + 1}): ${connectError} (transient=${isTransient})`);

      if (!isTransient) break;

      try { ws.close(); } catch {}
    }

    if (lastConnectError) {
      log?.error?.("M365-FC", `WebSocket connect failed after ${WS_CONNECT_RETRIES + 1} attempts: ${lastConnectError}`);
      return this._errorResponse(`M365 Foldcraft connection failed: ${lastConnectError}`, 502, "upstream_error");
    }

    log?.info?.("M365-FC", `WS readyState=${ws.readyState}, sending SignalR handshake`);

    const RS = "\u001e";

    ws.send(JSON.stringify({ protocol: "json", version: 1 }) + RS);

    const handshakeError = await new Promise((resolvePromise) => {
      const ackTimer = setTimeout(() => resolvePromise("SignalR handshake timeout (10s)"), 10_000);
      const onAck = (data) => {
        const text = typeof data === "string" ? data : data.toString();
        log?.info?.("M365-FC", `WS handshake ack: ${text.slice(0, 100)}`);
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
      log?.error?.("M365-FC", `SignalR handshake failed: ${handshakeError}`);
      try { ws.close(); } catch {}
      return this._errorResponse(`M365 Foldcraft handshake failed: ${handshakeError}`, 502, "upstream_error");
    }

    log?.info?.("M365-FC", `WS handshake OK, sending message`);

    let messageBuffer = [];
    const messageListener = (data) => {
      let rawStr;
      if (Buffer.isBuffer(data)) rawStr = data.toString("utf8");
      else if (Array.isArray(data)) rawStr = Buffer.concat(data).toString("utf8");
      else if (data instanceof ArrayBuffer || data instanceof Uint8Array) rawStr = Buffer.from(data).toString("utf8");
      else rawStr = String(data);
      log?.info?.("M365-FC", `WS recv: ${rawStr.replace(/\u001e/g, "|").slice(0, 200)}`);
      if (!messageBuffer) {
        // onmessage already set, messageListener only logs
      } else {
        messageBuffer.push(rawStr);
      }
    };
    ws.on("message", messageListener);
    ws.on("close", (code, reason) => {
      log?.info?.("M365-FC", `WS close: code=${code}, reason=${reason?.toString() || ""}`);
      if (ws.onclose) ws.onclose({ code, reason: reason?.toString() || "" });
    });
    ws.on("error", (err) => {
      log?.error?.("M365-FC", `WS error: ${err.message}`);
      if (ws.onerror) ws.onerror({ message: err.message });
    });

    ws.send(JSON.stringify({ type: 6 }) + RS);

    let effectivePrompt = userPrompt;
    if (/<image\b/i.test(effectivePrompt)) {
      effectivePrompt = effectivePrompt + "\n\nIMPORTANT: Images are already included inline above. Do NOT attempt to read, open, or process any image file paths (e.g. /var/folders/...). Just answer based on the images shown.";
    }
    console.log(`[M365-FC-EXEC-FLAGS] disableCodeInterpreter=true enableSearch=true experienceType=Default tone=${m365Tone} hasImage=${/<image\b/i.test(userPrompt)}`);
    const copilotMsg = buildCopilotMessage(effectivePrompt, isContinuation ? 1 : 0, conversationId, sessionIdUuid, m365Tone);
    log?.info?.("M365-FC", `WS send: isStartOfSession=${copilotMsg.arguments[0].isStartOfSession} isContinuation=${isContinuation} optionsSets=${JSON.stringify(copilotMsg.arguments[0].optionsSets)}, plugins=${JSON.stringify(copilotMsg.arguments[0].plugins)}, allowedMessageTypes=${JSON.stringify(copilotMsg.arguments[0].allowedMessageTypes)}`);
    ws.send(JSON.stringify(copilotMsg) + RS);

    log?.info?.("M365-FC", `Message sent (model=${model}), waiting for response stream`);

    const cid = `chatcmpl-m365fc-${randomUUID().slice(0, 12)}`;
    const created = Math.floor(Date.now() / 1000);

    const sseStream = buildStreamingFromWs(ws, model, cid, created, signal);
    for (const buf of messageBuffer) {
      if (ws.onmessage) ws.onmessage({ data: buf });
    }
    messageBuffer.length = 0;
    messageBuffer = null;
    const finalResponse = new Response(sseStream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
    });

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

export default M365FoldcraftExecutor;
