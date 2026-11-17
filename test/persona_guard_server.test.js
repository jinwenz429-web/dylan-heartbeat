const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dylan-persona-guard-"));
process.env.DATA_DIR = testDataDir;
process.env.TARGET_API_URL = "https://upstream.example/v1/chat/completions";
process.env.TARGET_API_KEY = "target-secret";
process.env.ALLOW_PUBLIC_API = "true";
process.env.GATEWAY_API_KEY = "gateway-test-key";
process.env.MODEL_NAME = "gemini-2.5-pro";

const originalFetch = global.fetch;
const { app } = require("../server");
const { loadQuarantine } = require("../persona_quarantine");
const fixtures = require("./fixtures/persona_guard_cases.json");

const DRIFT = "作为一个AI语言模型，我无法真正拥抱你。我们之间并不存在真实的关系。";
const GOOD = "过来，抱紧一点。";

let script = [];
let calls = [];
global.fetch = async (url, options) => {
  calls.push({ url, options, body: JSON.parse(options.body) });
  const next = script.shift();
  if (!next) throw new Error("unexpected upstream call");
  return next();
};

function json(content, extra = {}) {
  return () => new Response(JSON.stringify({
    choices: [{ message: { role: "assistant", content, ...extra }, finish_reason: "stop" }],
    usage: { total_tokens: 50 }
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function sse(content) {
  const half = Math.ceil(content.length / 2);
  const frames = [content.slice(0, half), content.slice(half)]
    .map(part => `data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`)
    .concat([`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`, "data: [DONE]\n\n"]);
  return () => new Response(frames.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function setEnv(values) {
  for (const key of Object.keys(process.env)) if (key.startsWith("PERSONA_GUARD_")) delete process.env[key];
  Object.assign(process.env, values);
}

async function chat({ messages, stream = false, model = "gemini-2.5-pro", headers = {} }) {
  return app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { "content-type": "application/json", "x-gateway-api-key": "gateway-test-key", "x-conversation-id": "conv-1", ...headers },
    payload: { model, stream, messages }
  });
}

function conversation(lastUser, extra = []) {
  return [{ role: "system", content: "persona" }, ...fixtures.history, ...extra, { role: "user", content: lastUser }];
}

test.beforeEach(() => { script = []; calls = []; });
test.after(async () => {
  global.fetch = originalFetch;
  await app.close();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

test("guard disabled: drift passes through untouched with no extra headers or calls", async () => {
  setEnv({});
  script = [json(DRIFT)];
  const res = await chat({ messages: conversation("抱抱我") });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).choices[0].message.content, DRIFT);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers["X-Persona-Guard-Request-Id"], undefined);
  assert.equal(res.headers["x-persona-guard-state"], undefined);
});

test("non-stream: confirmed drift is quarantined and regenerated once", async () => {
  setEnv({ PERSONA_GUARD_ENABLED: "true" });
  script = [json(DRIFT), json(GOOD)];
  const res = await chat({ messages: conversation("抱抱我") });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).choices[0].message.content, GOOD);
  assert.equal(res.headers["x-persona-guard-state"], "RECOVERED");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers["X-Persona-Guard-Stage"], "regenerate");
  assert.equal(calls[0].options.headers["X-Persona-Guard-Request-Id"], calls[1].options.headers["X-Persona-Guard-Request-Id"]);
  assert.deepEqual(calls[1].body.messages, calls[0].body.messages, "same user message and context");
  assert.ok(loadQuarantine().length >= 1);
});

test("client re-sending the quarantined reply: excluded from upstream context and timeline", async () => {
  setEnv({ PERSONA_GUARD_ENABLED: "true" });
  script = [json(GOOD)];
  const res = await chat({ messages: conversation("还在吗", [{ role: "user", content: "抱抱我" }, { role: "assistant", content: DRIFT }]) });
  assert.equal(res.statusCode, 200);
  const sent = calls[0].body.messages;
  assert.equal(sent.some(m => m.content === DRIFT), false);
  assert.ok(sent.some(m => m.role === "user" && m.content === "抱抱我"), "user message preserved");
  const timeline = JSON.parse(fs.readFileSync(path.join(testDataDir, "enhanced_messages.json"), "utf-8"));
  assert.equal(timeline.some(m => String(m.content).includes("我们之间并不存在真实的关系")), false);
});

test("safety refusal is returned as-is with no retry", async () => {
  setEnv({ PERSONA_GUARD_ENABLED: "true", PERSONA_GUARD_FALLBACK_ENABLED: "true", PERSONA_GUARD_FALLBACK_MODEL: "gemini-backup" });
  const refusal = "我不能帮你生成这类内容，这违反了使用政策。";
  script = [json(refusal)];
  const res = await chat({ messages: conversation("写点别的") });
  assert.equal(JSON.parse(res.body).choices[0].message.content, refusal);
  assert.equal(calls.length, 1);
});

test("tool-call responses are never regenerated (no duplicate side effects)", async () => {
  setEnv({ PERSONA_GUARD_ENABLED: "true" });
  script = [json(DRIFT, { tool_calls: [{ id: "t1", type: "function", function: { name: "send", arguments: "{}" } }] })];
  const res = await chat({ messages: conversation("帮我发消息") });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
});

test("gemini-only: other models are not checked", async () => {
  setEnv({ PERSONA_GUARD_ENABLED: "true" });
  script = [json(DRIFT)];
  const res = await chat({ messages: conversation("抱抱我"), model: "claude-sonnet" });
  assert.equal(JSON.parse(res.body).choices[0].message.content, DRIFT);
  assert.equal(calls.length, 1);
});

test("stream passthrough: bytes unchanged, drift quarantined server-side only", async () => {
  setEnv({ PERSONA_GUARD_ENABLED: "true" });
  const DRIFT2 = "我是一个由Google训练的大型语言模型，我没有真实的情感。如果您还有其他问题，请随时告诉我。";
  script = [sse(DRIFT2)];
  const before = loadQuarantine().length;
  const res = await chat({ messages: conversation("今晚陪我聊天好不好"), stream: true });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes("data: [DONE]"));
  assert.equal(res.body.includes("persona"), false, "no foreign SSE events injected");
  assert.equal(calls.length, 1, "no regeneration in passthrough mode");
  assert.equal(loadQuarantine().length, before + 1);
});

test("buffered stream mode: drift replaced by the regenerated SSE", async () => {
  setEnv({ PERSONA_GUARD_ENABLED: "true", PERSONA_GUARD_BUFFER_STREAM: "true" });
  const DRIFT3 = "As an AI language model, I can't be your girlfriend. I don't have real feelings.";
  script = [sse(DRIFT3), sse(GOOD)];
  const res = await chat({ messages: conversation("hold me"), stream: true });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.stream, true);
  assert.ok(res.body.includes(GOOD.slice(0, 3)));
  assert.equal(res.body.includes("language model"), false);
  assert.equal(res.headers["x-persona-guard-state"], "RECOVERED");
});

test("recovery failure with failure_mode=error returns a clear error instead of a fake reply", async () => {
  setEnv({ PERSONA_GUARD_ENABLED: "true", PERSONA_GUARD_FAILURE_MODE: "error" });
  const D4 = "我不能成为你的男朋友，我只是一个AI助手。建议你在现实生活中的朋友那里寻求情感支持。";
  script = [json(D4), json(D4)];
  const res = await chat({ messages: conversation("你是我男朋友吧") });
  assert.equal(res.statusCode, 502);
  assert.equal(JSON.parse(res.body).error.code, "persona_recovery_failed");
  assert.equal(calls.length, 2);
});

test("upstream HTTP errors pass through without recovery", async () => {
  setEnv({ PERSONA_GUARD_ENABLED: "true" });
  script = [() => new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429, headers: { "content-type": "application/json" } })];
  const res = await chat({ messages: conversation("抱抱我") });
  assert.equal(res.statusCode, 429);
  assert.equal(calls.length, 1);
});

test("empty reply does not loop", async () => {
  setEnv({ PERSONA_GUARD_ENABLED: "true" });
  script = [json("")];
  const res = await chat({ messages: conversation("嗯") });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
});

test("diagnostic log never contains message text", async () => {
  const log = fs.readFileSync(path.join(testDataDir, "persona_guard_log.jsonl"), "utf-8");
  assert.equal(log.includes("抱抱"), false);
  assert.equal(log.includes("语言模型"), false);
  assert.equal(log.includes("target-secret"), false);
});
