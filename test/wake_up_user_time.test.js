const test = require("node:test");
const assert = require("node:assert/strict");

const { getLastUserTime } = require("../wake_up");

test("uses timestamp memory when a user message has no timestamp prefix", () => {
  const messages = [
    { role: "assistant", content: "你好" },
    { role: "user", content: "正文没有时间戳" }
  ];
  const timestampDB = {
    "user::正文没有时间戳": "2026-08-21T12:34:00.000Z"
  };

  const result = getLastUserTime(messages, timestampDB);

  assert.equal(result?.time.toISOString(), "2026-08-21T12:34:00.000Z");
  assert.equal(result?.source, "timestamp_db");
});
