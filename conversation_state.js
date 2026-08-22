const crypto = require("node:crypto");
const fs = require("node:fs");
const { runtimeFile, writeJsonAtomicSync } = require("./runtime_paths");

const CONVERSATION_STATE_FILE = runtimeFile("conversation_state.json");

function normalizeConversationId(value) {
  return String(value || "").trim();
}

function hashConversationId(value) {
  const conversationId = normalizeConversationId(value);
  if (!conversationId) return "";
  return crypto.createHash("sha256").update(conversationId).digest("hex").slice(0, 12);
}

function loadLastActiveConversation() {
  if (!fs.existsSync(CONVERSATION_STATE_FILE)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(CONVERSATION_STATE_FILE, "utf8"));
    const conversationId = normalizeConversationId(state.last_active_conversation_id);
    if (!conversationId) return null;
    return {
      conversationId,
      receivedAt: state.last_active_conversation_received_at || null
    };
  } catch {
    return null;
  }
}

function saveLastActiveConversation(value, receivedAt = new Date()) {
  const conversationId = normalizeConversationId(value);
  if (!conversationId) return false;
  const timestamp = receivedAt instanceof Date ? receivedAt.toISOString() : String(receivedAt);
  writeJsonAtomicSync(CONVERSATION_STATE_FILE, {
    last_active_conversation_id: conversationId,
    last_active_conversation_received_at: timestamp
  });
  return true;
}

module.exports = {
  hashConversationId,
  loadLastActiveConversation,
  normalizeConversationId,
  saveLastActiveConversation
};
