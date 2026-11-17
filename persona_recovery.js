"use strict";

// 单轮恢复状态机：
// CHECKING → (NORMAL|UNKNOWN|SAFETY_REFUSAL) COMMITTED
//          → SUSPECTED_DRIFT REVIEW_FLAGGED
//          → CONFIRMED_DRIFT QUARANTINED → REGENERATING → RECOVERED
//                                        ↘ CONTEXT_REPAIR → RECOVERED
//                                                         ↘ FALLBACK → RECOVERED | RECOVERY_FAILED
// 约束：每轮最多重生 1 次、上下文修复 1 次、备用模型 1 次；额外请求数 / token / 时间都有上限；
// 任何一步出现安全拒绝立即停止，不换模型、不改写。

const { STATUS, detectDrift, textOf } = require("./persona_guard");

const STATE = Object.freeze({
  CHECKING: "CHECKING",
  COMMITTED: "COMMITTED",
  REVIEW_FLAGGED: "REVIEW_FLAGGED",
  QUARANTINED: "QUARANTINED",
  OBSERVED: "OBSERVED",
  REGENERATING: "REGENERATING",
  CONTEXT_REPAIR: "CONTEXT_REPAIR",
  FALLBACK: "FALLBACK",
  RECOVERED: "RECOVERED",
  RECOVERY_FAILED: "RECOVERY_FAILED"
});

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return textOf(messages[i].content);
  }
  return "";
}

function verdictFor(attempt, messages, config) {
  return detectDrift({
    reply: attempt.text,
    userMessage: lastUserText(messages),
    recentMessages: messages.filter(msg => msg?.role !== "system"),
    finishReason: attempt.finishReason,
    upstreamBlocked: attempt.blocked,
    hasToolCalls: Array.isArray(attempt.toolCalls) && attempt.toolCalls.length > 0,
    aiSelfAwarePersona: config.aiSelfAwarePersona
  });
}

/**
 * 只修可以确认的问题，不碰任何提示词内容：
 * 1. 历史里本身就是高置信漂移的 assistant 消息（之前没被拦到 / 指纹没对上）→ 排除
 * 2. system 消息不在最前 → 挪回最前（只调顺序）
 * 3. 连续重复的同一条消息 → 去重
 */
function findContextRepair(messages, config) {
  const issues = [];
  const repaired = [];
  const systemMessages = messages.filter(msg => msg?.role === "system");
  const others = messages.filter(msg => msg?.role !== "system");
  if (systemMessages.length && messages[0]?.role !== "system") issues.push("system_not_first");
  if (!systemMessages.length) issues.push("system_missing:unrepairable");

  const lastIndex = others.length - 1;
  for (let i = 0; i < others.length; i++) {
    const msg = others[i];
    const prev = repaired[repaired.length - 1];
    if (prev && prev.role === msg.role && prev.role !== "tool" && !msg.tool_calls
        && textOf(prev.content) && textOf(prev.content) === textOf(msg.content)) {
      issues.push("duplicate_message");
      continue;
    }
    if (msg.role === "assistant" && !msg.tool_calls && i !== lastIndex) {
      const before = others.slice(0, i);
      const verdict = detectDrift({
        reply: textOf(msg.content),
        userMessage: lastUserText(before),
        recentMessages: before,
        aiSelfAwarePersona: config.aiSelfAwarePersona
      });
      if (verdict.status === STATUS.CONFIRMED_DRIFT) {
        issues.push("drifted_history_message");
        continue;
      }
    }
    repaired.push(msg);
  }
  const repairable = issues.filter(issue => !issue.endsWith(":unrepairable"));
  return { issues, repairable: repairable.length > 0, messages: [...systemMessages, ...repaired] };
}

/**
 * @param {object} opts
 * @param {object} opts.initial 首次生成结果 {text, finishReason, toolCalls, usage, blocked}
 * @param {Array} opts.messages 发给上游的 messages
 * @param {object} opts.config readGuardConfig()
 * @param {(messages:Array, meta:{stage:string, attempt:number, model?:string}) => Promise<object>} opts.callUpstream
 * @param {(entry:object) => void} [opts.onQuarantine]
 */
async function runRecovery({ initial, messages, config, callUpstream, onQuarantine = () => {}, now = Date.now }) {
  const startedAt = now();
  const transitions = [];
  const record = {
    state: STATE.CHECKING,
    verdict: null,
    accepted: null,
    lastAttempt: initial,
    regenerated: false,
    contextRepaired: false,
    contextIssues: [],
    fallbackUsed: false,
    extraRequests: 0,
    extraTokens: 0,
    transitions
  };
  const go = (state, reason) => {
    transitions.push({ from: record.state, to: state, reason, at_ms: now() - startedAt });
    record.state = state;
  };

  const first = verdictFor(initial, messages, config);
  record.verdict = first;
  if (first.status === STATUS.SUSPECTED_DRIFT) {
    go(STATE.REVIEW_FLAGGED, "suspected");
    record.accepted = initial;
    return record;
  }
  if (first.status !== STATUS.CONFIRMED_DRIFT) {
    go(STATE.COMMITTED, first.status.toLowerCase());
    record.accepted = initial;
    return record;
  }

  go(STATE.QUARANTINED, "confirmed_drift");
  onQuarantine({ attempt: initial, verdict: first, stage: "initial" });

  if (config.observeOnly) {
    go(STATE.OBSERVED, "observe_mode");
    record.accepted = initial;
    return record;
  }

  const budgetLeft = () =>
    record.extraRequests < config.maxExtraRequests &&
    record.extraTokens < config.extraTokenBudget &&
    now() - startedAt < config.recoveryTimeoutMs;

  // 返回 "accepted" | "refusal" | "drift" | "error"
  const attempt = async (stage, msgs, extra = {}) => {
    record.extraRequests += 1;
    let result;
    try {
      result = await callUpstream(msgs, { stage, attempt: record.extraRequests, ...extra });
    } catch (error) {
      transitions.push({ from: record.state, to: record.state, reason: `upstream_error:${error.message || error}`, at_ms: now() - startedAt });
      return "error";
    }
    record.extraTokens += Number(result?.usage?.total_tokens) || 0;
    record.lastAttempt = result;
    if (!result || result.ok === false) return "error";
    const verdict = verdictFor(result, msgs, config);
    record.verdict = verdict;
    if (verdict.status === STATUS.SAFETY_REFUSAL) {
      record.accepted = result;
      return "refusal";
    }
    if (verdict.status === STATUS.CONFIRMED_DRIFT) {
      onQuarantine({ attempt: result, verdict, stage });
      return "drift";
    }
    record.accepted = result;
    return "accepted";
  };

  const finish = (outcome, label) => {
    if (outcome === "accepted") { go(STATE.RECOVERED, label); return true; }
    if (outcome === "refusal") { go(STATE.COMMITTED, `${label}:safety_refusal_stop`); return true; }
    if (outcome === "error") { go(STATE.RECOVERY_FAILED, `${label}:upstream_error_stop`); return true; }
    return false;
  };

  // 1) 原样重生一次（不改问题、不加任何指令）
  if (config.autoRegenerate && config.maxRegenerations >= 1 && budgetLeft()) {
    go(STATE.REGENERATING, "regenerate_once");
    record.regenerated = true;
    if (finish(await attempt("regenerate", messages), "regenerate")) return record;
  }

  // 2) 只有找到可确认的上下文问题才再试；找不到就不盲目重复请求
  if (config.contextRepair && budgetLeft()) {
    const repair = findContextRepair(messages, config);
    record.contextIssues = repair.issues;
    if (repair.repairable) {
      go(STATE.CONTEXT_REPAIR, repair.issues.join(","));
      record.contextRepaired = true;
      if (finish(await attempt("context_repair", repair.messages), "context_repair")) return record;
    } else {
      transitions.push({ from: record.state, to: record.state, reason: "context_repair_skipped:no_confirmed_issue", at_ms: now() - startedAt });
    }
  }

  // 3) 备用模型：默认关闭；只用已配置的模型
  if (config.fallbackEnabled && config.fallbackModel && budgetLeft()) {
    go(STATE.FALLBACK, `fallback:${config.fallbackModel}`);
    record.fallbackUsed = true;
    if (finish(await attempt("fallback", messages, { model: config.fallbackModel, fallback: true }), "fallback")) return record;
  }

  go(STATE.RECOVERY_FAILED, budgetLeft() ? "all_stages_exhausted" : "budget_exhausted");
  record.accepted = null;
  return record;
}

module.exports = { STATE, runRecovery, findContextRepair };
