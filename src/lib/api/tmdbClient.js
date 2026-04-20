const DEFAULT_TIMEOUT_MS = 12_000;

function getRuntimeProxyBase() {
  // Hugging Face Static Spaces expose runtime variables here.
  // This lets you change the proxy URL without rebuilding the app.
  const hf = globalThis?.window?.huggingface?.variables;
  const runtime = typeof hf?.TMDB_PROXY_BASE === "string" ? hf.TMDB_PROXY_BASE : "";
  if (runtime) return runtime.replace(/\/+$/, "");

  const built = (import.meta?.env?.VITE_TMDB_PROXY_BASE || "").trim();
  if (built) return built.replace(/\/+$/, "");

  // Local dev default: if you're running the proxy via `wrangler dev`,
  // it will commonly be available on 8787.
  if (import.meta?.env?.DEV) return "http://127.0.0.1:8787";

  // Production default: same-origin (useful if you front the proxy and app on same host).
  return "";
}

function withTimeout(signal, ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(t);
      if (signal) signal.removeEventListener("abort", onAbort);
    },
  };
}

async function fetchJson(path, { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const base = getRuntimeProxyBase();
  const url = `${base}${path}`;
  const { signal: s, cancel } = withTimeout(signal, timeoutMs);
  try {
    const res = await fetch(url, { method: "GET", signal: s, headers: { "Accept": "application/json" } });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const msg = (data && (data.error || data.status_message)) || `Request failed (${res.status})`;
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  } finally {
    cancel();
  }
}

export const tmdb = {
  discoverMovie(qs) {
    return fetchJson(`/tmdb/discover/movie?${qs}`);
  },
  watchProviders(movieId) {
    return fetchJson(`/tmdb/movie/${movieId}/watch/providers`);
  },
  externalIds(movieId) {
    return fetchJson(`/tmdb/movie/${movieId}/external_ids`);
  },
};

