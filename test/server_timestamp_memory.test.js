const test = require("node:test");
const assert = require("node:assert/strict");

const { rememberMessageTimestamps } = require("../server");

test("records server receive time for a new user message without a timestamp", () => {
  const db = {};
  const receivedAt = new Date("2026-08-21T12:34:00.000Z");

  const changed = rememberMessageTimestamps(
    [{ role: "user", content: "正文没有时间戳" }],
    db,
    receivedAt
  );

  assert.equal(changed, true);
  assert.equal(db["user::正文没有时间戳"], receivedAt.toISOString());
});
