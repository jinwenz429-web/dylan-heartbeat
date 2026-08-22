const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dylan-active-conversation-"));
process.env.DATA_DIR = testDataDir;
process.env.TARGET_API_URL = "https://upstream.example/v1/chat/completions";
process.env.TARGET_API_KEY = "target-secret";
process.env.ALLOW_PUBLIC_API = "true";
process.env.GATEWAY_API_KEY = "gateway-test-key";

const statePath = path.join(testDataDir, "conversation_state.json");
const originalFetch = global.fetch;
const { app } = require("../server");

global.fetch = async () => new Response(
  JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
  { status: 200, headers: { "content-type": "application/json" } }
);

test.after(async () => {
  global.fetch = originalFetch;
  await app.close();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

function writeState(conversationId, receivedAt = "2026-08-22T00:00:00.000Z") {
  fs.writeFileSync(statePath, `${JSON.stringify({
    last_active_conversation_id: conversationId,
    last_active_conversation_received_at: receivedAt
  }, null, 2)}\n`, "utf8");
}

function readState() {
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

async function sendChat({ conversationId, content }) {
  const headers = {
    "content-type": "application/json",
    "x-gateway-api-key": "gateway-test-key"
  };
  if (conversationId !== undefined) headers["x-conversation-id"] = conversationId;

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers,
    payload: {
      model: "test-model",
      stream: false,
      messages: [{ role: "user", content }]
    }
  });

  assert.equal(response.statusCode, 200);
}

test("A: persists the conversation id from a normal chat request", async () => {
  fs.rmSync(statePath, { force: true });

  await sendChat({ conversationId: "conversation-A", content: "normal chat A" });

  const state = readState();
  assert.equal(state.last_active_conversation_id, "conversation-A");
  assert.ok(Number.isFinite(Date.parse(state.last_active_conversation_received_at)));
});

test("B: a later normal chat updates the last active conversation", async () => {
  writeState("conversation-A");

  await sendChat({ conversationId: "conversation-B", content: "normal chat B" });

  assert.equal(readState().last_active_conversation_id, "conversation-B");
});

test("C: missing or blank conversation headers do not overwrite existing state", async () => {
  writeState("conversation-A");

  await sendChat({ content: "normal chat without a conversation header" });
  await sendChat({ conversationId: "   ", content: "normal chat with a blank header" });

  assert.equal(readState().last_active_conversation_id, "conversation-A");
});

test("D: a Kelivo title generation request does not overwrite active conversation", async () => {
  writeState("conversation-A");

  await sendChat({ content: "Generate a concise title for this conversation" });

  assert.equal(readState().last_active_conversation_id, "conversation-A");
});

test("E: active conversation is restored after the state module is reloaded", () => {
  writeState("conversation-B", "2026-08-22T01:02:03.000Z");
  const stateModulePath = require.resolve("../conversation_state");
  delete require.cache[stateModulePath];

  const { loadLastActiveConversation } = require("../conversation_state");

  assert.deepEqual(loadLastActiveConversation(), {
    conversationId: "conversation-B",
    receivedAt: "2026-08-22T01:02:03.000Z"
  });
});
