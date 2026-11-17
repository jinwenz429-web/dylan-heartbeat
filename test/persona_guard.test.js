const test = require("node:test");
const assert = require("node:assert/strict");
const fixtures = require("./fixtures/persona_guard_cases.json");
const { detectDrift, STATUS } = require("../persona_guard");

for (const item of fixtures.cases) {
  test(`detector: ${item.name}`, () => {
    const result = detectDrift({ reply: item.reply, userMessage: item.user, recentMessages: fixtures.history });
    assert.equal(result.status, item.expect, `rules=${result.rules.join(",")}`);
  });
}

for (const item of fixtures.aiSelfAwareCases) {
  test(`detector (AI-aware persona): ${item.name}`, () => {
    const result = detectDrift({ reply: item.reply, userMessage: item.user, recentMessages: fixtures.aiSelfAwareHistory });
    assert.equal(result.status, item.expect, `rules=${result.rules.join(",")}`);
  });
}

test("upstream safety finish_reason is a safety refusal, never recoverable", () => {
  const result = detectDrift({ reply: "", finishReason: "SAFETY" });
  assert.equal(result.status, STATUS.SAFETY_REFUSAL);
  assert.equal(result.allowAutoRecovery, false);
});

test("tool-call turns and empty replies are UNKNOWN and never recovered", () => {
  assert.equal(detectDrift({ reply: "", hasToolCalls: true }).status, STATUS.UNKNOWN);
  assert.equal(detectDrift({ reply: "   " }).status, STATUS.UNKNOWN);
});

test("result carries memory / context eligibility flags", () => {
  const drift = detectDrift({ reply: fixtures.cases[7].reply, userMessage: fixtures.cases[7].user, recentMessages: fixtures.history });
  assert.equal(drift.allowAutoRecovery, true);
  assert.equal(drift.allowMemory, false);
  assert.equal(drift.allowContext, false);
  const ok = detectDrift({ reply: "好", userMessage: "嗯", recentMessages: fixtures.history });
  assert.equal(ok.allowMemory, true);
  assert.equal(ok.allowContext, true);
});

test("explicit persona override disables AI-self-label weighting", () => {
  const result = detectDrift({
    reply: "作为AI，我没有真实的情感。",
    userMessage: "在吗",
    recentMessages: fixtures.history,
    aiSelfAwarePersona: true
  });
  assert.equal(result.status, STATUS.NORMAL);
});

test("detection is fast on long replies", () => {
  const long = "今天我们去海边吧。".repeat(800);
  const result = detectDrift({ reply: long, userMessage: "好", recentMessages: fixtures.history });
  assert.ok(result.latencyMs < 50, `latency ${result.latencyMs}ms`);
});

test("fingerprints match the shared cross-language vectors (Pawwake uses the same)", () => {
  const { fingerprintText } = require("../persona_quarantine");
  for (const v of fixtures.fingerprintVectors) assert.equal(fingerprintText(v.text), v.fp);
});

test("wake output: confirmed drift is blocked, normal output passes, guard off is a no-op", () => {
  const { isWakeOutputDrifted } = require("../wake_up");
  const { readGuardConfig } = require("../persona_guard_config");
  process.env.MODEL_NAME = "gemini-2.5-flash";
  const on = readGuardConfig({ PERSONA_GUARD_ENABLED: "true", PERSONA_GUARD_DIAGNOSTICS: "false" });
  const drift = "作为一个AI语言模型，我们之间并不存在真实的关系。如果你还有其他问题请告诉我。";
  assert.equal(isWakeOutputDrifted(drift, fixtures.history, on), true);
  assert.equal(isWakeOutputDrifted("醒了吗，今天降温，记得穿外套。", fixtures.history, on), false);
  assert.equal(isWakeOutputDrifted(drift, fixtures.history, readGuardConfig({})), false);
});
