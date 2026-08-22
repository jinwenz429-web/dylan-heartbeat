const DEFAULT_TIMELINE_MAX_MESSAGES = 12;

function resolveTimelineMaxMessages(env = process.env) {
  const value = Number(env.TIMELINE_MAX_MESSAGES);
  return Number.isInteger(value) && value >= 1 ? value : DEFAULT_TIMELINE_MAX_MESSAGES;
}

function trimTimeline(messages, env = process.env) {
  const list = Array.isArray(messages) ? messages : [];
  const system = list.find(message => message?.role === "system");
  const nonSystem = list.filter(message => message?.role !== "system");
  const trimmed = nonSystem.slice(-resolveTimelineMaxMessages(env));
  return system ? [system, ...trimmed] : trimmed;
}

module.exports = {
  DEFAULT_TIMELINE_MAX_MESSAGES,
  resolveTimelineMaxMessages,
  trimTimeline
};
