const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dylan-auxiliary-"));
process.env.DATA_DIR = dir;
process.env.TARGET_API_URL = "https://upstream.example/v1/chat/completions";
process.env.TARGET_API_KEY = "test-target-secret";
process.env.ALLOW_PUBLIC_API = "true";
process.env.GATEWAY_API_KEY = "test-gateway-secret";
const { app } = require("../server");
const originalFetch = global.fetch;
let forwarded;
global.fetch = async (url, options) => {
  forwarded = options;
  return new Response('{"choices":[{"message":{"content":"ok"}}]}',
    { status: 200, headers: { "content-type": "application/json" } });
};
test.after(async () => {
  global.fetch = originalFetch;
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function send(messages, extraHeaders = {}) {
  const timeline = [{ role: "assistant", content: "（2026/10/03 00:00 自动唤醒：本次未发送）historical event" }];
  const timelineFile = path.join(dir, "enhanced_messages.json");
  const timestampFile = path.join(dir, "message_timestamps.json");
  fs.writeFileSync(timelineFile, JSON.stringify(timeline));
  fs.writeFileSync(timestampFile, "{}");
  const conversationFile = path.join(dir, "conversation_state.json");
  const activityFile = path.join(dir, "last_user_state.json");
  fs.writeFileSync(conversationFile, '{"last_active_conversation_id":"previous-chat"}');
  fs.writeFileSync(activityFile, '{"last_user_received_at":"2026-10-01T00:00:00Z"}');
  const stateFiles = [timelineFile, timestampFile, conversationFile, activityFile];
  const before = stateFiles.map(file => fs.readFileSync(file, "utf8"));
  const response = await app.inject({ method: "POST", url: "/v1/chat/completions",
    headers: { "x-gateway-api-key": "test-gateway-secret", "x-conversation-id": "test-chat", ...extraHeaders },
    payload: { model: "test-model", stream: false, messages } });
  assert.equal(response.statusCode, 200);
  return { before, after: stateFiles.map(file => fs.readFileSync(file, "utf8")),
    messages: JSON.parse(forwarded.body).messages,
    headers: Object.fromEntries(Object.entries(forwarded.headers).map(([k, v]) => [k.toLowerCase(), v])) };
}

test("suggestions bypass event injection and timeline writes, with explicit upstream purpose", async () => {
  const messages = [
    { role: "system", content: 'Generate candidate next messages that the USER can send to the assistant. Return JSON with "suggestions".' },
    { role: "user", content: 'Suggest up to 3 useful next messages for the user, based on the conversation below.\nOutput only JSON: {"suggestions":[]}.' }
  ];
  const result = await send(messages);
  assert.deepEqual(result.messages, messages);
  assert.deepEqual(result.after, result.before);
  assert.equal(result.headers["x-skip-conversation-log"], "true");
});

test("title generation also bypasses chat state", async () => {
  const messages = [{ role: "user", content: "Generate a concise title for the conversation: synthetic chat" }];
  const result = await send(messages);
  assert.deepEqual(result.messages, messages);
  assert.deepEqual(result.after, result.before);
  assert.equal(result.headers["x-skip-conversation-log"], "true");
});

test("explicit auxiliary header is forwarded", async () => {
  const messages = [{ role: "user", content: "auxiliary metadata request" }];
  const result = await send(messages, { "x-skip-conversation-log": "true" });
  assert.deepEqual(result.messages, messages);
  assert.deepEqual(result.after, result.before);
  assert.equal(result.headers["x-skip-conversation-log"], "true");
});

test("ordinary chat retains historical events and is not marked auxiliary", async () => {
  const result = await send([{ role: "user", content: "hello" }]);
  assert.ok(result.messages.some(m => m.content.includes("historical event")));
  assert.notDeepEqual(result.after, result.before);
  assert.equal(result.headers["x-skip-conversation-log"], undefined);
});
