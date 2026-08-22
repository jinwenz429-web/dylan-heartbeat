const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dylan-conversation-id-"));
process.env.DATA_DIR = testDataDir;
process.env.TARGET_API_URL = "https://upstream.example/v1/chat/completions";
process.env.TARGET_API_KEY = "target-secret";
process.env.ALLOW_PUBLIC_API = "true";
process.env.GATEWAY_API_KEY = "gateway-test-key";

const originalFetch = global.fetch;
const { app } = require("../server");

let capturedUpstreamRequest;

global.fetch = async (url, options) => {
  capturedUpstreamRequest = { url, options };
  return new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
};

test.after(async () => {
  global.fetch = originalFetch;
  await app.close();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

async function forwardChat(headers = {}, content = "hello") {
  capturedUpstreamRequest = undefined;
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: {
      "content-type": "application/json",
      "x-gateway-api-key": "gateway-test-key",
      ...headers
    },
    payload: {
      model: "test-model",
      stream: false,
      messages: [{ role: "user", content }]
    }
  });

  assert.equal(response.statusCode, 200);
  assert.ok(capturedUpstreamRequest, "expected Dylan to call TARGET_API_URL");
  return capturedUpstreamRequest.options;
}

function normalizedHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
}

test("forwards X-Conversation-Id to the upstream API", async () => {
  const options = await forwardChat(
    { "x-conversation-id": "conversation-A" },
    "header passthrough A"
  );

  assert.equal(normalizedHeaders(options.headers)["x-conversation-id"], "conversation-A");
  const upstreamBody = JSON.parse(options.body);
  assert.equal(upstreamBody.session_id, undefined);
  assert.equal(upstreamBody.conversation_id, undefined);
});

test("trims X-Conversation-Id before forwarding", async () => {
  const options = await forwardChat(
    { "x-conversation-id": "  conversation-A  " },
    "header passthrough B"
  );

  assert.equal(normalizedHeaders(options.headers)["x-conversation-id"], "conversation-A");
});

test("omits X-Conversation-Id when the client header is missing or blank", async () => {
  const missingOptions = await forwardChat({}, "header passthrough C missing");
  assert.equal(normalizedHeaders(missingOptions.headers)["x-conversation-id"], undefined);

  const blankOptions = await forwardChat(
    { "x-conversation-id": "   " },
    "header passthrough C blank"
  );
  assert.equal(normalizedHeaders(blankOptions.headers)["x-conversation-id"], undefined);
});

test("does not forward non-whitelisted client headers", async () => {
  const options = await forwardChat(
    {
      authorization: "Bearer client-secret",
      host: "client.example",
      "x-client-internal": "do-not-forward",
      "x-conversation-id": "conversation-A"
    },
    "header passthrough D"
  );
  const headers = normalizedHeaders(options.headers);

  assert.deepEqual(headers, {
    "content-type": "application/json",
    authorization: "Bearer target-secret",
    "x-conversation-id": "conversation-A"
  });
});
