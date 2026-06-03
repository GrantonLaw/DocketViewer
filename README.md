# DocketViewer

A fast, AI-enhanced web tool for exploring Canadian Federal Court dockets. Search by court file number or party name, browse recorded entries, and get automatic milestone detection powered by Gemini.

- **Live API**: Pulls real-time docket data from the [Federal Court of Canada](https://www.fct-cf.ca)
- **Keyword Detection**: Automatically flags key procedural milestones (perfected, RMOA, stay, leave decision, etc.)
- **AI Analysis**: Optional deep-dive using Gemini to catch nuanced procedural events
- **Bulk Search**: Submit multiple court file numbers at once
- **Party/SOC Search**: Look up cases by party name or style of cause

## Quick Start

### Local Development

The frontend lives in `public/docketviewer.html` and the API in `worker.js`.
Run both together with Wrangler:

```bash
# Clone the repo
git clone https://github.com/yourusername/DocketViewer.git
cd DocketViewer

# Install wrangler and run the worker (serves HTML + API)
npm install -D wrangler
wrangler dev --env=development
```

Then visit `http://localhost:8787/docketviewer.html`.

### Deploy to Cloudflare

DocketViewer runs as a **single Cloudflare Worker** that serves both the HTML and
the API. The Worker is connected to GitHub, so every push to `main` auto-deploys.

1. **Push to GitHub**
   ```bash
   git add .
   git commit -m "Initial commit"
   git push origin main
   ```

2. **Follow [DEPLOYMENT.md](./DEPLOYMENT.md)** for the full Cloudflare setup
   (custom domain, `ALLOWED_ORIGINS`, and the `GEMINI_API_KEY` secret).

## Architecture

```
docketviewer.grantonlaw.ca → docketviewer (single Worker)
   ├─ static assets  → public/docketviewer.html
   └─ API (?type=…)  → worker.js
        ├─ Federal Court proxy (case / re / parties / soc)
        ├─ Origin check (ALLOWED_ORIGINS)
        └─ AI milestone analysis (Gemini API)
```

One Worker, git-connected: a commit deploys the HTML and the API together. No
separate Pages project and no proxy hop.

## Configuration

- **`ALLOWED_ORIGINS`** — set in `wrangler.toml` under `[vars]`. Comma-separated
  list of domains allowed to call the API (no trailing slashes). Lives in the
  config file so it survives every deploy.
  Example: `https://docketviewer.grantonlaw.ca`

- **`GEMINI_API_KEY`** — a [Google Gemini API key](https://aistudio.google.com/app/apikey),
  set once as a secret: `wrangler secret put GEMINI_API_KEY`. **Never commit it.**
  Secrets survive every deploy.

> Don't set these as plaintext dashboard variables — `wrangler deploy` overwrites
> dashboard variables from `wrangler.toml` on every deploy.

## Usage

### Single Case
Enter a court file number (e.g., `IMM-12345-25`) and click **Search**.

### Bulk Search
Enter comma-separated file numbers (e.g., `IMM-1-25, IMM-2-25`) to load multiple at once with milestone summaries.

### Party Search
Switch to **Party Search** tab and search by name or style of cause.

## Features

- **Milestone Detection**
  - Keyword-based (fast): Perfected, RMOA, reply, stay, CTR, JR scheduled/heard, leave decision, discontinued
  - AI-enhanced (optional): Gemini analyzes entries for procedural subtleties

- **Docket Table**
  - Browse recorded entries chronologically
  - Filter, sort, export to CSV/Excel/PDF

- **Counsel Info**
  - Applicant & respondent firm/counsel extracted from party data

## License

GNU General Public License v3 — see [LICENSE](./LICENSE)

## Reproduction Notice

Court file data is reproduced from the *Federal Court of Canada — Court Files and Decisions* (fct-cf.gc.ca), published by the Government of Canada. This tool is for personal use only. Users should verify accuracy of reproduced materials. This tool is not affiliated with or endorsed by the Government of Canada.

---

**Need help deploying?** → See [DEPLOYMENT.md](./DEPLOYMENT.md)
