# Deployment Guide — DocketViewer

This guide covers deploying DocketViewer to Cloudflare (Pages + Workers).

## Prerequisites

- Cloudflare account
- `wrangler` CLI installed (`npm install -g wrangler`)
- GitHub repo created and pushed

## Setup Steps

### 1. Set Up Cloudflare Worker (Proxy Backend)

The worker handles API proxying and AI milestone analysis. It requires two environment variables:

**`ALLOWED_ORIGINS`** (variable)
- Comma-separated list of URLs allowed to call your worker
- Example: `https://docketviewer.example.com,https://staging.example.com`
- Set this **before** deploying

**`GEMINI_API_KEY`** (secret)
- Get from [Google AI Studio](https://aistudio.google.com/app/apikey)
- This is a secret and should never be committed to git

#### Option A: Deploy via Cloudflare Dashboard

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create application** → **Create a Worker**
2. Name it `docket-proxy`
3. Copy `worker.js` code into the editor
4. Click **Save and deploy**
5. Go to **Settings** → **Variables and Secrets**
   - Add **Variable**: `ALLOWED_ORIGINS` = `https://your-domain.com` (comma-separated if multiple)
   - Add **Secret**: `GEMINI_API_KEY` = your Google API key
6. Note your worker URL (e.g., `https://docket-proxy.your-account.workers.dev`)

#### Option B: Deploy via `wrangler` CLI

```bash
# 1. Authenticate
wrangler login

# 2. Update wrangler.toml with your account info
#    - Set your ACCOUNT_ID
#    - Update ALLOWED_ORIGINS as needed

# 3. Set secrets (interactive)
wrangler secret put GEMINI_API_KEY --env production

# 4. Deploy
wrangler deploy --env production
```

### 2. Set Up Cloudflare Pages (Frontend)

Cloudflare Pages hosts your HTML/JS frontend and auto-deploys on push.

1. Go to **Cloudflare Dashboard** → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**
2. Select your GitHub repo
3. Configure build settings:
   - **Framework preset**: None
   - **Build command**: (leave blank)
   - **Build output directory**: `/` (root, since it's a single HTML file)
4. Click **Save and deploy**
5. Note your Pages URL (e.g., `https://docketviewer.pages.dev`)

### 3. Update `ALLOWED_ORIGINS` in Worker

Update your worker's `ALLOWED_ORIGINS` to include your Pages domain:

1. Go to **Workers & Pages** → **docket-proxy** → **Settings** → **Variables and Secrets**
2. Edit `ALLOWED_ORIGINS` to include both your Pages domain and any custom domains:
   ```
   https://docketviewer.pages.dev,https://docketviewer.example.com
   ```

### 4. Custom Domain (Optional)

Cloudflare Pages domains are fine for development. To use your own domain:

1. Go to **Pages project** → **Custom domains** → **Add custom domain**
2. Follow the CNAME setup (Cloudflare will guide you)
3. Update `ALLOWED_ORIGINS` in worker if needed

---

## How It Works

1. **User loads `docketviewer.html`** on Cloudflare Pages
2. **Page fetches config** from worker (`/?type=config`) to discover proxy URL
3. **All API calls** (case data, docket entries, AI analysis) go through worker to `/docket-proxy`
4. **Worker checks `Origin` header** against `ALLOWED_ORIGINS` — rejects if not allowed
5. **Worker proxies** requests to Federal Court API or Gemini API

---

## Environment Variables Quick Reference

| Variable | Type | Where | Purpose |
|----------|------|-------|---------|
| `ALLOWED_ORIGINS` | Variable | Worker Settings | Comma-separated list of domains allowed to call your worker |
| `GEMINI_API_KEY` | Secret | Worker Settings | Google Gemini API key for AI milestone analysis |

---

## Troubleshooting

### "Forbidden" errors
- Check `ALLOWED_ORIGINS` includes your current domain
- Clear browser cache and retry

### Config endpoint returns empty
- Verify worker is deployed and accessible
- Check worker logs in Cloudflare Dashboard

### AI analysis unavailable
- Verify `GEMINI_API_KEY` is set as a **Secret** (not a variable)
- Check Google Cloud API quota isn't exceeded
- Ensure Gemini API is enabled in your Google Cloud project

---

## Next Steps

- Set up a custom domain
- Add branch protection (deploy from `main` only)
- Monitor worker analytics and errors in Cloudflare Dashboard
