# Agent instructions — DocketViewer

## Branches: `main` is production, `beta` is staging

- **`main`** deploys straight to production (`docketviewer.grantonlaw.ca`) via
  `.github/workflows/deploy.yml`, on every push. Treat it as live.
- **`beta`** deploys to the staging Worker (`docketviewerbeta.grantonlaw.ca`,
  `docketviewerbeta.jgranton.workers.dev`) via
  `.github/workflows/deploy-beta.yml`, also on every push.

**Make changes on `beta` first, not `main`.** Push there, let it deploy, and
have it checked against the real thing (a real docket, real deadlines) before
it goes anywhere near `main`. Once `beta` looks right, bring `main` up to it
— either a PR from `beta` into `main`, or (as this repo has usually done so
far) fast-forwarding `main` to `beta`'s tip once it's verified. Either way,
`main` should only ever move to a commit that has already been live on `beta`.

Do not push straight to `main` unless the user explicitly says so (e.g. a
same-day production hotfix) — and even then, prefer landing it on `beta` too
so the branches don't silently diverge.

Since both workflows deploy on *every* push to their branch, pushing to
either one is a real, outward-facing deploy — not a no-op. Confirm with the
user before pushing to `main` specifically, the same way you would for any
other production deploy.

## Before pushing anything

- Run `node --test` (see `test/core.test.js`) — it's fast and covers the
  deadline-calculation and milestone-detection logic in `public/core.js`.
- Core logic (docket parsing, deadline math, formatting) belongs in
  `public/core.js`, which has to stay DOM-free and Cloudflare-free so it can
  run in the browser, the Worker, and Node tests unmodified. Page, storage,
  email, and routing code stays out of it.

## More detail

See `DEPLOYMENT.md` for the Worker/asset layout, environments in
`wrangler.toml`, and how secrets and vars are configured.
