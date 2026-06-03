# Deployment Guide — DocketViewer

DocketViewer runs as a **single Cloudflare Worker** that serves both the static
HTML and the API. There is no separate Pages project and no proxy hop.

```
docketviewer.grantonlaw.ca  →  docketviewer (Worker)
                                ├─ static assets  → ./public/docketviewer.html
                                └─ API (?type=…)  → worker.js
                                     ├─ Federal Court proxy
                                     └─ Gemini milestone analysis
```

The Worker is connected to GitHub, so **every push to `main` auto-deploys** both
the HTML and the API together.

## Prerequisites

- Cloudflare account
- `wrangler` CLI (`npm install -g wrangler`)
- GitHub repo connected to the Worker

## Project layout

| Path | Purpose |
|------|---------|
| `worker.js` | The Worker — API proxy, origin check, Gemini analysis |
| `public/docketviewer.html` | The frontend (served as a static asset) |
| `wrangler.toml` | Worker config, asset binding, `ALLOWED_ORIGINS` |

> Only files inside `public/` are served as static assets. `worker.js` lives at
> the repo root so it is never exposed as a downloadable file.

## Configuration

### Variables (in `wrangler.toml` — survive every deploy)

**`ALLOWED_ORIGINS`** — comma-separated list of domains allowed to call the API.
Page loads are served from the same origin, so this only needs your live
domain(s):

```toml
[vars]
ALLOWED_ORIGINS = "https://docketviewer.grantonlaw.ca"
```

### Secrets (set once via wrangler — survive every deploy)

**`GEMINI_API_KEY`** — Google Gemini key for AI milestone analysis. Never commit
it. Set it once:

```bash
wrangler secret put GEMINI_API_KEY
```

Get a key from [Google AI Studio](https://aistudio.google.com/app/apikey).

> Because `ALLOWED_ORIGINS` lives in `wrangler.toml` and `GEMINI_API_KEY` is a
> secret, neither is wiped when the Worker redeploys. Do **not** set them as
> plaintext dashboard variables — those get overwritten on every deploy.

## Deploy

### Automatic (normal workflow)

Push to `main`. The connected Worker rebuilds and deploys both the HTML and the
API. The build command in the Cloudflare dashboard should be:

```
npx wrangler deploy
```

### Manual

```bash
wrangler deploy
```

The "multiple environments" warning is harmless — `wrangler deploy` targets the
top-level (production) config. The `[env.development]` block is only used by
`wrangler dev`.

## Local development

```bash
wrangler dev --env=development
```

Serves the Worker (HTML + API) at `http://localhost:8787` with localhost origins
allowed.

## Custom domain

The custom domain is attached directly to the Worker:

1. Cloudflare Dashboard → **Workers & Pages** → `docketviewer` → **Settings → Domains & Routes**
2. Add `docketviewer.grantonlaw.ca`

## How it works

1. **Page load** (`/docketviewer.html`) — Cloudflare serves the static asset
   directly, before the Worker runs. A bare `/` is redirected to
   `/docketviewer.html` by the Worker.
2. **Frontend fetches config** (`/?type=config`) from the same origin to learn
   the proxy URL (itself).
3. **API calls** (`/?type=case`, `re`, `parties`, `soc`, `milestones`) hit the
   Worker. The Worker checks the `Origin`/`Referer` against `ALLOWED_ORIGINS`.
4. **Worker proxies** to the Federal Court API or Gemini and returns the result.

## Troubleshooting

### "Forbidden" on API calls
- `ALLOWED_ORIGINS` in `wrangler.toml` must exactly match your live origin,
  including `https://` and no trailing slash.
- Redeploy after changing it (the value is baked in at deploy time).

### "Forbidden" on page load
- Means a request reached the Worker without an allowed origin. Confirm the
  static asset exists at `public/docketviewer.html` and the `[assets]` block
  points at `./public`.

### AI analysis unavailable
- Confirm `GEMINI_API_KEY` is set as a **secret** (`wrangler secret list`).
- Check the Gemini API quota and that the model name in `worker.js` is valid.

## Environment Variables Quick Reference

| Name | Type | Where | Purpose |
|------|------|-------|---------|
| `ALLOWED_ORIGINS` | Variable | `wrangler.toml` `[vars]` | Domains allowed to call the API |
| `GEMINI_API_KEY` | Secret | `wrangler secret put` | Google Gemini key for AI analysis |
