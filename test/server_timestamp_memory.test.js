const test = require("node:test");
const assert = require("node:assert/strict");

const { rememberMessageTimestamps } = require("../server");

test("records received time only for the latest user in a request with history", () => {
  const db = {};
  const receivedAt = new Date("2026-08-21T12:34:00.000Z");

  const changed = rememberMessageTimestamps(
    [
      { role: "user", content: "historical user one" },
      { role: "assistant", content: "historical assistant" },
      { role: "user", content: "historical user two" },
      { role: "assistant", content: "latest assistant context" },
      { role: "user", content: "new user message" }
    ],
    db,
    receivedAt
  );

  assert.equal(changed, true);
  assert.equal(db["user::historical user one"], undefined);
  assert.equal(db["user::historical user two"], undefined);
  assert.equal(db["user::new user message"], receivedAt.toISOString());
});

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
