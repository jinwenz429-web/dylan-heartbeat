const fs = require("node:fs");
const { runtimeFile, writeJsonAtomicSync } = require("./runtime_paths");

const LAST_USER_STATE_FILE = runtimeFile("last_user_state.json");

function validDate(value) {
  if (!(value instanceof Date) && typeof value !== "string") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function loadLastUserReceivedAt() {
  if (!fs.existsSync(LAST_USER_STATE_FILE)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(LAST_USER_STATE_FILE, "utf8"));
    return validDate(state?.last_user_received_at);
  } catch {
    return null;
  }
}

function saveLastUserReceivedAt(receivedAt = new Date()) {
  const date = validDate(receivedAt);
  if (!date) return false;
  writeJsonAtomicSync(LAST_USER_STATE_FILE, {
    last_user_received_at: date.toISOString()
  });
  return true;
}

module.exports = {
  loadLastUserReceivedAt,
  saveLastUserReceivedAt
};
