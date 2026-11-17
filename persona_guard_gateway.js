"use strict";

// server.js 与 guard 之间的胶水层：解析上游响应、发起恢复请求、把结果写回客户端。
// server.js 里只多出几行调用，guard 关闭时完全走原来的代码路径。

const crypto = require("crypto");
const { STATUS, detectDrift, textOf, RULES_VERSION } = require("./persona_guard");
const { runRecovery, STATE } = require("./persona_recovery");
const { addQuarantineEntry, fingerprintText, isQuarantinedMessage, quarantinedFingerprintSet } = require("./persona_quarantine");
const { logGuardEvent } = require("./persona_guard_diagnostics");

const SAFETY_CODES = new Set(["content_filter", "safety", "prohibited_content", "blocklist"]);

function newRequestId() {
  return crypto.randomUUID();
}

function contentText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map(part => (typeof part === "string" ? part : String(part?.text || ""))).join("");
}

function isBlockedPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  const err = payload.error;
  if (err) {
    const code = String((typeof err === "object" && (err.code || err.type)) || "").toLowerCase();
    return SAFETY_CODES.has(code);
  }
  const reason = payload.promptFeedback?.blockReason;
  return Boolean(reason && reason !== "BLOCK_REASON_UNSPECIFIED");
}

/** 把非流式 JSON 或 SSE 文本统一解析成 attempt 结构；解析失败返回 ok:false。 */
function parseUpstreamText(raw, contentType = "") {
  const text = String(raw || "");
  const isSse = /text\/event-stream/i.test(contentType) || /^\s*(?:event:.*\r?\n)?data:/i.test(text);
  if (!isSse) {
    let payload;
    try { payload = JSON.parse(text); } catch { return { ok: false, text: "", raw: text, sse: false }; }
    if (payload?.error) return { ok: false, blocked: isBlockedPayload(payload), text: "", raw: text, sse: false };
    const choice = payload?.choices?.[0] || {};
    const message = choice.message || {};
    return {
      ok: true,
      sse: false,
      raw: text,
      text: contentText(message.content) || String(message.refusal || ""),
      finishReason: choice.finish_reason || "",
      toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
      usage: payload.usage || {},
      blocked: isBlockedPayload(payload)
    };
  }
  let streamed = "";
  let finishReason = "";
  let usage = {};
  let toolCalls = 0;
  let blocked = false;
  let errored = false;
  let sawDone = false;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^data:\s*(.*)$/i);
    if (!match) continue;
    const data = match[1].trim();
    if (!data) continue;
    if (data === "[DONE]") { sawDone = true; continue; }
    let payload;
    try { payload = JSON.parse(data); } catch { continue; }
    if (payload?.error) { errored = true; blocked = blocked || isBlockedPayload(payload); continue; }
    if (isBlockedPayload(payload)) blocked = true;
    if (payload?.usage) usage = payload.usage;
    const choice = payload?.choices?.[0] || {};
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || choice.message || {};
    streamed += contentText(delta.content);
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) toolCalls += delta.tool_calls.length;
  }
  return {
    ok: !errored && (sawDone || Boolean(finishReason) || Boolean(streamed)),
    sse: true,
    raw: text,
    text: streamed,
    finishReason,
    toolCalls: toolCalls ? new Array(toolCalls).fill({}) : [],
    usage,
    blocked
  };
}

/** 入站：把已隔离的 assistant 消息从 Kelivo 带回来的历史里剔除。 */
function filterQuarantinedInbound(messages, env = process.env) {
  if (!Array.isArray(messages) || messages.length === 0) return { messages, removed: 0 };
  const set = quarantinedFingerprintSet(env);
  if (set.size === 0) return { messages, removed: 0 };
  const kept = messages.filter(msg => !isQuarantinedMessage(msg, set));
  return { messages: kept, removed: messages.length - kept.length };
}

function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "user") return textOf(messages[i].content);
  return "";
}

function quarantineAttempt({ attempt, verdict, requestId, conversationHash, env }) {
  const fp = fingerprintText(attempt?.text);
  if (!fp) return false;
  return addQuarantineEntry({ fp, requestId, conversationHash, status: verdict.status, rules: verdict.rules }, env);
}

function makeUpstreamCaller({ fetchImpl, url, headers, body, stream, requestId, config, env }) {
  return async (messages, meta) => {
    let targetUrl = url;
    const callHeaders = {
      ...headers,
      "X-Persona-Guard-Request-Id": requestId,
      "X-Persona-Guard-Attempt": String(meta.attempt),
      "X-Persona-Guard-Stage": meta.stage
    };
    if (meta.fallback && config.fallbackApiUrl) {
      targetUrl = config.fallbackApiUrl;
      const key = config.fallbackApiKeyEnv ? env[config.fallbackApiKeyEnv] : "";
      if (key) callHeaders.Authorization = `Bearer ${key}`;
    }
    const payload = { ...body, messages, stream };
    if (meta.model) payload.model = meta.model;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.recoveryTimeoutMs);
    try {
      const response = await fetchImpl(targetUrl, {
        method: "POST",
        headers: callHeaders,
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const text = await response.text();
      const parsed = parseUpstreamText(text, response.headers.get("content-type") || "");
      parsed.status = response.status;
      parsed.contentType = response.headers.get("content-type") || "";
      if (!response.ok) parsed.ok = false;
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * 完整生成后检测，必要时恢复。用于非流式请求和“缓冲流式”模式。
 * 返回 { status, contentType, bodyText, headers }。
 */
async function guardCompleteResponse({
  initialText, initialStatus, initialContentType, messages, body, stream,
  url, headers, fetchImpl = fetch, config, requestId, conversationHash, model, env = process.env
}) {
  const started = Date.now();
  const initial = parseUpstreamText(initialText, initialContentType);
  initial.status = initialStatus;
  initial.contentType = initialContentType;
  const passthrough = { status: initialStatus, contentType: initialContentType, bodyText: initialText, headers: {} };
  if (initialStatus < 200 || initialStatus >= 300 || !initial.ok) {
    // 上游错误 / 拦截：原样返回，不做任何恢复
    return passthrough;
  }

  const record = await runRecovery({
    initial,
    messages,
    config,
    callUpstream: makeUpstreamCaller({ fetchImpl, url, headers, body, stream, requestId, config, env }),
    onQuarantine: ({ attempt, verdict }) => quarantineAttempt({ attempt, verdict, requestId, conversationHash, env })
  });

  const firstVerdict = detectDrift({
    reply: initial.text,
    userMessage: lastUser(messages),
    recentMessages: messages.filter(m => m?.role !== "system"),
    finishReason: initial.finishReason,
    hasToolCalls: initial.toolCalls.length > 0,
    aiSelfAwarePersona: config.aiSelfAwarePersona
  });

  logGuardEvent({
    request_id: requestId,
    conversation_hash: conversationHash,
    model,
    stream_mode: stream ? "buffered" : "json",
    status: firstVerdict.status,
    rules: firstVerdict.rules,
    detect_ms: firstVerdict.latencyMs,
    state: record.state,
    regenerated: record.regenerated,
    recovered: record.state === STATE.RECOVERED,
    context_repair: record.contextRepaired,
    context_issues: record.contextIssues,
    fallback: record.fallbackUsed,
    extra_requests: record.extraRequests,
    extra_tokens: record.extraTokens,
    total_ms: Date.now() - started,
    transitions: record.transitions,
    rules_version: RULES_VERSION,
    failure_mode: record.state === STATE.RECOVERY_FAILED ? config.failureMode : undefined
  }, { enabled: config.diagnostics, env });

  const guardHeaders = {
    "X-Persona-Guard-State": record.state,
    "X-Persona-Guard-Request-Id": requestId
  };

  if (record.accepted) {
    const accepted = record.accepted;
    return {
      status: accepted.status || 200,
      contentType: accepted.contentType || initialContentType,
      bodyText: accepted.raw,
      headers: guardHeaders
    };
  }

  // RECOVERY_FAILED：不伪造回复。默认把原回复交还（它已在服务端隔离，下一轮不会再进上下文），
  // 或按配置返回明确的错误，让用户手动重新生成。
  if (config.failureMode === "error") {
    const error = {
      error: {
        message: "这次回复没有通过角色连续性检查，自动恢复也没有成功。可以手动重新生成。",
        type: "persona_guard",
        code: "persona_recovery_failed"
      }
    };
    if (stream) {
      return {
        status: 200,
        contentType: "text/event-stream",
        bodyText: `data: ${JSON.stringify(error)}\n\ndata: [DONE]\n\n`,
        headers: guardHeaders
      };
    }
    return { status: 502, contentType: "application/json", bodyText: JSON.stringify(error), headers: guardHeaders };
  }
  return { ...passthrough, headers: guardHeaders };
}

/**
 * 默认流式模式：字节原样直通，旁路收集；结束后检测，确认漂移只做服务端隔离 + 记日志，
 * 不插入任何 Kelivo 不认识的 SSE 事件。
 */
function createStreamObserver({ config, requestId, conversationHash, model, messages, contentType, env = process.env }) {
  const chunks = [];
  let size = 0;
  const LIMIT = 4 * 1024 * 1024;
  const started = Date.now();
  return {
    push(chunk) {
      if (size > LIMIT) return;
      const buf = Buffer.from(chunk);
      size += buf.length;
      chunks.push(buf);
    },
    finish({ aborted = false } = {}) {
      try {
        if (aborted || size > LIMIT) return null;
        const parsed = parseUpstreamText(Buffer.concat(chunks).toString("utf-8"), contentType || "text/event-stream");
        if (!parsed.ok) return null;
        const verdict = detectDrift({
          reply: parsed.text,
          userMessage: lastUser(messages),
          recentMessages: messages.filter(m => m?.role !== "system"),
          finishReason: parsed.finishReason,
          upstreamBlocked: parsed.blocked,
          hasToolCalls: parsed.toolCalls.length > 0,
          aiSelfAwarePersona: config.aiSelfAwarePersona
        });
        let quarantined = false;
        if (verdict.status === STATUS.CONFIRMED_DRIFT) {
          quarantined = quarantineAttempt({ attempt: parsed, verdict, requestId, conversationHash, env });
        }
        if (verdict.status !== STATUS.NORMAL || config.diagnostics) {
          logGuardEvent({
            request_id: requestId,
            conversation_hash: conversationHash,
            model,
            stream_mode: "passthrough",
            status: verdict.status,
            rules: verdict.rules,
            detect_ms: verdict.latencyMs,
            state: verdict.status === STATUS.CONFIRMED_DRIFT ? STATE.QUARANTINED
              : verdict.status === STATUS.SUSPECTED_DRIFT ? STATE.REVIEW_FLAGGED : STATE.COMMITTED,
            quarantined,
            total_ms: Date.now() - started,
            rules_version: RULES_VERSION
          }, { enabled: config.diagnostics, env });
        }
        return verdict;
      } catch (error) {
        // 检测模块任何故障都只记日志，不影响已经发出去的回复
        console.warn(`persona_guard_observer_failed ${error.message}`);
        return null;
      }
    }
  };
}

module.exports = {
  createStreamObserver,
  filterQuarantinedInbound,
  guardCompleteResponse,
  newRequestId,
  parseUpstreamText
};
