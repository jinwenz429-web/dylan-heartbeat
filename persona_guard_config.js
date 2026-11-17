"use strict";

// 所有开关都从环境变量读取，每次调用重新读，管理页改 .env + 重启后即生效。
// 总开关默认关闭：合并代码后不改变任何现有行为，需要显式 PERSONA_GUARD_ENABLED=true 才启用（灰度）。

function bool(env, key, fallback) {
  const raw = String(env[key] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function int(env, key, fallback, min = 0) {
  const n = Number(env[key]);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

function str(env, key, fallback = "") {
  const value = String(env[key] ?? "").trim();
  return value || fallback;
}

function triState(env, key) {
  const raw = String(env[key] ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return null; // auto
}

function readGuardConfig(env = process.env) {
  return {
    enabled: bool(env, "PERSONA_GUARD_ENABLED", false),
    geminiOnly: bool(env, "PERSONA_GUARD_GEMINI_ONLY", true),
    mode: str(env, "PERSONA_GUARD_MODE", "conservative"),
    // observe：只检测、隔离、记日志，不发任何额外请求（推荐的灰度第一步）
    observeOnly: str(env, "PERSONA_GUARD_MODE", "conservative").toLowerCase() === "observe",
    autoRegenerate: bool(env, "PERSONA_GUARD_AUTO_REGENERATE", true),
    maxRegenerations: Math.min(int(env, "PERSONA_GUARD_MAX_REGENERATIONS", 1), 1),
    contextRepair: bool(env, "PERSONA_GUARD_CONTEXT_REPAIR", true),
    fallbackEnabled: bool(env, "PERSONA_GUARD_FALLBACK_ENABLED", false),
    fallbackModel: str(env, "PERSONA_GUARD_FALLBACK_MODEL"),
    fallbackApiUrl: str(env, "PERSONA_GUARD_FALLBACK_API_URL"),
    fallbackApiKeyEnv: str(env, "PERSONA_GUARD_FALLBACK_API_KEY_ENV"),
    bufferStream: bool(env, "PERSONA_GUARD_BUFFER_STREAM", false),
    llmJudgeEnabled: false, // 预留接口：第一版不实现任何模型复核调用
    diagnostics: bool(env, "PERSONA_GUARD_DIAGNOSTICS", true),
    maxExtraRequests: Math.min(int(env, "PERSONA_GUARD_MAX_EXTRA_REQUESTS", 3, 0), 3),
    extraTokenBudget: int(env, "PERSONA_GUARD_EXTRA_TOKEN_BUDGET", 60000, 0),
    recoveryTimeoutMs: int(env, "PERSONA_GUARD_RECOVERY_TIMEOUT_MS", 120000, 1000),
    aiSelfAwarePersona: triState(env, "PERSONA_GUARD_AI_SELF_AWARE_PERSONA"),
    failureMode: str(env, "PERSONA_GUARD_FAILURE_MODE", "passthrough").toLowerCase(), // passthrough | error
    checkWake: bool(env, "PERSONA_GUARD_CHECK_WAKE", true)
  };
}

function guardAppliesToModel(config, model) {
  if (!config.enabled) return false;
  if (!config.geminiOnly) return true;
  return /gemini/i.test(String(model || ""));
}

module.exports = { readGuardConfig, guardAppliesToModel };
