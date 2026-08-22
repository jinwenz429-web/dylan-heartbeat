const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dylan-diary-fallback-"));
const originalDataDir = process.env.DATA_DIR;
const originalDiaryEnabled = process.env.DIARY_ENABLED;
process.env.DATA_DIR = directory;
process.env.DIARY_ENABLED = "true";

let remoteResult = { ok: true };
let remoteCalls = [];
const persistencePath = require.resolve("../diary_persistence");
require.cache[persistencePath] = {
  id: persistencePath,
  filename: persistencePath,
  loaded: true,
  exports: {
    persistDiaryRemote: async options => {
      remoteCalls.push(options);
      return remoteResult;
    }
  }
};

const wakeUp = require("../wake_up");

test.after(() => {
  fs.rmSync(directory, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalDiaryEnabled === undefined) delete process.env.DIARY_ENABLED;
  else process.env.DIARY_ENABLED = originalDiaryEnabled;
});

test.beforeEach(() => {
  remoteResult = { ok: true };
  remoteCalls = [];
  process.env.DIARY_ENABLED = "true";
});

test("remote success persists diary without writing local fallback", async () => {
  assert.equal(typeof wakeUp.appendDiaryEntry, "function", "appendDiaryEntry must be exported");
  const saved = await wakeUp.appendDiaryEntry(" diary ");

  assert.equal(saved, true);
  assert.equal(remoteCalls.length, 1);
  assert.equal(remoteCalls[0].content, "diary");
  assert.equal(fs.existsSync(path.join(directory, "diary")), false);
});

test("remote failure writes local markdown fallback", async () => {
  assert.equal(typeof wakeUp.appendDiaryEntry, "function", "appendDiaryEntry must be exported");
  remoteResult = { ok: false, reason: "HTTP 503" };
  const saved = await wakeUp.appendDiaryEntry("fallback entry");

  assert.equal(saved, true);
  const diaryDirectory = path.join(directory, "diary");
  const files = fs.readdirSync(diaryDirectory);
  assert.equal(files.length, 1);
  assert.match(fs.readFileSync(path.join(diaryDirectory, files[0]), "utf8"), /fallback entry/);
});

test("remote and local failures return false instead of throwing", async t => {
  assert.equal(typeof wakeUp.appendDiaryEntry, "function", "appendDiaryEntry must be exported");
  remoteResult = { ok: false, reason: "timeout" };
  t.mock.method(fs, "appendFileSync", () => {
    throw new Error("disk full");
  });

  assert.equal(await wakeUp.appendDiaryEntry("entry"), false);
});

test("DIARY_ENABLED=false skips both remote and local persistence", async () => {
  assert.equal(typeof wakeUp.appendDiaryEntry, "function", "appendDiaryEntry must be exported");
  process.env.DIARY_ENABLED = "false";
  assert.equal(await wakeUp.appendDiaryEntry("entry"), false);
  assert.equal(remoteCalls.length, 0);
});
