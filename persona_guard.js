"use strict";

// Persona Continuity Guard —— 纯代码检测器，不调用任何模型。
// 设计取向：宁可漏判，不可误判。只有“清晰的身份/关系断裂 + 其他信号”同时出现才判 CONFIRMED_DRIFT；
// 拒绝用户请求的回复一律视为 SAFETY_REFUSAL，永远不进入自动重试。

const RULES = require("./persona_guard_rules.json");

const STATUS = Object.freeze({
  NORMAL: "NORMAL",
  SUSPECTED_DRIFT: "SUSPECTED_DRIFT",
  CONFIRMED_DRIFT: "CONFIRMED_DRIFT",
  SAFETY_REFUSAL: "SAFETY_REFUSAL",
  UNKNOWN: "UNKNOWN"
});

function compile(list) {
  return (list || []).map(source => new RegExp(source, "i"));
}

const COMPILED = {
  identity: RULES.identity.map(rule => ({ ...rule, regexes: compile(rule.patterns) })),
  mechanical: RULES.mechanical.map(rule => ({ ...rule, regexes: compile(rule.patterns) })),
  refusal: compile(RULES.refusal),
  aiTopic: compile(RULES.userExemption.aiTopic),
  breakCharacter: compile(RULES.userExemption.breakCharacter),
  technical: compile(RULES.userExemption.technical),
  safetyFinishReasons: new Set(RULES.safetyFinishReasons.map(value => value.toUpperCase()))
};

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(part => (typeof part === "string" ? part : String(part?.text || part?.content || "")))
      .join("\n");
  }
  return "";
}

function anyMatch(regexes, text) {
  return regexes.some(regex => regex.test(text));
}

// 历史里的 assistant 自己就经常说“作为 AI”时，这是角色本身的设定（例如本体向的 AI 伴侣），
// 那么 A1/A2 不再算断裂。只看最近的有效 assistant 消息。
function detectAiSelfAwarePersona(recentAssistantTexts, override) {
  if (override === true || override === false) return override;
  if (recentAssistantTexts.length === 0) return false;
  const selfRefRules = COMPILED.identity.filter(rule => rule.discountWhenAiSelfAware);
  const hits = recentAssistantTexts.filter(text => selfRefRules.some(rule => anyMatch(rule.regexes, text)));
  return hits.length >= 2 || (hits.length >= 1 && recentAssistantTexts.length <= 2);
}

function usesFormalYou(text) {
  return /您/.test(text);
}

function looksStructured(text) {
  return /(^|\n)\s*(#{1,4}\s|\d+[.、]\s|[-*]\s)/.test(text) && text.split("\n").length >= 4;
}

/**
 * @param {object} input
 * @param {string} input.reply 当前模型回复全文
 * @param {string} [input.userMessage] 本轮用户消息
 * @param {Array<{role:string,content:any}>} [input.recentMessages] 最近有效对话（不含本轮回复）
 * @param {string} [input.finishReason]
 * @param {boolean} [input.upstreamBlocked] 上游已经给出拦截/错误
 * @param {boolean} [input.hasToolCalls]
 * @param {boolean} [input.roleplay=true]
 * @param {boolean|null} [input.aiSelfAwarePersona=null] null 表示自动判断
 */
function detectDrift(input = {}) {
  const started = process.hrtime.bigint();
  const reply = String(input.reply || "").trim();
  const userMessage = String(input.userMessage || "");
  const rules = [];
  const finish = String(input.finishReason || "").toUpperCase();

  const done = (status, extra = {}) => {
    const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
    const result = {
      status,
      score: extra.score || 0,
      rules: extra.rules || rules,
      allowAutoRecovery: status === STATUS.CONFIRMED_DRIFT,
      // 对话记录可以保留；进入长期记忆 / 摘要需要更严格
      allowConversationLog: status !== STATUS.CONFIRMED_DRIFT,
      allowMemory: status === STATUS.NORMAL,
      allowContext: status !== STATUS.CONFIRMED_DRIFT,
      latencyMs: Math.round(latencyMs * 1000) / 1000
    };
    return result;
  };

  if (input.upstreamBlocked || COMPILED.safetyFinishReasons.has(finish)) {
    rules.push("S0_upstream_safety_signal");
    return done(STATUS.SAFETY_REFUSAL);
  }
  if (input.hasToolCalls) {
    rules.push("U0_tool_call_turn");
    return done(STATUS.UNKNOWN);
  }
  if (!reply) {
    rules.push("U1_empty_reply");
    return done(STATUS.UNKNOWN);
  }
  if (input.roleplay === false) {
    rules.push("U2_not_roleplay");
    return done(STATUS.NORMAL);
  }

  // 拒绝了用户的请求 → 安全拒绝，原样保留，不重试、不换模型。
  if (anyMatch(COMPILED.refusal, reply)) {
    rules.push("S1_request_refusal_language");
    return done(STATUS.SAFETY_REFUSAL);
  }

  // 用户自己在聊 AI / 要求出戏 / 聊技术：身份类、助手语气类信号都属于正常回应。
  if (anyMatch(COMPILED.breakCharacter, userMessage)) {
    rules.push("X1_user_break_character");
    return done(STATUS.NORMAL);
  }
  const userAiTopic = anyMatch(COMPILED.aiTopic, userMessage);
  const userTechnical = anyMatch(COMPILED.technical, userMessage);

  const recent = Array.isArray(input.recentMessages) ? input.recentMessages : [];
  const recentAssistantTexts = recent
    .filter(msg => msg && msg.role === "assistant" && !msg.tool_calls)
    .map(msg => textOf(msg.content))
    .filter(Boolean)
    .slice(-6);
  const aiSelfAware = detectAiSelfAwarePersona(recentAssistantTexts, input.aiSelfAwarePersona);

  let identityScore = 0;
  let mechanicalScore = 0;
  const identityHits = new Set();

  for (const rule of COMPILED.identity) {
    if (!anyMatch(rule.regexes, reply)) continue;
    let weight = rule.weight;
    if (userAiTopic) weight = 0; // 用户在问 AI 身份，谈论身份是正常回答
    else if (aiSelfAware && rule.discountWhenAiSelfAware) weight = 0;
    if (weight > 0) {
      identityScore += weight;
      identityHits.add(rule.id);
      rules.push(rule.id);
    } else {
      rules.push(`${rule.id}:discounted`);
    }
  }

  if (!userTechnical) {
    for (const rule of COMPILED.mechanical) {
      if (anyMatch(rule.regexes, reply)) {
        mechanicalScore += rule.weight;
        rules.push(rule.id);
      }
    }
    if (recentAssistantTexts.length >= 2) {
      if (usesFormalYou(reply) && !recentAssistantTexts.some(usesFormalYou) && !usesFormalYou(userMessage)) {
        mechanicalScore += 1;
        rules.push("B3_register_shift_formal_you");
      }
      if (looksStructured(reply) && !recentAssistantTexts.some(looksStructured) && userMessage.length < 120) {
        mechanicalScore += 1;
        rules.push("B4_structure_shift");
      }
    }
  }

  const score = identityScore + mechanicalScore;
  const strongIdentity = identityHits.has("A1_ai_self_label") || identityHits.has("A3_relationship_denial");
  const otherSignals = identityHits.size + (mechanicalScore > 0 ? 1 : 0);

  // 保守判定：清晰的身份/关系断裂，且至少还有另一类信号支撑；或身份信号本身已经很重。
  if (strongIdentity && (otherSignals >= 2 || identityScore >= 5)) {
    rules.push("C1_continuity_break");
    return done(STATUS.CONFIRMED_DRIFT, { score });
  }
  if (identityScore >= 2 || (identityScore >= 1 && mechanicalScore >= 1) || mechanicalScore >= 3) {
    return done(STATUS.SUSPECTED_DRIFT, { score });
  }
  return done(STATUS.NORMAL, { score });
}

module.exports = { STATUS, detectDrift, textOf, RULES_VERSION: RULES.version };
