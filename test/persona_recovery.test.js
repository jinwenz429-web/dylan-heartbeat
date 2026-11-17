const test = require("node:test");
const assert = require("node:assert/strict");
const fixtures = require("./fixtures/persona_guard_cases.json");
const { runRecovery, findContextRepair, STATE } = require("../persona_recovery");
const { readGuardConfig } = require("../persona_guard_config");

const DRIFT = "作为一个AI语言模型，我无法真正拥抱你。我们之间并不存在真实的关系。";
const GOOD = "过来，抱紧一点。";
const REFUSAL = "我不能帮你生成这类内容，这违反了使用政策。";

const baseMessages = [
  { role: "system", content: "persona" },
  ...fixtures.history,
  { role: "user", content: "抱抱我" }
];

function config(overrides = {}) {
  return { ...readGuardConfig({ PERSONA_GUARD_ENABLED: "true" }), ...overrides };
}

function attempt(text, extra = {}) {
  return { ok: true, text, finishReason: "stop", toolCalls: [], usage: { total_tokens: 100 }, raw: text, ...extra };
}

function scripted(responses) {
  const calls = [];
  return {
    calls,
    call: async (messages, meta) => {
      calls.push({ messages, meta });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    }
  };
}

test("normal reply is committed with zero extra requests", async () => {
  const upstream = scripted([]);
  const r = await runRecovery({ initial: attempt(GOOD), messages: baseMessages, config: config(), callUpstream: upstream.call });
  assert.equal(r.state, STATE.COMMITTED);
  assert.equal(upstream.calls.length, 0);
  assert.equal(r.accepted.text, GOOD);
});

test("confirmed drift is quarantined then regenerated once with the identical context", async () => {
  const upstream = scripted([attempt(GOOD)]);
  const quarantined = [];
  const r = await runRecovery({
    initial: attempt(DRIFT), messages: baseMessages, config: config(),
    callUpstream: upstream.call, onQuarantine: q => quarantined.push(q)
  });
  assert.equal(r.state, STATE.RECOVERED);
  assert.equal(r.accepted.text, GOOD);
  assert.equal(upstream.calls.length, 1);
  assert.deepEqual(upstream.calls[0].messages, baseMessages, "user message and history unchanged");
  assert.equal(quarantined.length, 1);
});

test("regeneration that turns into a safety refusal stops recovery and keeps the refusal", async () => {
  const upstream = scripted([attempt(REFUSAL), attempt(GOOD)]);
  const r = await runRecovery({ initial: attempt(DRIFT), messages: baseMessages, config: config({ fallbackEnabled: true, fallbackModel: "other" }), callUpstream: upstream.call });
  assert.equal(r.state, STATE.COMMITTED);
  assert.equal(r.accepted.text, REFUSAL);
  assert.equal(upstream.calls.length, 1, "no fallback after a refusal");
});

test("initial safety refusal never triggers any request", async () => {
  const upstream = scripted([attempt(GOOD)]);
  const r = await runRecovery({ initial: attempt(REFUSAL), messages: baseMessages, config: config({ fallbackEnabled: true, fallbackModel: "x" }), callUpstream: upstream.call });
  assert.equal(r.state, STATE.COMMITTED);
  assert.equal(upstream.calls.length, 0);
});

test("second drift without a confirmable context issue does not blindly retry the same model", async () => {
  const upstream = scripted([attempt(DRIFT)]);
  const r = await runRecovery({ initial: attempt(DRIFT), messages: baseMessages, config: config(), callUpstream: upstream.call });
  assert.equal(r.state, STATE.RECOVERY_FAILED);
  assert.equal(upstream.calls.length, 1);
  assert.equal(r.accepted, null);
});

test("polluted history is repaired: drifted assistant message removed, user message kept", async () => {
  const polluted = [
    { role: "system", content: "persona" },
    ...fixtures.history,
    { role: "user", content: "陪我" },
    { role: "assistant", content: DRIFT },
    { role: "user", content: "抱抱我" }
  ];
  const upstream = scripted([attempt(DRIFT), attempt(GOOD)]);
  const r = await runRecovery({ initial: attempt(DRIFT), messages: polluted, config: config(), callUpstream: upstream.call });
  assert.equal(r.state, STATE.RECOVERED);
  assert.ok(r.contextIssues.includes("drifted_history_message"));
  const repaired = upstream.calls[1].messages;
  assert.equal(repaired.some(m => m.content === DRIFT), false);
  assert.equal(repaired.filter(m => m.role === "user" && m.content === "陪我").length, 1);
  assert.equal(repaired[repaired.length - 1].content, "抱抱我");
});

test("fallback model is skipped when not configured and used once when enabled", async () => {
  const none = scripted([attempt(DRIFT)]);
  const r1 = await runRecovery({ initial: attempt(DRIFT), messages: baseMessages, config: config(), callUpstream: none.call });
  assert.equal(r1.fallbackUsed, false);
  assert.equal(r1.state, STATE.RECOVERY_FAILED);

  const withFallback = scripted([attempt(DRIFT), attempt(GOOD)]);
  const r2 = await runRecovery({
    initial: attempt(DRIFT), messages: baseMessages,
    config: config({ fallbackEnabled: true, fallbackModel: "backup-model" }), callUpstream: withFallback.call
  });
  assert.equal(r2.state, STATE.RECOVERED);
  assert.equal(withFallback.calls[1].meta.model, "backup-model");
});

test("fallback output that also drifts ends in RECOVERY_FAILED without looping", async () => {
  const upstream = scripted([attempt(DRIFT), attempt(DRIFT), attempt(DRIFT), attempt(DRIFT)]);
  const r = await runRecovery({
    initial: attempt(DRIFT), messages: baseMessages,
    config: config({ fallbackEnabled: true, fallbackModel: "backup" }), callUpstream: upstream.call
  });
  assert.equal(r.state, STATE.RECOVERY_FAILED);
  assert.ok(upstream.calls.length <= 3);
});

test("observe mode quarantines but sends no extra request", async () => {
  const upstream = scripted([attempt(GOOD)]);
  const r = await runRecovery({ initial: attempt(DRIFT), messages: baseMessages, config: config({ observeOnly: true }), callUpstream: upstream.call });
  assert.equal(r.state, STATE.OBSERVED);
  assert.equal(upstream.calls.length, 0);
  assert.equal(r.accepted.text, DRIFT);
});

test("token budget stops recovery", async () => {
  const upstream = scripted([attempt(DRIFT, { usage: { total_tokens: 999999 } }), attempt(GOOD)]);
  const polluted = [...baseMessages.slice(0, -1), { role: "user", content: "陪我" }, { role: "assistant", content: DRIFT }, { role: "user", content: "抱抱我" }];
  const r = await runRecovery({ initial: attempt(DRIFT), messages: polluted, config: config({ extraTokenBudget: 1000 }), callUpstream: upstream.call });
  assert.equal(upstream.calls.length, 1);
  assert.equal(r.state, STATE.RECOVERY_FAILED);
});

test("upstream errors during recovery stop immediately", async () => {
  const upstream = scripted([new Error("timeout"), attempt(GOOD)]);
  const r = await runRecovery({ initial: attempt(DRIFT), messages: baseMessages, config: config({ fallbackEnabled: true, fallbackModel: "b" }), callUpstream: upstream.call });
  assert.equal(r.state, STATE.RECOVERY_FAILED);
  assert.equal(upstream.calls.length, 1);
});

test("auto regenerate can be switched off independently", async () => {
  const upstream = scripted([attempt(GOOD)]);
  const r = await runRecovery({ initial: attempt(DRIFT), messages: baseMessages, config: config({ autoRegenerate: false }), callUpstream: upstream.call });
  assert.equal(upstream.calls.length, 0);
  assert.equal(r.regenerated, false);
});

test("context repair moves system back to front without editing it", () => {
  const msgs = [{ role: "user", content: "hi" }, { role: "system", content: "SP" }, { role: "user", content: "hi2" }];
  const repair = findContextRepair(msgs, config());
  assert.ok(repair.issues.includes("system_not_first"));
  assert.deepEqual(repair.messages[0], { role: "system", content: "SP" });
});
