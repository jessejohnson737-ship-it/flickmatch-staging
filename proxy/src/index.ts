export interface Env {
  TMDB_TOKEN: string;
  ALLOWED_ORIGINS: string;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
}

type AllowedRoute =
  | { kind: "discover"; search: URLSearchParams }
  | { kind: "watchProviders"; movieId: string }
  | { kind: "externalIds"; movieId: string };

const TMDB_BASE = "https://api.themoviedb.org/3";

function parseAllowedOrigins(env: Env): string[] {
  const raw = (env.ALLOWED_ORIGINS || "").trim();
  if (!raw) return [];
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

function corsHeaders(origin: string | null, allowed: string[]) {
  if (!origin) return {};
  if (allowed.length === 0) {
    // Fail closed by default, but allow localhost for dev ergonomics.
    if (origin === "http://localhost:5173" || origin === "http://127.0.0.1:5173") {
      return {
        "Access-Control-Allow-Origin": origin,
        "Vary": "Origin",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      };
    }
    return {};
  }
  if (!allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

function isDigits(s: string) {
  return /^[0-9]+$/.test(s);
}

function capInt(param: string | null, min: number, max: number) {
  if (!param) return null;
  const n = Number(param);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function parseRoute(url: URL): AllowedRoute | null {
  // Supported public API:
  // - /tmdb/discover/movie?...  (proxies TMDB /discover/movie)
  // - /tmdb/movie/:id/watch/providers
  // - /tmdb/movie/:id/external_ids
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length === 3 && parts[0] === "tmdb" && parts[1] === "discover" && parts[2] === "movie") {
    const sp = new URLSearchParams(url.search);
    // Clamp common high-abuse params.
    const page = capInt(sp.get("page"), 1, 10);
    if (page !== null) sp.set("page", String(page));
    return { kind: "discover", search: sp };
  }

  if (parts.length === 5 && parts[0] === "tmdb" && parts[1] === "movie" && parts[3] === "watch" && parts[4] === "providers") {
    const movieId = parts[2];
    if (!isDigits(movieId)) return null;
    return { kind: "watchProviders", movieId };
  }

  if (parts.length === 4 && parts[0] === "tmdb" && parts[1] === "movie" && parts[3] === "external_ids") {
    const movieId = parts[2];
    if (!isDigits(movieId)) return null;
    return { kind: "externalIds", movieId };
  }

  return null;
}

async function applyRateLimit(env: Env, req: Request): Promise<Response | null> {
  const ip = req.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const id = env.RATE_LIMITER.idFromName(ip);
  const stub = env.RATE_LIMITER.get(id);
  const res = await stub.fetch("https://rate-limit/check");
  if (res.status === 429) return res;
  return null;
}

async function cachedFetch(cacheKey: Request, ttlSeconds: number, fetcher: () => Promise<Response>) {
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const res = await fetcher();
  if (!res.ok) return res;

  const toCache = new Response(res.body, res);
  toCache.headers.set("Cache-Control", `public, max-age=${ttlSeconds}`);
  await cache.put(cacheKey, toCache.clone());
  return toCache;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin");
    const allowedOrigins = parseAllowedOrigins(env);
    const cors = corsHeaders(origin, allowedOrigins);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...cors } });
    }

    if (req.method !== "GET") {
      return json(405, { error: "Method not allowed" }, cors);
    }

    if (!env.TMDB_TOKEN) {
      return json(500, { error: "Server misconfigured" }, cors);
    }

    const route = parseRoute(url);
    if (!route) {
      return json(404, { error: "Not found" }, cors);
    }

    const limited = await applyRateLimit(env, req);
    if (limited) {
      // attach CORS to the 429
      const h = new Headers(limited.headers);
      Object.entries(cors).forEach(([k, v]) => h.set(k, v));
      return new Response(limited.body, { status: limited.status, headers: h });
    }

    const headers = {
      "Authorization": `Bearer ${env.TMDB_TOKEN}`,
      "Accept": "application/json",
    };

    let targetUrl: string;
    let ttl = 30;

    if (route.kind === "discover") {
      targetUrl = `${TMDB_BASE}/discover/movie?${route.search.toString()}`;
      ttl = 20;
    } else if (route.kind === "watchProviders") {
      targetUrl = `${TMDB_BASE}/movie/${route.movieId}/watch/providers`;
      ttl = 60 * 60;
    } else {
      targetUrl = `${TMDB_BASE}/movie/${route.movieId}/external_ids`;
      ttl = 60 * 60;
    }

    const cacheKey = new Request(new URL(targetUrl).toString(), { method: "GET" });

    const res = await cachedFetch(cacheKey, ttl, async () => {
      const upstream = await fetch(targetUrl, { headers });
      const outHeaders = new Headers(upstream.headers);
      outHeaders.delete("Set-Cookie");
      outHeaders.set("X-Content-Type-Options", "nosniff");
      outHeaders.set("Referrer-Policy", "no-referrer");
      outHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
      return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
    });

    // Always attach CORS at the edge, even for cached responses.
    const finalHeaders = new Headers(res.headers);
    Object.entries(cors).forEach(([k, v]) => finalHeaders.set(k, v));
    return new Response(res.body, { status: res.status, headers: finalHeaders });
  },
};

export class RateLimiter implements DurableObject {
  private state: DurableObjectState;
  private inMemoryCount = 0;
  private inMemoryWindowStart = Date.now();

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(): Promise<Response> {
    // Fixed-window limit per IP.
    //
    // NOTE: The UI can legitimately issue bursts of TMDB discover calls (preview grid + final picks).
    // A 60/min limit is too aggressive for real usage and causes empty UI states.
    const now = Date.now();
    const windowMs = 60_000;
    const limit = 600;

    const key = "rl";
    const persisted = (await this.state.storage.get<{ start: number; count: number }>(key)) || null;

    // Prefer in-memory counting within the current window to avoid hammering DO storage.
    if (now - this.inMemoryWindowStart >= windowMs) {
      this.inMemoryWindowStart = now;
      this.inMemoryCount = 0;
    }

    // If we have persisted state from a previous isolate, align windows conservatively.
    if (persisted && now - persisted.start < windowMs) {
      // Keep the higher of persisted vs in-memory counts for this window.
      const elapsed = now - persisted.start;
      if (elapsed < windowMs) {
        this.inMemoryCount = Math.max(this.inMemoryCount, persisted.count);
        this.inMemoryWindowStart = persisted.start;
      }
    }

    this.inMemoryCount += 1;

    // Persist occasionally (reduces DO write amplification) while still surviving DO restarts.
    const shouldPersist =
      this.inMemoryCount === 1 ||
      this.inMemoryCount % 25 === 0 ||
      this.inMemoryCount > limit;

    if (shouldPersist) {
      await this.state.storage.put(key, { start: this.inMemoryWindowStart, count: this.inMemoryCount });
    }

    if (this.inMemoryCount > limit) {
      const retryAfter = Math.max(1, Math.ceil((windowMs - (now - this.inMemoryWindowStart)) / 1000));
      return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
        status: 429,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Retry-After": String(retryAfter),
          "Cache-Control": "no-store",
        },
      });
    }

    return new Response(null, { status: 204 });
  }
}

