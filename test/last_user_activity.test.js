const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dylan-last-user-activity-"));
process.env.DATA_DIR = testDataDir;
process.env.TARGET_API_URL = "https://upstream.example/v1/chat/completions";
process.env.TARGET_API_KEY = "target-secret";
process.env.ALLOW_PUBLIC_API = "true";
process.env.GATEWAY_API_KEY = "gateway-test-key";

const lastUserStatePath = path.join(testDataDir, "last_user_state.json");
const timelinePath = path.join(testDataDir, "enhanced_messages.json");
const timestampPath = path.join(testDataDir, "message_timestamps.json");
const conversationStatePath = path.join(testDataDir, "conversation_state.json");
const originalFetch = global.fetch;
let upstreamStatus = 200;
const { app } = require("../server");
const { getLastUserTime } = require("../wake_up");

global.fetch = async () => new Response(
  JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
  { status: upstreamStatus, headers: { "content-type": "application/json" } }
);

test.after(async () => {
  global.fetch = originalFetch;
  await app.close();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

test.beforeEach(() => {
  upstreamStatus = 200;
  for (const file of [lastUserStatePath, timelinePath, timestampPath, conversationStatePath]) {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}.bak`, { force: true });
  }
});

function writeLastUserState(value = "2020-01-01T00:00:00.000Z") {
  fs.writeFileSync(lastUserStatePath, `${JSON.stringify({
    last_user_received_at: value
  }, null, 2)}\n`, "utf8");
}

function readLastUserState() {
  return JSON.parse(fs.readFileSync(lastUserStatePath, "utf8"));
}

async function sendChat({ conversationId, messages }) {
  const headers = {
    "content-type": "application/json",
    "x-gateway-api-key": "gateway-test-key"
  };
  if (conversationId !== undefined) headers["x-conversation-id"] = conversationId;

  return app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers,
    payload: { model: "test-model", stream: false, messages }
  });
}

test("C: retention can remove the final user without losing persisted user activity", async () => {
  const chatResponse = await sendChat({
    conversationId: "conversation-A",
    messages: [{ role: "user", content: "真实用户消息" }]
  });
  assert.equal(chatResponse.statusCode, 200);

  for (let index = 0; index < 12; index++) {
    const response = await app.inject({
      method: "POST",
      url: "/internal/wake-event",
      payload: { content: `（2026-08-23 0${index % 10}:00 自动唤醒：第 ${index + 1} 次）` }
    });
    assert.equal(response.statusCode, 200);
  }

  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
  assert.equal(timeline.length, 12);
  assert.equal(timeline.some(message => message.role === "user"), false);

  const recovered = getLastUserTime(timeline, {});
  assert.equal(recovered?.source, "last_user_state");
  assert.ok(Number.isFinite(recovered?.time.getTime()));
});

test("D1: a real user request with a conversation id updates last user activity", async () => {
  writeLastUserState();
  const response = await sendChat({
    conversationId: "conversation-A",
    messages: [{ role: "user", content: "新的真实用户消息" }]
  });

  assert.equal(response.statusCode, 200);
  const state = readLastUserState();
  assert.ok(Date.parse(state.last_user_received_at) > Date.parse("2020-01-01T00:00:00.000Z"));
});

test("D2: received real user activity is retained even when upstream fails", async () => {
  writeLastUserState();
  upstreamStatus = 500;

  const response = await sendChat({
    conversationId: "conversation-A",
    messages: [{ role: "user", content: "上游失败前已收到的消息" }]
  });

  assert.equal(response.statusCode, 500);
  const state = readLastUserState();
  assert.ok(Date.parse(state.last_user_received_at) > Date.parse("2020-01-01T00:00:00.000Z"));
});

test("D3: timestamp memory and last user state use the same request receive time", async () => {
  writeLastUserState();
  const content = "需要同一接收时间";

  const response = await sendChat({
    conversationId: "conversation-A",
    messages: [{ role: "user", content }]
  });

  assert.equal(response.statusCode, 200);
  const state = readLastUserState();
  const timestampDB = JSON.parse(fs.readFileSync(timestampPath, "utf8"));
  assert.equal(timestampDB[`user::${content}`], state.last_user_received_at);
});

for (const [name, messages] of [
  ["assistant", [
    { role: "user", content: "historical user" },
    { role: "assistant", content: "assistant continuation" }
  ]],
  ["system", [
    { role: "user", content: "historical user" },
    { role: "system", content: "system request" }
  ]],
  ["tool", [
    { role: "user", content: "historical user" },
    { role: "tool", tool_call_id: "call-1", content: "tool result" }
  ]],
  ["<system> pseudo user", [{ role: "user", content: "<system>internal rule</system>" }]]
]) {
  test(`E: ${name} request does not update last user activity`, async () => {
    writeLastUserState();
    const response = await sendChat({ conversationId: "conversation-A", messages });
    assert.equal(response.statusCode, 200);
    assert.equal(readLastUserState().last_user_received_at, "2020-01-01T00:00:00.000Z");
  });
}

test("E: a headerless Kelivo title request does not update last user activity", async () => {
  writeLastUserState();
  const response = await sendChat({
    messages: [{ role: "user", content: "Generate a concise title for this conversation" }]
  });
  assert.equal(response.statusCode, 200);
  assert.equal(readLastUserState().last_user_received_at, "2020-01-01T00:00:00.000Z");
});

test("E: a user request with a blank conversation id does not update last user activity", async () => {
  writeLastUserState();
  const response = await sendChat({
    conversationId: "   ",
    messages: [{ role: "user", content: "没有有效 conversation id" }]
  });
  assert.equal(response.statusCode, 200);
  assert.equal(readLastUserState().last_user_received_at, "2020-01-01T00:00:00.000Z");
});

test("E: wake-event and heartbeat endpoints do not update last user activity", async () => {
  writeLastUserState();

  const wakeResponse = await app.inject({
    method: "POST",
    url: "/internal/wake-event",
    payload: { content: "（2026-08-23 10:00 自动唤醒：测试）" }
  });
  const heartbeatResponse = await app.inject({ method: "POST", url: "/internal/heartbeat" });

  assert.equal(wakeResponse.statusCode, 200);
  assert.equal(heartbeatResponse.statusCode, 200);
  assert.equal(readLastUserState().last_user_received_at, "2020-01-01T00:00:00.000Z");
});
