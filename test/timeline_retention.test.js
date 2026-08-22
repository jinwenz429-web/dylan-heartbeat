const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveTimelineMaxMessages, trimTimeline } = require("../timeline_retention");

test("TIMELINE_MAX_MESSAGES defaults to 12 and falls back on invalid values", () => {
  assert.equal(resolveTimelineMaxMessages({}), 12);
  assert.equal(resolveTimelineMaxMessages({ TIMELINE_MAX_MESSAGES: "6" }), 6);
  assert.equal(resolveTimelineMaxMessages({ TIMELINE_MAX_MESSAGES: "0" }), 12);
  assert.equal(resolveTimelineMaxMessages({ TIMELINE_MAX_MESSAGES: "abc" }), 12);
});

test("trimTimeline keeps system prompt plus only the newest configured non-system messages", () => {
  const messages = [
    { role: "system", content: "sp" },
    ...Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: String(i + 1)
    }))
  ];

  assert.deepEqual(trimTimeline(messages, { TIMELINE_MAX_MESSAGES: "4" }), [
    { role: "system", content: "sp" },
    ...messages.slice(-4)
  ]);
});
