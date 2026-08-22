function deriveDiaryUrl(targetApiUrl, explicitDiaryUrl = "") {
  const explicit = String(explicitDiaryUrl || "").trim();
  if (explicit) {
    try {
      return new URL(explicit).toString();
    } catch {
      return "";
    }
  }

  const target = String(targetApiUrl || "").trim();
  if (!target) return "";

  try {
    const url = new URL(target);
    const replaced = url.pathname.replace(
      /\/v1\/chat\/completions\/?$/i,
      "/internal/dylan-diary"
    );
    if (replaced === url.pathname) return "";
    url.pathname = replaced;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

async function persistDiaryRemote({
  content,
  metadata = {},
  targetApiUrl = "",
  diaryApiUrl = "",
  gatewayKey = "",
  timeoutMs = 15000,
  fetchImpl = fetch
}) {
  const cleanContent = String(content || "").trim();
  if (!cleanContent) return { ok: false, reason: "empty_content" };

  const url = deriveDiaryUrl(targetApiUrl, diaryApiUrl);
  if (!url) return { ok: false, reason: "diary_url_unavailable" };

  const headers = { "Content-Type": "application/json" };
  const key = String(gatewayKey || "").trim();
  if (key) headers["X-Gateway-Key"] = key;

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers,
      body: JSON.stringify({
        content: cleanContent,
        metadata
      })
    });

    const responseText = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        reason: `HTTP ${response.status}`,
        status: response.status,
        responseBody: responseText.slice(0, 500)
      };
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error?.message || String(error)
    };
  }
}

module.exports = {
  deriveDiaryUrl,
  persistDiaryRemote
};
