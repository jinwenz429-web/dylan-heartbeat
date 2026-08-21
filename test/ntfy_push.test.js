const test = require("node:test");
const assert = require("node:assert/strict");

const { sendPushNotification } = require("../wake_up");

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("logs sanitized status and response body for an ntfy HTTP failure", async t => {
  const envNames = ["PUSH_PROVIDER", "NTFY_SERVER_URL", "NTFY_TOPIC", "NTFY_TOKEN"];
  const oldEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  const oldFetch = global.fetch;
  const oldLog = console.log;
  const logs = [];
  const token = "tk_super_secret";

  t.after(() => {
    for (const name of envNames) restoreEnv(name, oldEnv[name]);
    global.fetch = oldFetch;
    console.log = oldLog;
  });

  process.env.PUSH_PROVIDER = "ntfy";
  process.env.NTFY_SERVER_URL = "https://ntfy.sh/";
  process.env.NTFY_TOPIC = "test-topic";
  process.env.NTFY_TOKEN = token;
  console.log = (...args) => logs.push(args.join(" "));
  global.fetch = async (url, options) => {
    assert.equal(url, "https://ntfy.sh");
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.deepEqual(JSON.parse(options.body), {
      topic: "test-topic",
      title: "hello",
      message: "world"
    });
    return new Response(`denied token=${token}`, { status: 403 });
  };

  const result = await sendPushNotification({ title: "hello", body: "world" });
  const diagnostic = logs.join("\n");

  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.responseBody, "denied token=[REDACTED]");
  assert.match(diagnostic, /"event":"ntfy_push_failed"/);
  assert.match(diagnostic, /"status":403/);
  assert.match(diagnostic, /denied token=\[REDACTED\]/);
  assert.doesNotMatch(diagnostic, new RegExp(token));
});

test("logs message and code for an ntfy network failure", async t => {
  const envNames = ["PUSH_PROVIDER", "NTFY_SERVER_URL", "NTFY_TOPIC", "NTFY_TOKEN"];
  const oldEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  const oldFetch = global.fetch;
  const oldLog = console.log;
  const logs = [];

  t.after(() => {
    for (const name of envNames) restoreEnv(name, oldEnv[name]);
    global.fetch = oldFetch;
    console.log = oldLog;
  });

  process.env.PUSH_PROVIDER = "ntfy";
  process.env.NTFY_SERVER_URL = "https://ntfy.sh";
  process.env.NTFY_TOPIC = "test-topic";
  delete process.env.NTFY_TOKEN;
  console.log = (...args) => logs.push(args.join(" "));
  global.fetch = async () => {
    const error = new Error("connect timed out");
    error.code = "ETIMEDOUT";
    throw error;
  };

  const result = await sendPushNotification({ title: "hello", body: "world" });
  const diagnostic = logs.join("\n");

  assert.equal(result.ok, false);
  assert.equal(result.errorMessage, "connect timed out");
  assert.equal(result.errorCode, "ETIMEDOUT");
  assert.match(diagnostic, /"event":"ntfy_push_error"/);
  assert.match(diagnostic, /"error_message":"connect timed out"/);
  assert.match(diagnostic, /"error_code":"ETIMEDOUT"/);
});

test("logs a safe configuration error when the ntfy topic is missing", async t => {
  const oldProvider = process.env.PUSH_PROVIDER;
  const oldTopic = process.env.NTFY_TOPIC;
  const oldLog = console.log;
  const logs = [];

  t.after(() => {
    restoreEnv("PUSH_PROVIDER", oldProvider);
    restoreEnv("NTFY_TOPIC", oldTopic);
    console.log = oldLog;
  });

  process.env.PUSH_PROVIDER = "ntfy";
  delete process.env.NTFY_TOPIC;
  console.log = (...args) => logs.push(args.join(" "));

  const result = await sendPushNotification({ title: "hello", body: "world" });
  const diagnostic = logs.join("\n");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "NTFY_TOPIC 未配置");
  assert.match(diagnostic, /"event":"ntfy_push_config_error"/);
  assert.match(diagnostic, /"reason":"NTFY_TOPIC 未配置"/);
});
