// Docket Viewer core logic — docket parsing, deadline math, and formatting.
//
// Plain JavaScript with no DOM, jQuery, or Cloudflare dependencies, so the same
// file runs in the browser (loaded via <script>), in the Worker, and in Node
// tests. Keep it that way: anything touching the page, storage, email, or
// routing belongs outside this file.
(function (root) {
    'use strict';

    // Federal Court statutory holidays (2026–2027), per the FC Rules r.2 "holiday"
    // definition: a Saturday; an Interpretation Act s.35(1) holiday; if New Year's Day,
    // Canada Day, or Remembrance Day falls on a Saturday or Sunday, the following Monday;
    // if Christmas Day falls on a Saturday or Sunday, the following Monday AND Tuesday;
    // if Christmas Day falls on a Friday, the following Monday. A deadline that lands on
    // a weekend or one of these dates rolls forward to the next business day.
    var FC_HOLIDAYS = new Set([
        // 2026
        '2026-01-01',  // New Year's Day
        '2026-04-03',  // Good Friday
        '2026-04-06',  // Easter Monday
        '2026-05-18',  // Victoria Day
        '2026-07-01',  // Canada Day
        '2026-08-03',  // Civic Holiday (Ontario)
        '2026-09-07',  // Labour Day
        '2026-09-30',  // National Day for Truth and Reconciliation
        '2026-10-12',  // Thanksgiving Day
        '2026-11-11',  // Remembrance Day
        '2026-12-25',  // Christmas Day (Friday)
        '2026-12-26',  // Boxing Day
        '2026-12-28',  // Christmas fell on a Friday → following Monday
        // 2027
        '2027-01-01',  // New Year's Day
        '2027-03-26',  // Good Friday
        '2027-03-29',  // Easter Monday
        '2027-05-24',  // Victoria Day
        '2027-07-01',  // Canada Day
        '2027-08-02',  // Civic Holiday (Ontario)
        '2027-09-06',  // Labour Day
        '2027-09-30',  // National Day for Truth and Reconciliation
        '2027-10-11',  // Thanksgiving Day
        '2027-11-11',  // Remembrance Day
        '2027-12-25',  // Christmas Day (Saturday)
        '2027-12-26',  // Boxing Day (Sunday)
        '2027-12-27',  // Christmas fell on a Saturday → following Monday
        '2027-12-28',  // Christmas fell on a Saturday → following Tuesday
    ]);

    // FC Rules r.2 "seasonal recess": December 21 through January 7 (inclusive),
    // spanning the year boundary. Under r.6(3), a day within the recess is not
    // counted when computing time to file, amend, transmit, or serve a document,
    // unless the Court directs otherwise.
    function isSeasonalRecess(d) {
        var month = d.getUTCMonth() + 1, day = d.getUTCDate();
        return (month === 12 && day >= 21) || (month === 1 && day <= 7);
    }

    // Roll a Date (UTC) forward past Saturdays, Sundays, FC_HOLIDAYS, and the
    // seasonal recess.
    function rollToBusinessDay(d) {
        while (d.getUTCDay() === 0 || d.getUTCDay() === 6 ||
               FC_HOLIDAYS.has(d.toISOString().split('T')[0]) || isSeasonalRecess(d)) {
            d.setUTCDate(d.getUTCDate() + 1);
        }
        return d;
    }

    // Calendar-day arithmetic on a YYYY-MM-DD string (parsed as UTC midnight),
    // skipping days that fall within the seasonal recess (FC Rules r.6(3): those
    // days aren't counted toward the period).
    function addDays(ds, n) {
        var d = new Date(ds);
        var remaining = n;
        while (remaining > 0) {
            d.setUTCDate(d.getUTCDate() + 1);
            if (!isSeasonalRecess(d)) remaining--;
        }
        return d;
    }

    // Deadlines implied by detected milestones. Returns Date objects (UTC) or null.
    //   rmoaDue: 30 days after perfection, rolled to the next business day,
    //            unless the RMOA is already filed.
    //   ctrDue:  21 days after the CTR production order, rolled to the next
    //            business day, while still outstanding.
    function computeDeadlines(m) {
        var out = { rmoaDue: null, ctrDue: null };
        if (!(m.rmoa && m.rmoa.found) && m.perfected && m.perfected.found && m.perfected.date) {
            out.rmoaDue = rollToBusinessDay(addDays(m.perfected.date, 30));
        }
        if (m.ctr && m.ctr.status === 'ordered' && m.ctr.order_date) {
            out.ctrDue = rollToBusinessDay(addDays(m.ctr.order_date, 21));
        }
        return out;
    }

    // ── Regex milestone detection ─────────────────────────────────────────────────

    function detectMilestonesRegex(entries) {
        var m = {
            perfected:       { found: false, date: null },
            rmoa:            { found: false, date: null },
            reply:           { found: false, date: null },
            stay:            { status: null },
            motion:          { status: null },
            pending_leave:   { found: false },
            ctr:             { status: null, order_date: null, filed_date: null },
            applicant_fmoa:  { found: false, date: null },
            respondent_fmoa: { found: false, date: null },
            jr_scheduled:    { found: false, datetime: null },
            jr_heard:        { found: false, date: null },
            jr_decision:     { status: null },
            leave_dismissed: { found: false, date: null },
            discontinued:    { found: false, date: null },
        };

        var sorted = entries.slice().sort(function (a, b) { return a.RE_NO - b.RE_NO; });

        sorted.forEach(function (e) {
            var t  = (e.RECORDED_ENTRY || '').trim();
            if (e.REGISTRY_NOTES_EXTERNAL) t += '\n' + e.REGISTRY_NOTES_EXTERNAL.trim();
            if (e.COMMAND_PHRASE_EN)        t += '\n' + e.COMMAND_PHRASE_EN.trim();
            var dt = e.DOC_DT ? e.DOC_DT.split('T')[0] : null;

            if (/^\*+\s*(CANCELLED|ANNUL)/i.test(t)) return;

            // Perfected
            if (!m.perfected.found &&
                (/applicant'?s record/i.test(t) || /application record/i.test(t)) &&
                /on behalf of applicant/i.test(t) && /filed on/i.test(t)) {
                m.perfected = { found: true, date: dt };
            }

            // RMOA (leave stage only — not Further)
            if (!m.rmoa.found &&
                /memorandum of argument on behalf of the respondent/i.test(t) &&
                !/further memorandum/i.test(t)) {
                m.rmoa = { found: true, date: dt };
            }

            // Reply
            if (!m.reply.found &&
                (/reply memorandum on behalf of the applicant/i.test(t) ||
                 /\breply on behalf of the applicant/i.test(t))) {
                m.reply = { found: true, date: dt };
            }

            // Stay
            if (/granting the stay of (execution|removal)/i.test(t)) {
                m.stay.status = 'granted';
            } else if (/order rendered/i.test(t) && /stay/i.test(t) && /(dismiss|den(ied|y))/i.test(t)) {
                m.stay.status = 'dismissed';
            } else if ((!m.stay.status || m.stay.status === 'dismissed') &&
                       /notice of motion/i.test(t) && /stay of (execution|removal)/i.test(t)) {
                m.stay.status = 'filed';
            }

            // Other motions (not stay)
            if (/notice of motion/i.test(t) && !/stay of (execution|removal)/i.test(t)) {
                if (!m.motion.status || m.motion.status === 'decided_or_abandoned') m.motion.status = 'filed_no_response';
            } else if (/motion record in response to motion/i.test(t) && m.motion.status === 'filed_no_response') {
                m.motion.status = 'decision_pending';
            } else if (/order rendered/i.test(t) && m.motion.status && m.motion.status !== 'decided_or_abandoned' &&
                       !/stay of (execution|removal)/i.test(t) && !/granting the application for leave/i.test(t)) {
                m.motion.status = 'decided_or_abandoned';
            }

            // Pending leave
            if (/communication to the court from the registry/i.test(t) && /leave disposition/i.test(t)) {
                m.pending_leave.found = true;
            }

            // CTR ordered — the order directing the tribunal to produce its record (a
            // "Production Order" in FC parlance). Match the operative wording (singular or
            // plural, with the optional "a") OR an explicit Production Order — but not a
            // motion or letter *requesting* one.
            if (!m.ctr.status &&
                (/tribunal shall send (a )?certified cop(y|ies) of its record/i.test(t) ||
                 (/\bproduction order\b/i.test(t) && !/motion|requesting|request for/i.test(t)))) {
                m.ctr.status     = 'ordered';
                m.ctr.order_date = dt;
            }

            // CTR filed — "Certified copy of the record sent by ... pursuant to the order of
            // the Court". RAD/RPD (refugee) files insert "and audio files" before "sent by",
            // so allow an optional clause between "record" and "sent by".
            if (/certified copy of the record(?: and [\w ]+?)? sent by/i.test(t) &&
                /pursuant to the order of the court/i.test(t)) {
                m.ctr.status     = 'filed';
                m.ctr.filed_date = dt;
            }

            // JR Scheduled (leave granted + hearing date fixed). Two docket formats:
            //   Old:  "granting the application for leave fixing the hearing at a Special Sitting
            //          at <city> on <DD-MON-YYYY> to begin at <HH:MM>"
            //   New (2026): "Result - Leave granted, Judicial Review scheduled ... on <Weekday>,
            //          <Month> <D>, <YYYY>, to commence at <time>"
            var jrOld = /granting the application for leave/i.test(t) &&
                        /fixing the hearing at a special sitting/i.test(t);
            var jrNew = /leave granted,?\s*judicial review scheduled/i.test(t);
            if (!m.jr_scheduled.found && (jrOld || jrNew)) {
                m.jr_scheduled.found = true;
                var jrOldMatch = t.match(/special sitting at ([A-Za-zÀ-ÿ.'() -]+?) on (\d{1,2}-[A-Z]{3}-\d{4}) to begin at (\d{1,2}:\d{2})/i);
                var jrNewMatch = t.match(/on ([A-Z][a-z]+day,\s*[A-Z][a-z]+\s+\d{1,2},\s*\d{4}),?\s*to commence at\s*([\d:]+\s*(?:[ap]\.?m\.?)?)/i);
                if      (jrOldMatch) m.jr_scheduled.datetime = jrOldMatch[1].trim() + ' ' + jrOldMatch[2] + ' ' + jrOldMatch[3];
                else if (jrNewMatch) m.jr_scheduled.datetime = jrNewMatch[1].trim() + ' ' + jrNewMatch[2].trim();
                m.pending_leave.found = false;
            }

            // JR rescheduled — "Order (time and place) ... rescheduling Judicial Review ... now
            // to be heard at Special Sitting in <city> on <DD-MON-YYYY> to begin at <HH:MM>".
            // Entries are processed chronologically, so the latest reschedule wins.
            if (/reschedul/i.test(t) && /judicial review/i.test(t) && /now to be heard/i.test(t)) {
                var jrReMatch = t.match(/now to be heard at .*?sitting (?:at|in) ([A-Za-zÀ-ÿ.'() -]+?) on (\d{1,2}-[A-Z]{3}-\d{4})(?: to begin at (\d{1,2}:\d{2}))?/i);
                if (jrReMatch) {
                    m.jr_scheduled.found    = true;
                    m.jr_scheduled.datetime = jrReMatch[1].trim() + ' ' + jrReMatch[2] + (jrReMatch[3] ? ' ' + jrReMatch[3] : '');
                    m.pending_leave.found   = false;
                }
            }

            // Leave dismissed — old: "Order rendered ... dismissing the application for leave";
            // new (2026): "Order (Final) dated ... Result - Leave dismissed". Require the
            // "dismissing the application for leave" phrase itself (not just "dismiss" and
            // "application for leave" appearing separately in the entry, which also matches
            // unrelated orders — e.g. one dismissing a stay motion "pending the determination
            // of the application for leave").
            var isLeaveDismissal =
                (/order rendered/i.test(t) && /dismissing the application for leave\b/i.test(t)) ||
                /result\s*[-:–—]\s*leave dismissed/i.test(t);
            if (isLeaveDismissal) {
                m.pending_leave.found = false;
                m.leave_dismissed = { found: true, date: dt };
            }

            // Applicant FMOA
            if (!m.applicant_fmoa.found && /further memorandum of argument on behalf of the applicant/i.test(t)) {
                m.applicant_fmoa = { found: true, date: dt };
            }

            // Respondent FMOA
            if (!m.respondent_fmoa.found && /further memorandum of argument on behalf of the respondent/i.test(t)) {
                m.respondent_fmoa = { found: true, date: dt };
            }

            // JR Heard
            if (!m.jr_heard.found && /before the court:[\s\S]*?judicial review/i.test(t) && /result of hearing:/i.test(t)) {
                m.jr_heard = { found: true, date: dt };
            }

            // JR Decision. Skip when this same entry is a leave dismissal (e.g. "Order
            // rendered dismissing the application for leave and for judicial review (Final
            // Decision)") — that's a terminal leave refusal, not a decision on JR merits, so
            // it shouldn't mark the JR as heard.
            if (!isLeaveDismissal && /\(final decision\)/i.test(t) && /judicial review/i.test(t)) {
                if      (/result:\s*granted/i.test(t))   m.jr_decision.status = 'granted';
                else if (/result:\s*dismissed/i.test(t)) m.jr_decision.status = 'dismissed';
                m.pending_leave.found = false;
                if (!m.jr_heard.found) m.jr_heard = { found: true, date: dt };
            }

            // Discontinued
            if (!m.discontinued.found && /notice of discontinuance/i.test(t)) {
                m.discontinued = { found: true, date: dt };
                m.pending_leave.found = false;
            }
        });

        return m;
    }

    function formatCounsel(nameStr) {
        if (!nameStr || !nameStr.trim()) return '—';
        var parts = nameStr.split(',');
        if (parts.length >= 2) {
            return titleCase(parts[1].trim()) + ' ' + titleCase(parts[0].trim());
        }
        return titleCase(nameStr.trim());
    }

    function titleCase(str) {
        // Unicode-aware: \b\w is ASCII-only and mangles accented names (e.g. "BÉLANGER,
        // MARIE-ÈVE" → "Marie-èVe BéLanger"). Uppercase each letter that starts a word,
        // where "starts a word" means preceded by start-of-string or a non-letter.
        return str.toLowerCase().replace(/(?<=^|[^\p{L}])\p{L}/gu, function (c) { return c.toUpperCase(); });
    }

    function fmtDate(d) {
        if (!d) return '—';
        if (typeof d === 'string' && d.indexOf('/Date(') === 0) {
            var ms = parseInt(d.replace('/Date(', '').replace(')/', ''), 10);
            d = new Date(ms).toISOString();
        }
        return d.split('T')[0];
    }

    var api = {
        FC_HOLIDAYS: FC_HOLIDAYS,
        isSeasonalRecess: isSeasonalRecess,
        rollToBusinessDay: rollToBusinessDay,
        addDays: addDays,
        computeDeadlines: computeDeadlines,
        detectMilestonesRegex: detectMilestonesRegex,
        formatCounsel: formatCounsel,
        titleCase: titleCase,
        fmtDate: fmtDate,
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
