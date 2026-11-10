/**
 * Cloudflare Worker — Federal Court Docket Proxy + Milestone Analysis
 *
 * Single Worker: serves the static frontend (public/docketviewer.html) and the API.
 *
 * Config:
 *   ALLOWED_ORIGINS  (string, comma-separated)  — set in wrangler.toml [vars]
 *   GEMINI_API_KEY   (secret)                    — wrangler secret put GEMINI_API_KEY
 *
 * Endpoints:
 *   GET  /?type=case&courtnumber=IMM-12345-25
 *   GET  /?type=re&courtnumber=IMM-12345-25
 *   GET  /?type=parties&courtnumber=IMM-12345-25
 *        courtnumber may also be a Federal Court of Appeal number: A-123-25, or a
 *        preliminary file YY-A-N (e.g. 26-A-29). Both are sent with division=a.
 *   GET  /?type=soc&q=NAME[&court=fc|fca]   (party search; default fc)
 *   POST /?type=milestones  (body: { entries: [...], kind?: 'aljr'|'appeal'|'fca_application' })
 *        no kind (or 'aljr') = Federal Court immigration ALJR, exactly as before.
 *   GET  /?type=config         (returns proxy URL and origins for client-side use)
 */
const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// ── In-memory cooldown (per IP, resets if the Worker isolate is recycled) ────
// Sufficient protection for a personal tool; primary security is the origin check.
const lastCall = new Map();
const COOLDOWN  = { milestones: 8000, default: 2000 }; // milliseconds

function isCoolingDown(type, ip) {
  const key  = `${type}:${ip}`;   // cooldown is per-type, so case/re/parties don't block each other
  const now  = Date.now();
  const wait = COOLDOWN[type] ?? COOLDOWN.default;
  if ((now - (lastCall.get(key) ?? 0)) < wait) return true;
  lastCall.set(key, now);
  return false;
}

// ── Court numbers ─────────────────────────────────────────────────────────────
// Same rules as parseCourtNumber in public/core.js (kept separate: the Worker does
// not import core.js). Federal Court: IMM-12345-25, T-1234-25 → division t.
// Federal Court of Appeal: A-123-25 and preliminary files YY-A-N → division a.
function courtNumberDivision(courtnumber) {
  if (/^A-[0-9]+-[0-9]{2,4}$/.test(courtnumber) || /^[0-9]{2}-A-[0-9]+$/.test(courtnumber)) return 'a';
  if (/^[A-Z0-9]+-[0-9]+-[0-9]{2,4}$/.test(courtnumber)) return 't';
  return null;
}

const MILESTONE_KINDS = new Set(['aljr', 'appeal', 'fca_application']);

// ── Gemini prompt ─────────────────────────────────────────────────────────────
const PROMPT_TEMPLATE = `You are a Federal Court of Canada litigation assistant reviewing docket entries for an immigration application for leave and judicial review (ALJR). Your task is to identify key procedural milestones.

Use your understanding of Federal Court immigration procedure to interpret what each entry represents. Entries may use varied phrasing, abbreviations, or be split across lines. Ignore any entry prefixed with CANCELLED or ANNULÉ.

MILESTONES TO IDENTIFY:

perfected — The applicant has filed their complete leave-stage record. In Federal Court immigration practice this is the bundle of affidavits, exhibits, and memorandum filed by the applicant to perfect the leave application — typically called the Application Record or Applicant's Record. Do not confuse this with further memoranda or books of authorities filed after leave is granted for the JR hearing on the merits.

rmoa — The respondent (typically the Minister) has filed their Memorandum of Argument or Memorandum of Fact and Law at the leave stage, responding to the applicant's leave materials. Do not count further memoranda filed after leave is granted for the JR hearing.

reply — The applicant has filed a reply to the respondent's leave-stage memorandum.

stay — A motion to stay the applicant's removal from Canada pending the outcome of the judicial review.
  status: null | "filed" | "granted" | "dismissed"

motion — Any formal interlocutory motion other than a stay of removal.
  status: null | "filed_no_response" | "decision_pending" | "decided_or_abandoned"

pending_leave — The file has been transmitted to a judge or the Court for a leave disposition decision, and no leave decision has yet been made. Set to false once leave is either granted or refused.

ctr — The Certified Tribunal Record: the complete record of the tribunal proceedings below, produced pursuant to a court production order. This is distinct from Rule 9 correspondence, which is an administrative request for the decision and reasons and is NOT a CTR. A CTR requires a formal court order directing the tribunal to produce its record. The Order requiring a CTR may be called a Production Order
  status: null | "ordered" | "filed"
  Include order_date (date of the production order) and filed_date (date the record was received from the Tribunal or administrative decision-maker) where determinable.

applicant_fmoa — After leave is granted, the applicant files a Further Memorandum of Argument for the judicial review hearing on the merits.

respondent_fmoa — After leave is granted, the respondent files a Further Memorandum of Argument for the judicial review hearing on the merits.

jr_scheduled — Leave has been granted and a hearing date has been set for the judicial review on the merits. Extract the city and hearing date/time if available. If the hearing was later rescheduled or adjourned to a new date (e.g. an "Order (time and place)" rescheduling the judicial review, "now to be heard" on a new date), use the MOST RECENT scheduled hearing date.

jr_heard — The judicial review hearing on the merits has actually taken place.

jr_decision — The court has issued its final judgment on the judicial review merits.
  status: null | "granted" | "dismissed"

leave_dismissed — The application for leave has been refused. This is a terminal outcome with no further JR proceeding.

discontinued — A notice of discontinuance has been filed, ending the proceeding.

RECORDED ENTRIES (chronological):
{ENTRIES}

Return ONLY the following JSON — no markdown, no explanation:
{
  "perfected":       { "found": false, "date": null },
  "rmoa":            { "found": false, "date": null },
  "reply":           { "found": false, "date": null },
  "stay":            { "status": null },
  "motion":          { "status": null },
  "pending_leave":   { "found": false },
  "ctr":             { "status": null, "order_date": null, "filed_date": null },
  "applicant_fmoa":  { "found": false, "date": null },
  "respondent_fmoa": { "found": false, "date": null },
  "jr_scheduled":    { "found": false, "datetime": null },
  "jr_heard":        { "found": false, "date": null },
  "jr_decision":     { "status": null },
  "leave_dismissed": { "found": false, "date": null },
  "discontinued":    { "found": false, "date": null }
}`;

// ── Federal Court of Appeal prompts ──────────────────────────────────────────
// Output schemas match emptyFcaMilestones(kind) in public/core.js, so the page's
// milestoneBadges() renders AI and regex results the same way.

const FCA_COMMON_RULES = `Entries are in chronological order, each prefixed with its date [YYYY-MM-DD]. Text after "Registry notes:" is part of the same entry. Entries may be in English or French (e.g. "Avis d'appel", "Avis de comparution", "Mémoire", "Dossier d'appel", "Demande d'audience", "Ordonnance (temps et lieu)", "Avis de requête", "Avis de désistement", "Jugement", "accueilli" / "accordée" = allowed/granted, "rejeté" = dismissed). Ignore any entry prefixed with CANCELLED, ANNULÉ or REMOVED, and any "Recorded entry cancelled".

Parties are the appellant/applicant and the respondent only. Interveners (intervener, intervenor, intervenant, proposed intervener) are NOT parties: their memoranda, records, books and motions never count as a party's step (their motions do count under "motion").

Give every date as YYYY-MM-DD. A "date" is the date of the docket entry recording the step. "served" is the date of service only when an entry states it (e.g. "served on 2026-04-07", "confirming service ... by email on 14-MAR-2024", "attestant la signification ... le 23-SEP-2025"); otherwise null — never guess it. Use the FIRST qualifying entry for each step unless told otherwise.`;

const FCA_SHARED_MILESTONES = `requisition — The requisition for hearing (Form 347 / Form 314; "Requisition for hearing", "Demande d'audience") filed by a party.

hearing_scheduled — An order fixing the time and place of the hearing of the appeal/application itself ("Order (time and place)", "Order scheduling time and place of hearing", "Ordonnance (temps et lieu)"). Not a hearing of a motion. Use the MOST RECENT such order. Give date (YYYY-MM-DD), time (as written, e.g. "09:30") and place (city as written).

heard — The appeal/application itself was heard ("This matter comes on for hearing" where "Before the Court" is the appeal / judicial review, not a motion).

outcome — The Court's final disposition of the proceeding, from a Judgment or a final Order only (never from an order on a motion, never from Reasons, translations or copies of a lower court's decision).
  status: null | "allowed" | "allowed_in_part" | "dismissed" | "removed" (notice of appeal removed from the file / file closed, e.g. after a Rule 74 review) | "struck" | "transferred" (to the Federal Court) | "dismissed_for_delay"
  In this Court, "Result - granted" on a judgment of the appeal/application means "allowed".

discontinued — A notice of discontinuance of the whole proceeding by a party (not of a cross-appeal only, not partial).

stay — A motion to stay removal, execution of an order, or the effect of a decision. status: null | "filed" | "granted" | "dismissed"

motion — Any other notice of motion (including interveners' motions for leave to intervene). status: null | "filed_no_response" (no response filed yet) | "decision_pending" (a response or reply has been filed, no order yet) | "decided_or_abandoned" (every motion has been disposed of).

status_review — A notice of status review (Form 382.2; "Notice of Status Review", "Avis d'examen de l'état de l'instance"). A Registry communication saying a status review "may be issued" is NOT a notice. status: null | "issued" (no representations yet) | "responded" (the party in default has filed its representations, no decision yet) | "decided" (the Court has made an order on the status review). date = date of the notice.

time_events — Every entry that changes or suspends the time for a step, in date order:
  type "extension": a consent to extend time (Rule 7), a motion, letter or order extending or asking to extend a period;
  type "schedule": an order or direction of the Court fixing dates or periods for steps (e.g. "shall serve and file ... within 10 days", "filing schedule", "no later than");
  type "suspension": a direction or order suspending the timelines or holding the proceeding in abeyance, and any Court direction or order starting a Rule 74 review of the notice of appeal.
  steps: the step names (from: {STEP_NAMES}) the entry is about, or null if it does not say which steps.
  active (suspension only): true if no party has taken a further step since and the suspension has not been lifted; otherwise false. For other types use null.`;

const APPEAL_PROMPT_TEMPLATE = `You are a Federal Court of Appeal (Canada) litigation assistant reviewing the docket of an appeal under section 27 of the Federal Courts Act (Part 6 of the Federal Courts Rules). Your task is to identify key procedural milestones so that the deadlines under the Rules can be computed.

${FCA_COMMON_RULES}

MILESTONES TO IDENTIFY:

notice_of_appeal — The notice of appeal that commenced this appeal. served = the date it was served on the respondent, only if stated. Service of the originating document on the Crown, the Attorney General or a Minister under Rule 133 is effective when the document is filed (Rule 133(3)): when the Registry records an "R.133" / "Rule 133" service copy or email, give the filing date as served, not the date of the Registry's email.

appearance — The respondent's notice of appearance (Form 341A). A notice of appearance filed on behalf of the appellant is not one.

cross_appeal — A notice of cross-appeal by the respondent (Form 341B; "Avis d'appel incident").

ab_agreement — The agreement as to the contents of the appeal book (Rule 343(1)), or an order of the Court determining the contents of the appeal book (Rule 343(3)); set by_order true in the latter case.

ab_content_motion — The appellant's motion asking the Court to determine the contents of the appeal book (Rule 343(3)).

appeal_book — The appeal book filed by the appellant (not a supplemental or amended appeal book, not a version only "received" and not accepted for filing).

appellant_memo — The appellant's memorandum of fact and law on the appeal (Rule 346(1)). Not a memorandum or written representations on a motion, not an intervener's memorandum. served = date served on the respondent, only if stated.

respondent_memo — The respondent's memorandum of fact and law (or memorandum of argument) on the appeal (Rule 346(2)). Same exclusions. served = date served on the appellant, only if stated.

cross_reply_memo — Where there is a cross-appeal, the appellant's memorandum of fact and law as respondent to the cross-appeal (Rule 346(3)(b)).

r74_review — The Court is reviewing whether the notice of appeal should be removed from the file under Rule 74 (often because no question was certified, s. 74(d) IRPA). status: null | "pending" | "concluded" (the Court decided the appeal may proceed, or later steps were taken, or the file was closed). date = date of the direction starting the review.

${FCA_SHARED_MILESTONES.replace('{STEP_NAMES}', 'appearance, ab_agreement, appeal_book, appellant_memo, respondent_memo, cross_reply_memo, requisition')}

RECORDED ENTRIES (chronological):
{ENTRIES}

Return ONLY the following JSON — no markdown, no explanation:
{
  "kind": "appeal",
  "notice_of_appeal":  { "found": false, "date": null, "served": null },
  "appearance":        { "found": false, "date": null },
  "cross_appeal":      { "found": false, "date": null },
  "ab_agreement":      { "found": false, "date": null, "by_order": false },
  "ab_content_motion": { "found": false, "date": null },
  "appeal_book":       { "found": false, "date": null },
  "appellant_memo":    { "found": false, "date": null, "served": null },
  "respondent_memo":   { "found": false, "date": null, "served": null },
  "cross_reply_memo":  { "found": false, "date": null },
  "requisition":       { "found": false, "date": null },
  "hearing_scheduled": { "found": false, "date": null, "time": null, "place": null },
  "heard":             { "found": false, "date": null },
  "outcome":           { "status": null, "date": null },
  "discontinued":      { "found": false, "date": null },
  "stay":              { "status": null },
  "motion":            { "status": null },
  "r74_review":        { "status": null, "date": null },
  "status_review":     { "status": null, "date": null },
  "time_events":       [ { "date": null, "type": null, "steps": null, "active": null } ]
}
(time_events may be empty: [].)`;

const FCA_APPLICATION_PROMPT_TEMPLATE = `You are a Federal Court of Appeal (Canada) litigation assistant reviewing the docket of an application for judicial review under section 28 of the Federal Courts Act (Part 5 of the Federal Courts Rules). Your task is to identify key procedural milestones so that the deadlines under the Rules can be computed.

${FCA_COMMON_RULES}

MILESTONES TO IDENTIFY:

notice_of_application — The notice of application that commenced this proceeding. served = the date it was served on the respondent, only if stated. Service of the originating document on the Crown, the Attorney General or a Minister under Rule 133 is effective when the document is filed (Rule 133(3)): when the Registry records an "R.133" / "Rule 133" service copy or email, give the filing date as served, not the date of the Registry's email.

appearance — The respondent's notice of appearance (Rule 305).

tribunal_record — Certified material received from the tribunal under Rule 318 ("Certified copy of original material", "Original material / Certified copy received"). Not a party's record.

applicant_affidavits — The applicant's supporting affidavits under Rule 306. They are deemed filed when the proof of service is filed, so the step is usually an affidavit or certificate of service "confirming service of the applicant's affidavit(s)" (or naming Rule 306). An affidavit that only proves service of the notice of application, a notice of appearance or another document is NOT this step. Affidavits on a motion are NOT this step. served = date of service, only if stated.

respondent_affidavits — The respondent's affidavits under Rule 307 (same approach; often "Respondent's affidavit" or "Rule 307"). Use the first one served after the applicant's affidavits. served = date of service, only if stated.

applicant_record — The applicant's record (Rule 309; "Applicant's Record", "Application Record", "Dossier de la partie demanderesse") accepted for filing. A record returned or not accepted for filing does not count. served = date of service, only if stated.

respondent_record — The respondent's record (Rule 310) accepted for filing. served = date of service, only if stated.

r74_review — Only if the Court is reviewing whether the originating document should be removed under Rule 74. status: null | "pending" | "concluded". date = date of the direction starting the review.

${FCA_SHARED_MILESTONES.replace('{STEP_NAMES}', 'appearance, applicant_affidavits, respondent_affidavits, applicant_record, respondent_record, requisition')}

RECORDED ENTRIES (chronological):
{ENTRIES}

Return ONLY the following JSON — no markdown, no explanation:
{
  "kind": "fca_application",
  "notice_of_application": { "found": false, "date": null, "served": null },
  "appearance":            { "found": false, "date": null },
  "tribunal_record":       { "found": false, "date": null },
  "applicant_affidavits":  { "found": false, "date": null, "served": null },
  "respondent_affidavits": { "found": false, "date": null, "served": null },
  "applicant_record":      { "found": false, "date": null, "served": null },
  "respondent_record":     { "found": false, "date": null, "served": null },
  "requisition":           { "found": false, "date": null },
  "hearing_scheduled":     { "found": false, "date": null, "time": null, "place": null },
  "heard":                 { "found": false, "date": null },
  "outcome":               { "status": null, "date": null },
  "discontinued":          { "found": false, "date": null },
  "stay":                  { "status": null },
  "motion":                { "status": null },
  "r74_review":            { "status": null, "date": null },
  "status_review":         { "status": null, "date": null },
  "time_events":           [ { "date": null, "type": null, "steps": null, "active": null } ]
}
(time_events may be empty: [].)`;

// ── Main handler ──────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    // Parse allowed origins from environment (comma-separated)
    const allowedOriginsEnv = (env.ALLOWED_ORIGINS || '').split(',')
      .map(o => o.trim())
      .filter(Boolean);
    const ALLOWED_ORIGINS = new Set(allowedOriginsEnv);

    const origin  = request.headers.get('Origin')  || '';
    const referer = request.headers.get('Referer') || '';
    const allowedOrigin = ALLOWED_ORIGINS.has(origin)
      ? origin
      : [...ALLOWED_ORIGINS].find(o => referer.startsWith(o)) || '';

    const corsHeaders = {
      'Access-Control-Allow-Origin':  allowedOrigin || 'null',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json;charset=utf-8',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url  = new URL(request.url);
    const type = url.searchParams.get('type') || '';

    // Page navigation (no ?type=) — static assets at /docketviewer.html are served
    // by the platform before the Worker runs; a bare "/" lands here, so redirect it.
    if (!type) {
      return Response.redirect(url.origin + '/docketviewer.html', 302);
    }

    // Origin check — reject API requests not coming from an allowed origin
    if (!allowedOrigin) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: corsHeaders });
    }

    const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';

    // ── Config endpoint (no origin check needed — public) ──────────────────────
    if (type === 'config') {
      return new Response(JSON.stringify({
        proxyUrl: request.url.split('?')[0],  // Returns worker URL without query
        allowedOrigins: allowedOriginsEnv
      }), {
        headers: {
          'Content-Type': 'application/json;charset=utf-8',
          'Cache-Control': 'public, max-age=3600'  // Cache for 1 hour
        }
      });
    }

    // ── Milestones (POST) ────────────────────────────────────────────────────
    if (type === 'milestones') {
      if (isCoolingDown('milestones', clientIp)) {
        return new Response(JSON.stringify({ error: 'Too many requests — please wait a moment' }), { status: 429, headers: corsHeaders });
      }
      try {
        const body    = await request.json();
        const entries = body.entries || [];
        const kind    = (body.kind === undefined || body.kind === null || body.kind === '') ? 'aljr' : body.kind;
        if (!MILESTONE_KINDS.has(kind)) {
          const msg = kind === 'other'
            ? 'Milestone analysis is not available for this type of proceeding'
            : 'Invalid kind parameter';
          return new Response(JSON.stringify({ error: msg }), { status: 400, headers: corsHeaders });
        }
        const result  = kind === 'aljr'
          ? await analyzeMilestones(entries, env.GEMINI_API_KEY)
          : await analyzeFcaMilestones(entries, env.GEMINI_API_KEY, kind);
        return new Response(JSON.stringify(result), { headers: corsHeaders });
      } catch (err) {
        if (err.message === 'PEAK_DEMAND') {
          return new Response(JSON.stringify({ error: 'PEAK_DEMAND' }), { status: 503, headers: corsHeaders });
        }
        return new Response(JSON.stringify({ error: 'Milestone analysis failed: ' + err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // ── Style-of-cause / party-name search ───────────────────────────────────
    if (type === 'soc') {
      if (isCoolingDown('soc', clientIp)) {
        return new Response(JSON.stringify({ error: 'Too many requests — please wait a moment' }), { status: 429, headers: corsHeaders });
      }
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) {
        return new Response(JSON.stringify({ error: 'Missing search query' }), { status: 400, headers: corsHeaders });
      }
      // court=fc (default) searches the Federal Court, court=fca the Court of Appeal.
      const court = (url.searchParams.get('court') || 'fc').toLowerCase();
      const socDivision = { fc: 't', fca: 'a' }[court];
      if (!socDivision) {
        return new Response(JSON.stringify({ error: 'Invalid court parameter' }), { status: 400, headers: corsHeaders });
      }
      let socResp;
      try {
        socResp = await fetchFCApi(
          'https://www.fct-cf.ca/CourtFilesAndDecisions/ProceedingsQueriesPartyInfo'
            + '?division=' + socDivision + '&name=' + encodeURIComponent(q)
        );
      } catch (err) {
        const status = err.message === 'FC_TIMEOUT' ? 504 : 502;
        return new Response(JSON.stringify({ error: 'Federal Court server did not respond in time — please try again' }), { status, headers: corsHeaders });
      }
      const socBody = await socResp.text();
      return new Response(socBody, { status: socResp.status, headers: corsHeaders });
    }

    // ── FC API proxy endpoints ────────────────────────────────────────────────
    const courtnumber = (url.searchParams.get('courtnumber') || '').toUpperCase().trim();

    const division = courtNumberDivision(courtnumber);
    if (!courtnumber || !division) {
      return new Response(JSON.stringify({ error: 'Invalid court number format' }), { status: 400, headers: corsHeaders });
    }
    let apiUrl;

    if (type === 'case') {
      apiUrl = 'https://www.fct-cf.ca/CourtFilesAndDecisions/proceedingQueriesCourtNumberList'
        + '?division=' + encodeURIComponent(division)
        + '&courtnumber=' + encodeURIComponent(courtnumber);
    } else if (type === 're') {
      apiUrl = 'https://www.fct-cf.ca/CourtFilesAndDecisions/proceedingQueriesRE'
        + '?division=' + encodeURIComponent(division)
        + '&courtnumber=' + encodeURIComponent(courtnumber);
    } else if (type === 'parties') {
      apiUrl = 'https://www.fct-cf.ca/CourtFilesAndDecisions/PublicPartiesListInfo'
        + '?courtnumber=' + encodeURIComponent(courtnumber);
    } else {
      return new Response(JSON.stringify({ error: 'Invalid type parameter' }), { status: 400, headers: corsHeaders });
    }

    let response;
    try {
      response = await fetchFCApi(apiUrl);
    } catch (err) {
      const status = err.message === 'FC_TIMEOUT' ? 504 : 502;
      return new Response(JSON.stringify({ error: 'Federal Court server did not respond in time — please try again' }), { status, headers: corsHeaders });
    }

    const body = await response.text();
    return new Response(body, { status: response.status, headers: corsHeaders });
  },
};

// ── Federal Court API fetch — bounded timeout + a couple of retries ─────────
// The Court's server is occasionally slow to respond to the first request
// after being idle, and can return transient 429/5xx under load. Retrying a
// couple of times with a short per-attempt timeout keeps a cold/slow origin
// from hanging the client indefinitely while still failing within a bounded
// total time if the origin is genuinely down.
const FC_TIMEOUT_MS = 15000;
const FC_RETRY_DELAYS = [1000, 3000];

async function fetchFCApi(apiUrl) {
  for (let attempt = 0; attempt <= FC_RETRY_DELAYS.length; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FC_TIMEOUT_MS);
    try {
      const response = await fetch(apiUrl, {
        headers: {
          'Accept':     'application/json, text/javascript, */*',
          'Referer':    'https://www.fct-cf.ca/en/court-files-and-decisions/court-files',
          'User-Agent': 'Mozilla/5.0 (compatible; DocketViewer/1.0)',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if ((response.status === 429 || response.status >= 500) && attempt < FC_RETRY_DELAYS.length) {
        await new Promise(r => setTimeout(r, FC_RETRY_DELAYS[attempt]));
        continue;
      }
      return response;
    } catch (err) {
      clearTimeout(timer);
      if (attempt < FC_RETRY_DELAYS.length) {
        await new Promise(r => setTimeout(r, FC_RETRY_DELAYS[attempt]));
        continue;
      }
      throw new Error(err.name === 'AbortError' ? 'FC_TIMEOUT' : 'FC_NETWORK_ERROR');
    }
  }
}

// ── Gemini milestone analysis ─────────────────────────────────────────────────
async function analyzeMilestones(entries, apiKey) {
  if (!apiKey) throw new Error('GEMINI_API_KEY secret not configured in Worker');
  if (!entries.length) return emptyMilestones();

  const entriesText = entries
    .sort((a, b) => a.RE_NO - b.RE_NO)
    .map(e => `[${e.DOC_DT.split('T')[0]}] ${(e.RECORDED_ENTRY || '').trim()}`)
    .join('\n\n');

  const prompt = PROMPT_TEMPLATE.replace('{ENTRIES}', entriesText);
  return JSON.parse(await requestModelJSON(prompt, apiKey));
}

// Court of Appeal appeals and s.28 applications. Unlike the ALJR prompt, the
// registry notes are included: FCA consents, schedules and Rule 74 directions
// often carry their substance there. Entries are sorted by date (FCA docket
// numbers are not always in date order).
async function analyzeFcaMilestones(entries, apiKey, kind) {
  if (!apiKey) throw new Error('GEMINI_API_KEY secret not configured in Worker');
  if (!entries.length) return emptyFcaMilestones(kind);

  const entriesText = entries
    .slice()
    .sort((a, b) => (String(a.DOC_DT || '') < String(b.DOC_DT || '') ? -1 : String(a.DOC_DT || '') > String(b.DOC_DT || '') ? 1 : a.RE_NO - b.RE_NO))
    .map(e => {
      let t = `[${String(e.DOC_DT || '').split('T')[0]}] ${(e.RECORDED_ENTRY || '').trim()}`;
      if (e.REGISTRY_NOTES_EXTERNAL) t += `\nRegistry notes: ${e.REGISTRY_NOTES_EXTERNAL.trim()}`;
      return t;
    })
    .join('\n\n');

  const template = kind === 'appeal' ? APPEAL_PROMPT_TEMPLATE : FCA_APPLICATION_PROMPT_TEMPLATE;
  const parsed = JSON.parse(await requestModelJSON(template.replace('{ENTRIES}', entriesText), apiKey));

  // Fill any key the model left out, and drop placeholder time events.
  const out = emptyFcaMilestones(kind);
  for (const k of Object.keys(out)) {
    if (parsed[k] !== undefined && parsed[k] !== null) out[k] = parsed[k];
  }
  out.kind = kind;
  out.time_events = (Array.isArray(out.time_events) ? out.time_events : [])
    .filter(ev => ev && typeof ev.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ev.date) &&
                  ['extension', 'schedule', 'suspension'].includes(ev.type));
  return out;
}

// Sends one prompt and returns the model's JSON text, retrying on peak demand.
async function requestModelJSON(prompt, apiKey) {
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      response_mime_type: 'application/json',
      temperature: 0,
    },
  });

  const delays = [2000, 4000, 8000];

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    const response = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (response.status === 529 || response.status === 503) {
      if (attempt < delays.length) {
        await new Promise(r => setTimeout(r, delays[attempt]));
        continue;
      }
      throw new Error('PEAK_DEMAND');
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Empty response from Gemini');
    return text;
  }

  throw new Error('PEAK_DEMAND');
}

function emptyMilestones() {
  return {
    perfected:     { found: false, date: null },
    rmoa:          { found: false, date: null },
    reply:         { found: false, date: null },
    stay:          { status: null },
    motion:        { status: null },
    pending_leave: { found: false },
    ctr:           { status: null, order_date: null, filed_date: null },
    applicant_fmoa:  { found: false, date: null },
    respondent_fmoa: { found: false, date: null },
    jr_scheduled:    { found: false, datetime: null },
    jr_heard:        { found: false, date: null },
    jr_decision:     { status: null },
    leave_dismissed: { found: false, date: null },
    discontinued:    { found: false, date: null },
  };
}

// Same shape as emptyFcaMilestones(kind) in public/core.js.
function emptyFcaMilestones(kind) {
  const step   = () => ({ found: false, date: null });
  const served = () => ({ found: false, date: null, served: null });
  const m = { kind };
  if (kind === 'appeal') {
    Object.assign(m, {
      notice_of_appeal: served(), appearance: step(), cross_appeal: step(),
      ab_agreement: { found: false, date: null, by_order: false }, ab_content_motion: step(),
      appeal_book: step(), appellant_memo: served(), respondent_memo: served(), cross_reply_memo: step(),
    });
  } else {
    Object.assign(m, {
      notice_of_application: served(), appearance: step(), tribunal_record: step(),
      applicant_affidavits: served(), respondent_affidavits: served(),
      applicant_record: served(), respondent_record: served(),
    });
  }
  return Object.assign(m, {
    requisition: step(),
    hearing_scheduled: { found: false, date: null, time: null, place: null },
    heard: step(),
    outcome: { status: null, date: null },
    discontinued: step(),
    stay: { status: null },
    motion: { status: null },
    r74_review: { status: null, date: null },
    status_review: { status: null, date: null },
    time_events: [],
  });
}
