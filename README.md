---
title: FlickMatch (staging)
emoji: 🎬
colorFrom: gray
colorTo: purple
sdk: static
app_build_command: npm ci && npm run build
app_file: dist/index.html
---

## FlickMatch

A mood-based movie picker powered by TMDB.

### Local development

```bash
npm install
npm run dev
```

If you want movies to load locally, run the proxy too:

```bash
cd proxy
npx wrangler dev --port 8787
```

### Security model (high-level)

- The browser app **never talks to TMDB directly**.
- All TMDB requests go through the **serverless proxy** in `proxy/`, which holds `TMDB_TOKEN` as a secret.
- The proxy only allows a small set of endpoints and applies basic **rate limiting + caching + CORS allowlisting**.

### Staging on Hugging Face Spaces

- **Space type**: Static
- **Runtime variable**: set `TMDB_PROXY_BASE` to your deployed proxy origin, e.g. `https://your-worker.your-subdomain.workers.dev`.

### Proxy (keeps TMDB token off the client)

See `proxy/README.md`.
