/**
 * Cloudflare Worker — Federal Court Docket Proxy + Milestone Analysis
 *
 * Environment Variables (set in Cloudflare dashboard → Worker → Settings → Variables):
 *   ALLOWED_ORIGINS      (string, comma-separated)
 *   GEMINI_API_KEY       (secret)
 *
 * Endpoints:
 *   GET  /?type=case&courtnumber=IMM-12345-25
 *   GET  /?type=re&courtnumber=IMM-12345-25
 *   GET  /?type=parties&courtnumber=IMM-12345-25
 *   POST /?type=milestones  (body: { entries: [...] })
 *   GET  /?type=config         (returns proxy URL and origins for client-side use)
 */
const GEMINI_MODEL = 'gemini-3.1-flash-lite-preview';
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

jr_scheduled — Leave has been granted and a hearing date has been set for the judicial review on the merits. Extract the city and hearing date/time if available.

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

    // Origin check — reject anything not coming from an allowed origin
    if (!allowedOrigin) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: corsHeaders });
    }

    const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
    const url      = new URL(request.url);
    const type     = url.searchParams.get('type') || '';

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
        const result  = await analyzeMilestones(entries, env.GEMINI_API_KEY);
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
      let socResp;
      try {
        socResp = await fetch(
          'https://www.fct-cf.ca/CourtFilesAndDecisions/ProceedingsQueriesPartyInfo'
            + '?division=t&name=' + encodeURIComponent(q),
          {
            headers: {
              'Accept':     'application/json, text/javascript, */*',
              'Referer':    'https://www.fct-cf.ca/en/court-files-and-decisions/court-files',
              'User-Agent': 'Mozilla/5.0 (compatible; DocketViewer/1.0)',
            },
          }
        );
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Network error reaching Federal Court server' }), { status: 502, headers: corsHeaders });
      }
      const socBody = await socResp.text();
      return new Response(socBody, { status: socResp.status, headers: corsHeaders });
    }

    // ── FC API proxy endpoints ────────────────────────────────────────────────
    const courtnumber = (url.searchParams.get('courtnumber') || '').toUpperCase().trim();

    if (!courtnumber || !/^[A-Z0-9]+-[0-9]+-[0-9]{2,4}$/.test(courtnumber)) {
      return new Response(JSON.stringify({ error: 'Invalid court number format' }), { status: 400, headers: corsHeaders });
    }

    const division = /^A-/.test(courtnumber) ? 'a' : 't';
    let apiUrl;

    if (type === 'case') {
      apiUrl = 'https://www.fct-cf.ca/CourtFilesAndDecisions/proceedingQueriesCourtNumberList'
        + '?division=' + encodeURIComponent(division)
        + '&courtnumber=' + encodeURIComponent(courtnumber);
    } else if (type === 're') {
      apiUrl = 'https://www.fct-cf.ca/CourtFilesAndDecisions/proceedingQueriesRE'
        + '?division=' + encodeURIComponent(courtnumber)
        + '&courtnumber=' + encodeURIComponent(courtnumber);
    } else if (type === 'parties') {
      apiUrl = 'https://www.fct-cf.ca/CourtFilesAndDecisions/PublicPartiesListInfo'
        + '?courtnumber=' + encodeURIComponent(courtnumber);
    } else {
      return new Response(JSON.stringify({ error: 'Invalid type parameter' }), { status: 400, headers: corsHeaders });
    }

    let response;
    try {
      response = await fetch(apiUrl, {
        headers: {
          'Accept':     'application/json, text/javascript, */*',
          'Referer':    'https://www.fct-cf.ca/en/court-files-and-decisions/court-files',
          'User-Agent': 'Mozilla/5.0 (compatible; DocketViewer/1.0)',
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Network error reaching Federal Court server' }), { status: 502, headers: corsHeaders });
    }

    const body = await response.text();
    return new Response(body, { status: response.status, headers: corsHeaders });
  },
};

// ── Gemini milestone analysis ─────────────────────────────────────────────────
async function analyzeMilestones(entries, apiKey) {
  if (!apiKey) throw new Error('GEMINI_API_KEY secret not configured in Worker');
  if (!entries.length) return emptyMilestones();

  const entriesText = entries
    .sort((a, b) => a.RE_NO - b.RE_NO)
    .map(e => `[${e.DOC_DT.split('T')[0]}] ${(e.RECORDED_ENTRY || '').trim()}`)
    .join('\n\n');

  const prompt = PROMPT_TEMPLATE.replace('{ENTRIES}', entriesText);

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
    return JSON.parse(text);
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
