"use strict";

// 轻量诊断：只记录状态、规则、耗时、次数和 token，绝不记录聊天正文、密钥或 Cookie。

const fs = require("fs");
const { runtimeFile } = require("./runtime_paths");

const MAX_LINES = 1000;

function logFile(env = process.env) {
  return runtimeFile("persona_guard_log.jsonl", env);
}

function sanitizeEntry(entry) {
  const allowed = [
    "event", "request_id", "conversation_hash", "model", "stream_mode", "status", "rules",
    "detect_ms", "state", "regenerated", "recovered", "context_repair", "context_issues",
    "fallback", "extra_requests", "extra_tokens", "total_ms", "transitions", "quarantined",
    "inbound_filtered", "rules_version", "failure_mode", "source"
  ];
  const out = { at: new Date().toISOString() };
  for (const key of allowed) {
    if (entry[key] !== undefined) out[key] = entry[key];
  }
  if (Array.isArray(out.transitions)) {
    out.transitions = out.transitions.map(t => ({ to: t.to, reason: String(t.reason || "").slice(0, 120), at_ms: t.at_ms }));
  }
  return out;
}

function logGuardEvent(entry, { enabled = true, env = process.env } = {}) {
  const clean = sanitizeEntry(entry);
  console.log(JSON.stringify({ event: "persona_guard", ...clean }));
  if (!enabled) return clean;
  try {
    const file = logFile(env);
    fs.appendFileSync(file, `${JSON.stringify(clean)}\n`, "utf-8");
    const stat = fs.statSync(file);
    if (stat.size > 512 * 1024) {
      const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
      fs.writeFileSync(file, `${lines.slice(-MAX_LINES).join("\n")}\n`, "utf-8");
    }
  } catch (error) {
    console.warn(`persona_guard_log_write_failed ${error.code || error.message}`);
  }
  return clean;
}

function readGuardLog(limit = 100, env = process.env) {
  try {
    const file = logFile(env);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).slice(-limit)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = { logGuardEvent, readGuardLog, sanitizeEntry };
