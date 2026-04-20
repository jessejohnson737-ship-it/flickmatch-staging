# FlickMatch TMDB Proxy (Cloudflare Worker)

This Worker keeps your TMDB bearer token **off the client** by proxying only a small allowlist of TMDB endpoints.

## What it exposes

- `GET /tmdb/discover/movie?...`
- `GET /tmdb/movie/:id/external_ids`
- `GET /tmdb/movie/:id/watch/providers`

## Setup

1. Install deps:

```bash
cd proxy
npm install
```

2. Add the TMDB bearer token as a secret:

```bash
npx wrangler secret put TMDB_TOKEN
```

3. (Recommended) Set allowed CORS origins (comma-separated):

```bash
npx wrangler secret put ALLOWED_ORIGINS
```

Example value:

- `https://your-space.hf.space,https://your-prod-domain.com`

4. Run locally:

```bash
npm run dev
```

5. Deploy:

```bash
npm run deploy
```

## Notes
- If `ALLOWED_ORIGINS` is empty, the proxy **fails closed** (no `Access-Control-Allow-Origin`).
- You can keep `ALLOWED_ORIGINS` non-secret if you prefer; it’s a public allowlist.

