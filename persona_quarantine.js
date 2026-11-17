"use strict";

// 隔离登记：只存回复正文的哈希指纹 + 命中规则，不存正文本身。
// Kelivo 会在下一轮把上一条回复原样带回来；server 用指纹认出它，
// 把它排除出 LLM 上下文和时间线（时间线又是心跳 / 日记的唯一来源）。

const crypto = require("crypto");
const fs = require("fs");
const { runtimeFile, writeJsonAtomicSync } = require("./runtime_paths");

const MAX_ENTRIES = 300;

function quarantineFile(env = process.env) {
  return runtimeFile("persona_quarantine.json", env);
}

function normalizeForFingerprint(text) {
  return String(text || "")
    // Kelivo 可能给消息加时间前缀
    .replace(/^（?\s*\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]?)\d{1,2}[:：]\d{2}[）\s]*/, "")
    .replace(/\s+/g, "")
    .trim();
}

function fingerprintText(text) {
  const normalized = normalizeForFingerprint(text);
  if (!normalized) return "";
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

function loadQuarantine(env = process.env) {
  const file = quarantineFile(env);
  try {
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function addQuarantineEntry(entry, env = process.env) {
  if (!entry || !entry.fp) return false;
  const list = loadQuarantine(env);
  if (list.some(item => item.fp === entry.fp)) return false;
  list.push({
    fp: entry.fp,
    request_id: entry.requestId || "",
    conversation_hash: entry.conversationHash || "",
    status: entry.status || "CONFIRMED_DRIFT",
    rules: Array.isArray(entry.rules) ? entry.rules.slice(0, 12) : [],
    at: new Date().toISOString()
  });
  writeJsonAtomicSync(quarantineFile(env), list.slice(-MAX_ENTRIES));
  return true;
}

function quarantinedFingerprintSet(env = process.env) {
  return new Set(loadQuarantine(env).map(item => item.fp));
}

function isQuarantinedMessage(msg, set) {
  if (!msg || msg.role !== "assistant" || msg.tool_calls) return false;
  const content = typeof msg.content === "string"
    ? msg.content
    : Array.isArray(msg.content)
      ? msg.content.map(part => (typeof part === "string" ? part : part?.text || "")).join("\n")
      : "";
  const fp = fingerprintText(content);
  return Boolean(fp) && set.has(fp);
}

module.exports = {
  addQuarantineEntry,
  fingerprintText,
  isQuarantinedMessage,
  loadQuarantine,
  quarantinedFingerprintSet,
  quarantineFile
};
