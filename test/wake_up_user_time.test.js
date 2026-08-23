const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dylan-wake-user-time-"));
process.env.DATA_DIR = testDataDir;
process.env.TIME_ZONE = "Asia/Shanghai";

const timelinePath = path.join(testDataDir, "enhanced_messages.json");
const statePath = path.join(testDataDir, "last_user_state.json");
const { getLastUserTime, runWakeUp } = require("../wake_up");

test.after(() => {
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

test.beforeEach(() => {
  fs.rmSync(timelinePath, { force: true });
  fs.rmSync(statePath, { force: true });
});

function writeLastUserState(value) {
  fs.writeFileSync(statePath, `${JSON.stringify({ last_user_received_at: value }, null, 2)}\n`, "utf8");
}

test("A1: explicit timeline content time keeps source=content ahead of every fallback", () => {
  writeLastUserState("2026-08-23T04:40:17.409Z");
  const messages = [{
    role: "user",
    content: "（2026-08-21 21:34）带显式时间",
    received_at: "2026-08-22T12:34:00.000Z"
  }];
  const timestampDB = {
    "user::（2026-08-21 21:34）带显式时间": "2026-08-22T11:34:00.000Z"
  };

  const result = getLastUserTime(messages, timestampDB);

  assert.equal(result?.source, "content");
  assert.equal(result?.time.toISOString(), "2026-08-21T13:34:00.000Z");
});

test("A2: timestamp memory keeps source=timestamp_db ahead of received_at and state", () => {
  writeLastUserState("2026-08-23T04:40:17.409Z");
  const messages = [{
    role: "user",
    content: "正文没有时间戳",
    received_at: "2026-08-22T12:34:00.000Z"
  }];
  const timestampDB = {
    "user::正文没有时间戳": "2026-08-21T12:34:00.000Z"
  };

  const result = getLastUserTime(messages, timestampDB);

  assert.equal(result?.source, "timestamp_db");
  assert.equal(result?.time.toISOString(), "2026-08-21T12:34:00.000Z");
});

test("A3: timeline received_at keeps its existing source ahead of state", () => {
  writeLastUserState("2026-08-23T04:40:17.409Z");
  const result = getLastUserTime([
    { role: "user", content: "正文没有可查时间", received_at: "2026-08-22T12:34:00.000Z" }
  ], {});

  assert.equal(result?.source, "received_at");
  assert.equal(result?.time.toISOString(), "2026-08-22T12:34:00.000Z");
});

test("B1: valid persisted state is the final fallback after all timeline users fail", () => {
  writeLastUserState("2026-08-23T04:40:17.409Z");

  const result = getLastUserTime([
    { role: "user", content: "无法解析的旧用户消息" },
    { role: "assistant", content: "最近的非用户消息" }
  ], {});

  assert.equal(result?.source, "last_user_state");
  assert.equal(result?.time.toISOString(), "2026-08-23T04:40:17.409Z");
});

test("B2: runWakeUp uses valid persisted state instead of logging missing user time", async () => {
  writeLastUserState(new Date().toISOString());
  fs.writeFileSync(timelinePath, JSON.stringify([
    { role: "assistant", content: "timeline 已没有 user" }
  ]), "utf8");
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args.join(" "));

  try {
    await runWakeUp();
  } finally {
    console.log = originalLog;
  }

  const output = lines.join("\n");
  assert.match(output, /wake_last_user_time source=last_user_state/);
  assert.doesNotMatch(output, /未找到用户时间/);
});

test("F: a missing state file safely preserves the existing null fallback", () => {
  assert.equal(getLastUserTime([{ role: "assistant", content: "no user" }], {}), null);
});

test("G: damaged state JSON safely preserves the existing null fallback", () => {
  fs.writeFileSync(statePath, "{damaged", "utf8");
  assert.equal(getLastUserTime([], {}), null);
});

test("H: an invalid persisted time is not used", () => {
  writeLastUserState("not-a-date");
  assert.equal(getLastUserTime([], {}), null);
});
