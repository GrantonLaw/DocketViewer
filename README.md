# DocketViewer

A fast, AI-enhanced web tool for exploring Canadian Federal Court and Federal Court of Appeal dockets. Search by court file number or party name, browse recorded entries, and get automatic milestone detection powered by Gemini.

- **Live API**: Pulls real-time docket data from the [Federal Court of Canada](https://www.fct-cf.ca) and the Federal Court of Appeal
- **Keyword Detection**: Automatically flags key procedural milestones (perfected, RMOA, stay, leave decision, etc.; for the Court of Appeal, the steps of an appeal or s.28 application, with due dates under the Federal Courts Rules)
- **AI Analysis**: Optional deep-dive using Gemini to catch nuanced procedural events
- **Bulk Search**: Submit multiple court file numbers at once, Federal Court and Court of Appeal mixed
- **Party/SOC Search**: Look up cases by party name or style of cause, in either court

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
Enter a court file number (e.g., `IMM-12345-25`, or `A-123-25` for the Federal Court of Appeal) and click **Search**. Court of Appeal files also accept the Court's preliminary file numbers (e.g., `26-A-29`), which show the docket and details but no milestones.

### Bulk Search
Enter comma-separated file numbers (e.g., `IMM-1-25, A-2-25`) to load multiple at once with milestone summaries. **Upload List** reads file numbers out of a CSV or Excel file. Federal Court and Court of Appeal numbers can be mixed.

**Export Excel** builds a workbook with a summary tab and one tab per file (case details, counsel, milestones and recorded entries). It asks whether to use AI milestones; AI requests are paced to the Worker's rate limit, with a progress bar, and any AI analysis already run on the page is reused (files with no milestone tracking are skipped). **Export CSV** gives the one-row-per-file table.

### Party Search
Switch to **Party Search** tab, choose **Federal Court** or **Court of Appeal**, and search by name or style of cause. **IMM** limits results to immigration proceedings (for the Court of Appeal, natures that name Immigration); **All** shows everything.

## Features

- **Milestone Detection**
  - Keyword-based (fast): Perfected, RMOA, reply, stay, CTR, JR scheduled/heard, leave decision, discontinued
  - Federal Court of Appeal: appeals (s.27) and judicial review applications (s.28) are tracked step by step (appearance, appeal book, memoranda, requisition for hearing, hearing and judgment, and the application equivalents), with next-step due dates computed under the Federal Courts Rules. Other Court of Appeal proceedings show no milestones.
  - AI-enhanced (optional): Gemini analyzes entries for procedural subtleties

- **Docket Table**
  - Browse recorded entries chronologically
  - Filter, sort, export to CSV/Excel/PDF

- **Counsel Info**
  - Applicant & respondent firm/counsel extracted from party data (Appellant & Respondent on Court of Appeal appeals)

## License

GNU General Public License v3 — see [LICENSE](./LICENSE)

## Reproduction Notice

Court file data is reproduced from the *Federal Court of Canada — Court Files and Decisions* (fct-cf.gc.ca), published by the Government of Canada. This tool is for personal use only. Users should verify accuracy of reproduced materials. This tool is not affiliated with or endorsed by the Government of Canada.

---

**Need help deploying?** → See [DEPLOYMENT.md](./DEPLOYMENT.md)

## Core logic and tests

Docket parsing, deadline calculation, and formatting live in `public/core.js`: plain JavaScript with no DOM or Cloudflare dependencies. The page loads it with a `<script>` tag, and it can also be `require`d from the Worker or from Node. Keep page, storage, email, and routing code out of it.

The bulk Excel workbook layout lives in `public/bulk-export.js`, which is DOM-free in the same way: it takes the ExcelJS module as an argument (loaded from the CDN only when someone exports).

Run the tests with `node --test` (Node 18+, no install needed).
