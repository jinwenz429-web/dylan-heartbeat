const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

test("diary persistence failures do not block ntfy push", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dylan-diary-push-"));
  fs.writeFileSync(
    path.join(directory, "enhanced_messages.json"),
    JSON.stringify([
      { role: "system", content: "system" },
      { role: "user", content: "（2020/01/01 00:00:00）hello" }
    ]),
    "utf8"
  );

  const env = {
    DATA_DIR: directory,
    DIARY_ENABLED: "true",
    TARGET_API_URL: "https://pawwake.example.com/v1/chat/completions",
    TARGET_API_KEY: "target-key",
    MODEL_NAME: "model",
    PUSH_PROVIDER: "ntfy",
    NTFY_SERVER_URL: "https://ntfy.example.com",
    NTFY_TOPIC: "topic",
    WEATHER_ENABLED: "false"
  };
  const originalEnv = {};
  for (const [key, value] of Object.entries(env)) {
    originalEnv[key] = process.env[key];
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const persistencePath = require.resolve("../diary_persistence");
  require.cache[persistencePath] = {
    id: persistencePath,
    filename: persistencePath,
    loaded: true,
    exports: {
      persistDiaryRemote: async () => ({ ok: false, reason: "timeout" })
    }
  };

  const calls = [];
  t.mock.method(fs, "appendFileSync", () => {
    throw new Error("disk full");
  });
  t.mock.method(global, "fetch", async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url) === env.TARGET_API_URL) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async text() {
          return JSON.stringify({
            choices: [{ message: { content: "[DIARY]entry[/DIARY]\nTitle\nBody" } }]
          });
        }
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => "text/plain" },
      async text() {
        return "ok";
      }
    };
  });

  try {
    const wakeUp = require("../wake_up");
    assert.equal(typeof wakeUp.runWakeUp, "function", "runWakeUp must be exported");
    await wakeUp.runWakeUp();
    assert.ok(calls.some(call => call.url === env.NTFY_SERVER_URL));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
