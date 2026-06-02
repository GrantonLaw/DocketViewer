# DocketViewer

A fast, AI-enhanced web tool for exploring Canadian Federal Court dockets. Search by court file number or party name, browse recorded entries, and get automatic milestone detection powered by Gemini.

- **Live API**: Pulls real-time docket data from the [Federal Court of Canada](https://www.fct-cf.ca)
- **Keyword Detection**: Automatically flags key procedural milestones (perfected, RMOA, stay, leave decision, etc.)
- **AI Analysis**: Optional deep-dive using Gemini to catch nuanced procedural events
- **Bulk Search**: Submit multiple court file numbers at once
- **Party/SOC Search**: Look up cases by party name or style of cause

## Quick Start

### Local Development

This is a static HTML file with no build step required.

```bash
# Clone the repo
git clone https://github.com/yourusername/DocketViewer.git
cd DocketViewer

# Serve locally (pick one)
python -m http.server 8000              # Python
npx http-server                         # Node.js
# Or just open docketviewer.html in your browser
```

Then visit `http://localhost:8000` (or open the file directly).

### Deploy to Cloudflare

This tool is designed for free-tier Cloudflare (Pages + Workers):

1. **Push to GitHub**
   ```bash
   git add .
   git commit -m "Initial commit"
   git push origin main
   ```

2. **Follow [DEPLOYMENT.md](./DEPLOYMENT.md)** for step-by-step Cloudflare setup
   - Worker for API proxying + AI
   - Pages for static hosting
   - Environment variables for origins & Gemini key

## Architecture

```
┌─ Cloudflare Pages (Frontend)
│  └─ docketviewer.html (static, auto-deployed from main branch)
│
└─ Cloudflare Worker (Backend)
   ├─ API proxy (Federal Court endpoints)
   ├─ CORS check (allowed origins from ALLOWED_ORIGINS env var)
   └─ AI milestone analysis (Gemini API)
```

## Configuration

### Environment Variables

Set these in Cloudflare Worker Settings:

- **`ALLOWED_ORIGINS`** (variable)  
  Comma-separated list of allowed frontend domains (no trailing slashes).  
  Example: `https://docketviewer.example.com,https://staging.example.com`

- **`GEMINI_API_KEY`** (secret)  
  Your [Google Gemini API key](https://aistudio.google.com/app/apikey).  
  **Keep this private** — never commit to git.

### Local Development with Wrangler

To test the worker locally:

```bash
# Install wrangler
npm install -D wrangler

# Edit wrangler.toml — set your account_id and adjust ALLOWED_ORIGINS for localhost
# Then:

wrangler dev

# Worker is now at http://localhost:8787
```

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
