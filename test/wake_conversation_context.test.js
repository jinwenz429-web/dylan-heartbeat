const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const wakeUpPath = path.join(__dirname, "..", "wake_up.js");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function captureWakeRequest({ conversationId }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dylan-wake-conversation-"));
  fs.writeFileSync(path.join(dataDir, "enhanced_messages.json"), JSON.stringify([
    { role: "system", content: "system prompt" },
    { role: "user", content: "an old user message", received_at: "2020-01-01T00:00:00.000Z" }
  ]));
  if (conversationId) {
    fs.writeFileSync(path.join(dataDir, "conversation_state.json"), JSON.stringify({
      last_active_conversation_id: conversationId,
      last_active_conversation_received_at: "2026-08-22T01:02:03.000Z"
    }));
  }

  let child;
  let output = "";
  let resolveCaptured;
  let rejectCaptured;
  const captured = new Promise((resolve, reject) => {
    resolveCaptured = resolve;
    rejectCaptured = reject;
  });

  const server = http.createServer((request, response) => {
    if (request.url === "/v1/chat/completions") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        resolveCaptured({ headers: request.headers, body: JSON.parse(body) });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "[NO_ACTION]" } }]
        }));
      });
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });

  return {
    async start() {
      const address = await listen(server);
      const baseUrl = `http://127.0.0.1:${address.port}`;
      child = spawn(process.execPath, [wakeUpPath], {
        env: {
          ...process.env,
          DATA_DIR: dataDir,
          PORT: String(address.port),
          GATEWAY_BASE_URL: baseUrl,
          TARGET_API_URL: `${baseUrl}/v1/chat/completions`,
          TARGET_API_KEY: "target-secret",
          MODEL_NAME: "test-model",
          DAY_WAKE_AFTER_MINUTES: "1",
          NIGHT_WAKE_AFTER_MINUTES: "1",
          WEATHER_LOCATION: ""
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { output += chunk; });
      child.once("error", rejectCaptured);

      const timeout = setTimeout(() => {
        rejectCaptured(new Error(`timed out waiting for wake request\n${output}`));
      }, 20_000);
      try {
        return await captured;
      } finally {
        clearTimeout(timeout);
      }
    },
    async stop() {
      if (child && !child.killed) child.kill();
      await close(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

test("F: wake model request carries the persisted active conversation id", async () => {
  const harness = captureWakeRequest({ conversationId: "conversation-A" });
  try {
    const request = await harness.start();
    assert.equal(request.headers["x-conversation-id"], "conversation-A");
  } finally {
    await harness.stop();
  }
});

test("G/H: wake header builder preserves fallback and the fixed authorization allowlist", () => {
  const { buildWakeHeaders } = require("../wake_up");

  assert.deepEqual(buildWakeHeaders("target-secret", null), {
    "Content-Type": "application/json",
    Authorization: "Bearer target-secret"
  });
  assert.deepEqual(buildWakeHeaders("target-secret", { conversationId: "conversation-A" }), {
    "Content-Type": "application/json",
    Authorization: "Bearer target-secret",
    "X-Conversation-Id": "conversation-A"
  });
});
