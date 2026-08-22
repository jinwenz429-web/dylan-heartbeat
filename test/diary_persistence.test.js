const test = require("node:test");
const assert = require("node:assert/strict");

let diaryPersistence = null;
try {
  diaryPersistence = require("../diary_persistence");
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
}

function requireDiaryPersistence() {
  assert.ok(diaryPersistence, "diary_persistence module must exist");
  return diaryPersistence;
}

test("deriveDiaryUrl derives Pawwake diary endpoint from chat completions URL", () => {
  const { deriveDiaryUrl } = requireDiaryPersistence();
  assert.equal(
    deriveDiaryUrl("https://pawwake.example.com/v1/chat/completions"),
    "https://pawwake.example.com/internal/dylan-diary"
  );
});

test("deriveDiaryUrl prefers explicit endpoint", () => {
  const { deriveDiaryUrl } = requireDiaryPersistence();
  assert.equal(
    deriveDiaryUrl(
      "https://pawwake.example.com/v1/chat/completions",
      "https://other.example.com/internal/dylan-diary"
    ),
    "https://other.example.com/internal/dylan-diary"
  );
});

test("persistDiaryRemote sends content and optional gateway key", async () => {
  const { persistDiaryRemote } = requireDiaryPersistence();
  let received = null;

  const fakeFetch = async (url, options) => {
    received = { url, options };
    return {
      ok: true,
      status: 201,
      async text() {
        return '{"ok":true,"id":1}';
      }
    };
  };

  const result = await persistDiaryRemote({
    content: " diary ",
    metadata: { source: "test" },
    targetApiUrl: "https://pawwake.example.com/v1/chat/completions",
    gatewayKey: "secret",
    fetchImpl: fakeFetch
  });

  assert.equal(result.ok, true);
  assert.equal(received.url, "https://pawwake.example.com/internal/dylan-diary");
  assert.equal(received.options.headers["X-Gateway-Key"], "secret");
  assert.deepEqual(JSON.parse(received.options.body), {
    content: "diary",
    metadata: { source: "test" }
  });
});

test("persistDiaryRemote returns failure instead of throwing on remote HTTP error", async () => {
  const { persistDiaryRemote } = requireDiaryPersistence();
  const fakeFetch = async () => ({
    ok: false,
    status: 503,
    async text() {
      return "sleeping";
    }
  });

  const result = await persistDiaryRemote({
    content: "diary",
    targetApiUrl: "https://pawwake.example.com/v1/chat/completions",
    fetchImpl: fakeFetch
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
});

test("persistDiaryRemote returns failure instead of throwing on network error", async () => {
  const { persistDiaryRemote } = requireDiaryPersistence();
  const result = await persistDiaryRemote({
    content: "diary",
    targetApiUrl: "https://pawwake.example.com/v1/chat/completions",
    fetchImpl: async () => {
      throw new Error("timeout");
    }
  });

  assert.deepEqual(result, { ok: false, reason: "timeout" });
});
