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
    // Court of Appeal milestones (m.kind 'appeal' / 'fca_application') return their
    // own set of due dates — see computeAppealDeadlines / computeApplicationDeadlines.
    function computeDeadlines(m) {
        if (m && m.kind === 'appeal')          return computeAppealDeadlines(m);
        if (m && m.kind === 'fca_application') return computeApplicationDeadlines(m);
        if (m && m.kind === 'other')           return {};
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

    // Ordered milestone badges for display — shared by the page and the Excel
    // export. todayStr is a local-calendar YYYY-MM-DD, compared as a string:
    // due dates are UTC midnight, so comparing Date objects against local time
    // would flip a deadline to overdue hours early anywhere west of UTC.
    // Each badge is { text, tone } where tone is green|amber|red|gray|neutral.
    function milestoneBadges(m, todayStr) {
        if (m && (m.kind === 'appeal' || m.kind === 'fca_application')) return fcaBadges(m, todayStr);
        if (m && m.kind === 'other') return [];
        var out = [];
        var due = computeDeadlines(m);

        function push(text, tone) { out.push({ text: text, tone: tone }); }
        function dateStr(d) { return d ? d.split('T')[0] : ''; }
        function iso(d) { return d.toISOString().split('T')[0]; }
        function dueTone(d) { return iso(d) < todayStr ? 'red' : 'amber'; }

        if (m.perfected && m.perfected.found) push('PERFECTED ' + dateStr(m.perfected.date), 'green');

        if (m.rmoa && m.rmoa.found)  push('RMOA FILED ' + dateStr(m.rmoa.date), 'green');
        else if (due.rmoaDue)        push('RMOA DUE ' + iso(due.rmoaDue), dueTone(due.rmoaDue));

        if (m.reply && m.reply.found) push('REPLY FILED' + (m.reply.date ? ' ' + dateStr(m.reply.date) : ''), 'green');

        if (m.stay && m.stay.status) {
            var sc = {
                filed:     ['STAY FILED',     'amber'],
                granted:   ['STAY GRANTED',   'green'],
                dismissed: ['STAY DISMISSED', 'red'],
            }[m.stay.status];
            if (sc) push(sc[0], sc[1]);
        }

        if (m.motion && m.motion.status) {
            var mc = {
                filed_no_response:    ['MOTION FILED',   'amber'],
                decision_pending:     ['MOTION PENDING', 'amber'],
                decided_or_abandoned: ['MOTION DECIDED', 'neutral'],
            }[m.motion.status];
            if (mc) push(mc[0], mc[1]);
        }

        if (m.pending_leave && m.pending_leave.found) push('WITH COURT', 'gray');

        if (m.leave_dismissed && m.leave_dismissed.found) {
            push('LEAVE DISMISSED' + (m.leave_dismissed.date ? ' ' + dateStr(m.leave_dismissed.date) : ''), 'red');
        }

        if (m.ctr && m.ctr.status) {
            if (m.ctr.status === 'filed') {
                push('CTR FILED' + (m.ctr.filed_date ? ' ' + dateStr(m.ctr.filed_date) : ''), 'green');
            } else if (m.ctr.status === 'ordered') {
                if (due.ctrDue) push('CTR DUE ' + iso(due.ctrDue), dueTone(due.ctrDue));
                else            push('CTR ORDERED', 'amber');
            }
        }

        if (m.applicant_fmoa && m.applicant_fmoa.found) {
            push('APPLICANT FMOA' + (m.applicant_fmoa.date ? ' ' + dateStr(m.applicant_fmoa.date) : ''), 'green');
        }
        if (m.respondent_fmoa && m.respondent_fmoa.found) {
            push('RESPONDENT FMOA' + (m.respondent_fmoa.date ? ' ' + dateStr(m.respondent_fmoa.date) : ''), 'green');
        }

        // JR Scheduled — suppress once hearing has occurred
        if (m.jr_scheduled && m.jr_scheduled.found && !(m.jr_heard && m.jr_heard.found)) {
            var jrDt = m.jr_scheduled.datetime || '';
            push('JR SCHEDULED' + (jrDt ? ' ' + jrDt.split('T')[0] : ''), 'red');
        }

        // JR Heard with result folded in
        if (m.jr_heard && m.jr_heard.found) {
            var heardLabel = 'JR HEARD' + (m.jr_heard.date ? ' ' + dateStr(m.jr_heard.date) : '');
            var result = m.jr_decision && m.jr_decision.status;
            if      (result === 'granted')   push(heardLabel + ' — GRANTED',   'green');
            else if (result === 'dismissed') push(heardLabel + ' — DISMISSED', 'red');
            else                             push(heardLabel, 'neutral');
        }

        if (m.discontinued && m.discontinued.found) {
            push('DISCONTINUED' + (m.discontinued.date ? ' ' + dateStr(m.discontinued.date) : ''), 'green');
        }

        return out;
    }

    // Works out which party is the applicant and, where the Crown is the
    // applicant, who the respondent is — then returns each side's firm and
    // counsel. Returns { applicant: {firm, counsel}|null, respondent: {firm, counsel}|null }.
    // With a `kind` (see proceedingKind) the result also carries `labels` naming the
    // two sides; Court of Appeal kinds resolve both sides from the style of cause.
    function resolveCounsel(parties, styleOfCause, kind) {
        if (kind === 'appeal' || kind === 'fca_application' || kind === 'other') {
            return resolveCounselFCA(parties, styleOfCause, kind);
        }
        if (kind) {
            var r = resolveCounsel(parties, styleOfCause);
            r.labels = { applicant: 'Applicant', respondent: 'Respondent' };
            return r;
        }
        parties = parties || [];
        var socUpper = (styleOfCause || '').toUpperCase();
        var vIdx     = socUpper.indexOf(' V. ');
        var socLeft  = (vIdx !== -1) ? socUpper.substring(0, vIdx).trim() : socUpper;

        var govKeywords = ['MCI', 'MPSEP', 'MINISTER', 'ATTORNEY GENERAL', ' AG ', 'CBSA', 'PUBLIC SAFETY', 'SOLICITOR GENERAL'];
        var applicantIsGov = govKeywords.some(function (k) { return socLeft.includes(k); });

        var govParties = [], individualParties = [];
        parties.forEach(function (p) {
            var n = (p.PARTY_NAME || '').toUpperCase();
            var isGov = n.includes('MINISTER') || n.includes('ATTORNEY GENERAL') ||
                        n.includes('CBSA') || n.includes('CROWN') ||
                        n.includes('CANADA BORDER') || n.includes('PUBLIC SAFETY') ||
                        n.includes('SOLICITOR GENERAL');
            (isGov ? govParties : individualParties).push(p);
        });

        var applicantParty  = applicantIsGov ? (govParties[0]        || null) : (individualParties[0] || null);
        var respondentParty = applicantIsGov ? (individualParties[0] || null) : null;

        function side(p) {
            return p ? { firm: p.SOLCTR_FIRM || '—', counsel: formatCounsel(p.SOLCTR_CONTACT) } : null;
        }
        return { applicant: side(applicantParty), respondent: side(respondentParty) };
    }

    // Recorded-entry text as shown in the docket table: the entry itself plus
    // any external registry notes and command phrase, one per line.
    function entryDescription(e) {
        var desc = (e.RECORDED_ENTRY || '').trim();
        if (e.REGISTRY_NOTES_EXTERNAL) desc += '\n' + e.REGISTRY_NOTES_EXTERNAL.trim();
        if (e.COMMAND_PHRASE_EN)        desc += '\n' + e.COMMAND_PHRASE_EN.trim();
        return desc;
    }

    // ══ Federal Court of Appeal ═══════════════════════════════════════════════════
    //
    // Everything below is used only for Court of Appeal files (proceedingKind other
    // than 'aljr'); Federal Court files keep the functions above, unchanged.

    // Court file numbers. Federal Court: IMM-12345-25, T-1234-25 (division t).
    // Federal Court of Appeal: A-123-25, and the Court of Appeal's "preliminary"
    // files YY-A-N (e.g. 26-A-29) — motions for an extension of time or for leave
    // brought before an appeal or application exists. The Court's endpoints serve
    // both FCA forms with division=a.
    function parseCourtNumber(str) {
        var s = String(str == null ? '' : str).toUpperCase()
            .replace(/[‐-―−]/g, '-').replace(/\s+/g, '');
        if (/^A-\d+-\d{2,4}$/.test(s) || /^\d{2}-A-\d+$/.test(s)) {
            return { valid: true, court: 'FCA', division: 'a', normalized: s };
        }
        if (/^[A-Z0-9]+-[0-9]+-[0-9]{2,4}$/.test(s)) {
            return { valid: true, court: 'FC', division: 't', normalized: s };
        }
        return { valid: false, court: null, division: null, normalized: s };
    }

    // Nature descriptions (English, with the French equivalents) of the FCA
    // proceedings that get milestones. Appeals: s.27 appeals from the Federal Court
    // (and the pre-2003 "Appeal from Trial" natures) and s.27(1.1)/(1.2) appeals from
    // the Tax Court — all governed by Part 6 of the Rules (r.335(a), (b)). Other
    // "Statutory Appeal" natures (appeals under other Acts) are left as 'other'.
    // Applications: s.28 judicial review, including natures that name a s.28(1)
    // tribunal without the "S.28" prefix.
    var FCA_APPEAL_NATURE = /^\s*(appeal\s*\(\s*s\.?\s*27\b|appeal from trial\b|statutory appeal\s*-\s*tax court|tax court of canada\s*\(\s*informal|appel\s*\(\s*art\.?\s*27\b|appel de prem\.? inst|appel prévu par la loi\s*-\s*cour canadienne de l'impôt|cour canadienne de l'impôt\s*\(\s*procédure informelle)/i;
    var FCA_APPLICATION_NATURE = /^\s*(s\.?\s*28\b|application\s*-\s*s\.?\s*28\b|appeal division of the social security tribunal|federal public sector labour relations|conflict of interest and ethics commissioner|special import measures act|art\.?\s*28\b|demande\s*-\s*art\.?\s*28\b|division d'appel du tribunal de la sécurité social)/i;

    // 'aljr' | 'appeal' | 'fca_application' | 'other', from a case record or a
    // recorded entry (division + nature). Every Federal Court file is 'aljr' (today's
    // behaviour). Optional `entries`: the originating document ("Notice of appeal" /
    // "Notice of application") settles appeal vs application when the nature is
    // miscoded (seen in the corpus: an "S.28 Others" file commenced by notice of appeal).
    function proceedingKind(x, entries) {
        x = x || {};
        var div = String(x.DIVISION || x.Division || '').toUpperCase();
        if (!div && x.COURT_NO) div = String(parseCourtNumber(x.COURT_NO).division || '').toUpperCase();
        if (div !== 'A') return 'aljr';
        if (/preliminary|préliminaire/i.test(x.ENGLISH_PROCEEDING_TYPE || x.FRENCH_PROCEEDING_TYPE || '') ||
            /^\d{2}-A-\d+$/i.test(String(x.COURT_NO || '').trim())) return 'other';
        function byNature(n) {
            return FCA_APPEAL_NATURE.test(n) ? 'appeal' : FCA_APPLICATION_NATURE.test(n) ? 'fca_application' : 'other';
        }
        var kind = byNature(x.ENGLISH_NATURE_DESC || '');
        if (kind === 'other') kind = byNature(x.FRENCH_NATURE_DESC || '');
        if (kind !== 'other' && entries && entries.length) {
            var items = fcaItems(entries);
            for (var i = 0; i < items.length; i++) {
                if (FCA_RX.noticeOfAppeal.test(items[i].t))       { kind = 'appeal'; break; }
                if (FCA_RX.noticeOfApplication.test(items[i].t))  { kind = 'fca_application'; break; }
            }
        }
        return kind;
    }

    // ── Docket text helpers ──────────────────────────────────────────────────────

    var FCA_MONTHS = { JAN: 1, JANV: 1, FEB: 2, FEV: 2, 'FÉV': 2, MAR: 3, APR: 4, AVR: 4, MAY: 5, MAI: 5,
        JUN: 6, JUIN: 6, JUL: 7, JUIL: 7, AUG: 8, AOU: 8, 'AOÛ': 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12, 'DÉC': 12 };
    var FCA_MONTH_NAMES = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
        september: 9, october: 10, november: 11, december: 12, janvier: 1, 'février': 2, fevrier: 2, mars: 3,
        avril: 4, mai: 5, juin: 6, juillet: 7, 'août': 8, aout: 8, septembre: 9, octobre: 10, novembre: 11,
        'décembre': 12, decembre: 12 };
    var FCA_DATE = '(\\d{4}-\\d{2}-\\d{2}|\\d{1,2}-[A-Za-zÉÛéû]{3,5}-\\d{4})';

    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    function isoFrom(y, mo, d) { return (mo && d >= 1 && d <= 31) ? y + '-' + pad2(mo) + '-' + pad2(d) : null; }

    // 'DD-MON-YYYY' (English or French month), 'YYYY-MM-DD', 'Month D, YYYY' or
    // 'D mois YYYY' → 'YYYY-MM-DD', or null.
    function parseDocketDate(s) {
        var m;
        s = String(s || '').trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
        if ((m = s.match(/^(\d{1,2})-([A-Za-zÉÛéû]{3,5})\.?-(\d{4})$/))) return isoFrom(m[3], FCA_MONTHS[m[2].toUpperCase()], +m[1]);
        if ((m = s.match(/^([A-Za-zéû]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/))) return isoFrom(m[3], FCA_MONTH_NAMES[m[1].toLowerCase()], +m[2]);
        if ((m = s.match(/^(\d{1,2})(?:er)?\s+([A-Za-zéû]+)\s+(\d{4})$/))) return isoFrom(m[3], FCA_MONTH_NAMES[m[2].toLowerCase()], +m[1]);
        return null;
    }

    // Non-cancelled entries as { e, t, d }, sorted by document date then RE_NO
    // (FCA dockets are not always numbered in date order). Typographic apostrophes
    // are normalised so the patterns below can use a plain '.
    var FCA_SKIP = /^\*+\s*(CANCELLED|ANNUL|REMOVED|RETIR)|^recorded entry cancelled|^inscription (consignée )?annulée/i;
    function fcaItems(entries) {
        var out = [];
        (entries || []).forEach(function (e) {
            // '¿' stands in for a lost apostrophe in some entries ("Applicant¿s Affidavit").
            var t = entryDescription(e).replace(/[\u2018\u2019\u02bc]/g, "'").replace(/(\p{L})\u00bf(\p{L})/gu, "$1'$2");
            if (!t || FCA_SKIP.test(t)) return;
            out.push({ e: e, t: t, d: e.DOC_DT ? String(e.DOC_DT).split('T')[0] : null });
        });
        return out.sort(function (a, b) {
            if (a.d !== b.d) return (a.d || '') < (b.d || '') ? -1 : 1;
            return (a.e.RE_NO || 0) - (b.e.RE_NO || 0);
        });
    }

    // Service date stated in an entry: "served on 2026-10-15", or the date after
    // "proof of service / confirming service / attestant la signification ... on|le".
    // Filing, receipt and swearing dates are skipped.
    function serviceDateIn(t) {
        var m = t.match(new RegExp('\\bserved on ' + FCA_DATE, 'i'));
        if (m) return parseDocketDate(m[1]);
        var a = t.search(/proof of service|confirming service|attestant la signification|acknowledg(?:e)?ment of service/i);
        if (a < 0) return null;
        var rx = new RegExp('(\\p{L}+)\\s+(?:on|le)\\s+' + FCA_DATE, 'giu'), rest = t.slice(a), mm;
        while ((mm = rx.exec(rest))) {
            if (/^(filed|received|sworn|affirmed|declared|dated|file|déposée?|reçue?|assermentée?|déclarée?|datée?)$/i.test(mm[1])) continue;
            return parseDocketDate(mm[2]);
        }
        return null;
    }

    // Numbers an entry refers to: "Doc 5", "doc. #50", "Doc. No. 3", "document number
    // 29", "ID 15", or the 2026 style "58 - Notice of Motion".
    function referencedNumbers(t) {
        var out = [], m;
        var rx1 = /(?:\bdoc(?:ument)?s?\.?\s*(?:no\.?|nos\.?|number|#)?\s*|\bID\.?\s*#?\s*)(\d+(?:\s*(?:,|and|&|et)\s*\d+)*)/gi;
        while ((m = rx1.exec(t))) m[1].split(/\D+/).forEach(function (n) { if (n) out.push(+n); });
        var rx2 = /(?:^|[\s,(])(\d{1,4})\s+-\s+[A-Z]/g;
        while ((m = rx2.exec(t))) out.push(+m[1]);
        return out;
    }
    function refersTo(t, item) {
        var refs = referencedNumbers(t), e = item.e;
        return refs.some(function (n) { return n === e.RE_NO || (e.DOCNO != null && n === +e.DOCNO); });
    }

    // Who filed an entry: 'A' (appellant/applicant), 'R' (respondent), 'both',
    // 'intervener', or null. Interveners are not parties (r.2, r.109), so their
    // memoranda and records must never count as a party's step.
    function filerSide(t) {
        var title = t.split(/\s(?:on behalf of|de la part de|au nom de)\b/i)[0];
        if (/^(memorand\w*|mémoire|book|cahier|record|dossier|written representations|prétentions)[^\n]{0,40}\binterven/i.test(title)) return 'intervener';
        var m = t.match(/(?:on behalf of|de la part de|au nom de|\bfrom|prepared by)\s*:?\s*([^\n]{0,90})/i);
        var clause = m ? m[1].split(/\s(?:with|filed|received|dated|sworn|affirmed|declared|in support|in response|in reply|in opposition|confirming|containing|pursuant|placed|served|regarding|concerning|for|to|against|déposée?s?|reçue?s?|concernant|à l'appui|qui se trouve|attestant|assermentée?|avec)\b|\//i)[0] : '';
        if (!clause) {
            var tm = title.match(/^(?:memorand\w*[^\n]{0,30}|mémoire[^\n]{0,30}|dossier)\s+(?:of the|de l'|de la partie|du|de la)\s+(\p{L}+)/iu);
            clause = tm ? tm[1] : '';
        }
        if (/interven/i.test(clause)) return 'intervener';
        var a = /\bappel{1,2}ants?\b|\bappelantes?\b|\bapplicants?\b|demande(?:u|re)(?:r|sse)s?\b/i.test(clause);
        var r = /\brespondents?\b|\bintim[ée]e?s?\b|défende(?:u|re)(?:r|sse)s?\b/i.test(clause);
        if (/\ball parties\b|\bboth parties\b|\bthe parties\b|^parties\b|\bdes parties\b|deux parties|toutes les parties/i.test(clause) || (a && r)) return 'both';
        return a ? 'A' : r ? 'R' : null;
    }

    // The side a certificate of service says was served ("upon Respondent").
    function servedUponSide(t) {
        var m = t.match(/\b(?:upon|on)\s+(?:the\s+)?(respondents?|appellants?|applicants?|all parties)\b/i) ||
                t.match(/\bà la partie (appelante|intimée|demanderesse|défenderesse)/i);
        if (!m) return null;
        var w = m[1].toLowerCase();
        return /all/.test(w) ? 'both' : /appel|applic|demand/.test(w) ? 'A' : 'R';
    }

    var FCA_RX = {
        noticeOfAppeal:      /^(?:amended\s+)?(?:notice of appeal\b|avis d'appel\b)(?![^\n]{0,15}(?:incident|cross))/i,
        noticeOfApplication: /^(?:amended\s+)?(?:notice of application\b|avis de demande\b)/i,
        crossAppeal:         /^(?:notice of cross[- ]appeal|avis d'appel incident)/i,
        appearance:          /^(?:notice of appearance|avis de comparution)/i,
        serviceProof:        /^(?:solicitor'?s'? certificate of service|certificate of service|affidavit of service|service copy|copy of r\.?\s*133|acknowledg(?:e)?ment of (?:service|receipt)|attestation de signification|accusé de réception|affidavit (?:of|de) [^\n]{0,160}?(?:confirming service|attestant la signification))/i,
        abAgreement:         /^(?:agreement\b[^\n]{0,60}appeal book|entente[^\n]{0,60}dossier d'appel)/i,
        abContents:          /contents? (?:of|in) the appeal book|contenu du dossier d'appel/i,
        appealBook:          /^(?:appeal book|dossier d'appel)\b/i,
        memo:                /^(?:memorand(?:um|a)\s+of\s+(?:fact\s+and\s+law|argument)|mémoire\b)/i,
        motionContext:       /contained within a motion record|qui se trouve dans le dossier de requête|in (?:support|opposition|response|reply) (?:of|to) (?:the )?(?:doc|motion|notice of motion|id)|\bmotion\b|requête|status review|examen de l'état/i,
        requisition:         /^(?:requisition for hearing|demande d'audience)/i,
        hearingOrder:        /^(?:order \(time and place\)|ordonnance \(temps et lieu\)|order scheduling time and place|ordonnance fixant (?:les )?(?:date|temps|heure))/i,
        heard:               /^(?:this matter comes on for hearing|cette affaire (?:est|a été) entendue|l'affaire (?:est|a été) entendue|audience tenue)/i,
        courtIssued:         /^(?:order\b|ordonnance\b|directions? of the court|written directions|oral directions|directive|copy of decision|judgment\b|jugement\b|notice of status review|avis d'examen)/i,
        finalDecision:       /^(?:judgment\b|jugement\b|order \(final\)|ordonnance \(finale?\))|\((?:final decision|décision finale)\)/i,
        decisionOnMerits:    /^(?:order|ordonnance)\b[\s\S]*?(?:with regard to|regarding|concernant)\s+(?:the\s+|l')?(?:appeal\b(?!\s+book)|appel\b(?!\s+incident)|application\b(?!\s+(?:for leave|for an?\b|to\b|record))|demande\b(?!\s+d'autorisation|\s+de prorogation)|doc\s*#\s*1\s*-\s*notice of (?:appeal|application))/i,
        discontinuance:      /^(?:notice of discontinuance|avis de désistement)/i,
        noticeOfMotion:      /^(?:notice of motion|avis de requête)/i,
        stayMotion:          /\bstay\b|\bstaying\b|sursis|surseoir/i,
        motionResponse:      /^(?:motion record|written representations|memorandum of fact and law|reply|dossier de (?:la )?requête|prétentions écrites|réplique)[\s\S]{0,200}?(?:in response|in opposition|in reply|responding|en réponse|en opposition)/i,
        statusReview:        /^(?:notice of status review|avis d'examen de l'état de l'instance)/i,
        statusReviewReps:    /^(?:submissions|representations|written representations|représentations|observations)\b[^\n]{0,40}(?:status review|examen de l'état)|^(?:submissions|representations)\s*\(status review\)/i,
        rule74:              /\brule\s*74\b|\br\.\s*74\b|règle 74|section 74 of the (?:act|immigration)|\b74\s*\(d\)/i,
        rule74Passed:        /doomed to fail test is (?:also )?not met|is not doomed|(?:appeal|application) may proceed|shall proceed|(?:shall|will) not be removed/i,
        extension:           /extensions? of (?:the )?time|\bextend(?:s|ed|ing)?\b[^.\n]{0,60}\b(?:time|timelines?|deadlines?|periods?|dates?)\b|\brule\s*7\b|\br\.\s*7\b|\bEOT\b|prorog|délai supplémentaire/i,
        schedule:            /schedul|timetable|échéancier|calendrier|time periods|shall (?:serve and )?file|shall be (?:served and )?filed|no later than|on or before|within (?:\w+ )?\(?\d+\)? (?:business |calendar )?days|dans les (?:\w+ )?\(?\d+\)? jours|au plus tard/i,
        suspension:          /abeyance|timelines?[^.\n]{0,40}suspended|suspended pending|en suspens|délais?[^.\n]{0,40}suspendus?/i,
    };

    function resultOf(t) {
        if (/notice of appeal[^.\n]{0,40}removed|removed from the (?:court )?file|retiré du dossier|court file close/i.test(t)) return 'removed';
        if (/transferred to the federal court\b(?! of appeal)|transféré[^.\n]{0,40}cour fédérale\b(?! d'appel)/i.test(t)) return 'transferred';
        if (/dismissed for delay|rejet[ée]+[^.\n]{0,30}(?:retard|délai)/i.test(t)) return 'dismissed_for_delay';
        if (/(?:result\s*[-:–]\s*)?(?:granted|allowed) in part|accueilli(?:e)? en partie/i.test(t)) return 'allowed_in_part';
        if (/result\s*[-:–]\s*(?:granted|allowed)|\b(?:appeal|application)(?: for judicial review)? is allowed|résultat\s*:\s*(?:affaire\s+)?(?:accueillie?|accordée?)|\best accueillie?/i.test(t)) return 'allowed';
        if (/(?:notice of appeal|appeal)[^.\n]{0,30}(?:is|are|be) (?:struck|quashed)|quashing the appeal/i.test(t)) return 'struck';
        if (/result\s*[-:–]\s*dismissed|\bis dismissed\b|résultat\s*:\s*(?:affaire\s+)?rejet|\best rejeté/i.test(t)) return 'dismissed';
        return null;
    }

    // Steps a consent / order / letter about time talks about, or null if it does
    // not say (then it is treated as touching every step still running).
    function stepTargets(t, kind) {
        var s = [];
        function add(k) { if (s.indexOf(k) === -1) s.push(k); }
        if (/(?:subsequent|remaining|further|all other) steps|étapes (?:subséquentes|suivantes|restantes)/i.test(t) &&
            !/governed by the (?:timelines|time limits|periods)[^.]{0,30}\brules\b/i.test(t)) {
            return kind === 'appeal'
                ? ['appearance', 'ab_agreement', 'appeal_book', 'appellant_memo', 'respondent_memo', 'cross_reply_memo', 'requisition']
                : ['appearance', 'applicant_affidavits', 'respondent_affidavits', 'applicant_record', 'respondent_record', 'requisition'];
        }
        // ("without personal appearance" in every order is not about the notice of appearance)
        if (/notice of appearance|avis de comparution/i.test(t)) add('appearance');
        if (/\brequisition\b|demande d'audience/i.test(t)) add('requisition');
        if (kind === 'appeal') {
            if (/agreement|entente|contents? (?:of|in) the appeal book|contenu du dossier/i.test(t)) add('ab_agreement');
            var tb = t.replace(/agreement[^.\n]{0,25}appeal book|appeal book agreement|contents? (?:of|in) the appeal book|contenu du dossier d'appel/ig, '');
            if (/appeal book|dossier d'appel/i.test(tb)) add('appeal_book');
            var app  = /(?:appellant|applicant|appelante?)'?s?'?\s+(?:memorand|mémoire|factum)|(?:memorand\w*|mémoire|factum)[^.;\n]{0,40}\b(?:of|for|by|de)\s+(?:the\s+|l')?(?:appellant|appelant)/i.test(t);
            var resp = /(?:respondent|intimée?)'?s?'?\s+(?:memorand|mémoire|factum)|(?:memorand\w*|mémoire|factum)[^.;\n]{0,40}\b(?:of|for|by|de)\s+(?:the\s+|l')?(?:respondent|intimé)/i.test(t);
            if (app) add('appellant_memo');
            if (resp) add('respondent_memo');
            if (!app && !resp && /memorand|mémoire|factum/i.test(t)) { add('appellant_memo'); add('respondent_memo'); add('cross_reply_memo'); }
            if (/cross[- ]appeal|appel incident/i.test(t) && /memorand|mémoire/i.test(t)) add('cross_reply_memo');
        } else {
            var aa = /(?:applicant|appellant)'?s?'?\s+(?:rule 306\s+)?affidavit|rule 306|\br\.\s*306/i.test(t);
            var ra = /respondent'?s?'?\s+(?:rule 307\s+)?affidavit|rule 307|\br\.\s*307/i.test(t);
            if (aa) add('applicant_affidavits');
            if (ra) add('respondent_affidavits');
            if (!aa && !ra && /affidavit/i.test(t)) { add('applicant_affidavits'); add('respondent_affidavits'); }
            var tr = t.replace(/motion record|tribunal record|certified (?:tribunal )?record|record of the tribunal/ig, '');
            var ar = /(?:applicant|appellant)'?s?'?\s+record|application record|dossier (?:de la partie )?demande/i.test(tr);
            var rr = /respondent'?s?'?\s+record|dossier (?:de la partie )?défende|dossier de l'intimé/i.test(tr);
            if (ar) add('applicant_record');
            if (rr) add('respondent_record');
            if (!ar && !rr && /\brecords?\b|\bdossiers?\b/i.test(tr)) { add('applicant_record'); add('respondent_record'); }
        }
        return s.length ? s : null;
    }

    // Service date for the step filed at items[i]: stated in the entry itself, else
    // from a certificate/affidavit of service within 10 days that refers to it (by
    // document number, or by keyword when it was served on the other side).
    function serviceFor(items, i, keywordRx, side, originating) {
        var own = serviceDateIn(items[i].t);
        if (own) return own;
        // r.133(1),(3): personal service of an originating document on the Crown is effected
        // by filing it, and is effective at the time of filing. The Registry's "R.133" email
        // to Justice is a transmittal under r.133(2), not the date of service.
        if (originating && items.some(function (s) {
            return s.d && Math.abs(new Date(s.d).getTime() - new Date(items[i].d).getTime()) <= 30 * 86400000 &&
                   /\b(?:r(?:ule)?\.?\s*133|règle 133)\b|\bR133\b/i.test(s.t) && (refersTo(s.t, items[i]) || keywordRx.test(s.t) || /^(?:service copy|copy of r|certified copy of doc|memorandum to file|acknowledg)/i.test(s.t));
        })) return items[i].d;
        var d0 = new Date(items[i].d).getTime(), best = null;
        items.forEach(function (s, j) {
            if (j === i || !FCA_RX.serviceProof.test(s.t) || !s.d) return;
            if (Math.abs(new Date(s.d).getTime() - d0) > 10 * 86400000) return;
            var linked = refersTo(s.t, items[i]) ||
                         (keywordRx.test(s.t) && (!side || servedUponSide(s.t) !== side));
            if (!linked) return;
            var sd = serviceDateIn(s.t);
            if (sd && (!best || sd < best)) best = sd;
        });
        return best;
    }

    function blankStep() { return { found: false, date: null }; }
    function blankServed() { return { found: false, date: null, served: null }; }

    function emptyFcaMilestones(kind) {
        var m = { kind: kind };
        if (kind === 'appeal') {
            m.notice_of_appeal  = blankServed();
            m.appearance        = blankStep();
            m.cross_appeal      = blankStep();
            m.ab_agreement      = { found: false, date: null, by_order: false };
            m.ab_content_motion = blankStep();
            m.appeal_book       = blankStep();
            m.appellant_memo    = blankServed();
            m.respondent_memo   = blankServed();
            m.cross_reply_memo  = blankStep();
        } else {
            m.notice_of_application = blankServed();
            m.appearance            = blankStep();
            m.tribunal_record       = blankStep();
            m.applicant_affidavits  = blankServed();
            m.respondent_affidavits = blankServed();
            m.applicant_record      = blankServed();
            m.respondent_record     = blankServed();
        }
        m.requisition       = blankStep();
        m.hearing_scheduled = { found: false, date: null, time: null, place: null };
        m.heard             = blankStep();
        m.outcome           = { status: null, date: null };
        m.discontinued      = blankStep();
        m.stay              = { status: null };
        m.motion            = { status: null };
        m.r74_review        = { status: null, date: null };
        m.status_review     = { status: null, date: null };
        m.time_events       = [];
        return m;
    }

    // Regex milestone detection for Court of Appeal appeals ('appeal') and s.28
    // applications ('fca_application'). Same object shape as the AI prompt returns.
    function detectFcaMilestones(entries, kind) {
        var m = emptyFcaMilestones(kind);
        var items = fcaItems(entries);
        var isAppeal = kind === 'appeal';
        var stayEntries = [], openMotions = [], anyMotion = false, respAffItems = [];

        function mark(key, it, extra) {
            if (m[key].found) return false;
            m[key].found = true;
            m[key].date  = it.d;
            if (extra) Object.keys(extra).forEach(function (k) { m[key][k] = extra[k]; });
            return true;
        }

        items.forEach(function (it, i) {
            var t = it.t, side = filerSide(t);
            var court = FCA_RX.courtIssued.test(t);
            var isStepFiling = false;

            // Originating document
            if (isAppeal && FCA_RX.noticeOfAppeal.test(t)) {
                isStepFiling = true;
                if (mark('notice_of_appeal', it)) m.notice_of_appeal.served = serviceFor(items, i, /notice of appeal|avis d'appel/i, 'A', true);
            }
            if (!isAppeal && FCA_RX.noticeOfApplication.test(t)) {
                isStepFiling = true;
                if (mark('notice_of_application', it)) m.notice_of_application.served = serviceFor(items, i, /notice of application|avis de demande/i, 'A', true);
            }

            // Appearance (respondent's; an "appearance on behalf of the appellant" is not one)
            if (FCA_RX.appearance.test(t) && side !== 'A' && side !== 'intervener') mark('appearance', it);

            if (isAppeal) {
                if (FCA_RX.crossAppeal.test(t)) { mark('cross_appeal', it); isStepFiling = true; }
                if (FCA_RX.abAgreement.test(t)) { mark('ab_agreement', it); isStepFiling = true; }
                // r.343(3): order determining the content of the appeal book (same effect for r.345)
                if (/^(?:order|ordonnance)\b/i.test(t) && FCA_RX.abContents.test(t) && resultOf(t) !== 'dismissed') {
                    mark('ab_agreement', it, { by_order: true });
                }
                if (FCA_RX.noticeOfMotion.test(t) && FCA_RX.abContents.test(t)) mark('ab_content_motion', it);
                if (FCA_RX.appealBook.test(t) && /\bfiled\b|déposé/i.test(t) && !/supplement|supplémentaire|amended|modifié/i.test(t)) {
                    mark('appeal_book', it); isStepFiling = true;
                }
                if (FCA_RX.memo.test(t) && !FCA_RX.motionContext.test(t) && side !== 'intervener') {
                    var memoRx = /memorand|mémoire|factum/i;
                    if (side === 'A') {
                        isStepFiling = true;
                        var crossReply = m.cross_appeal.found && m.respondent_memo.found &&
                                         (m.appellant_memo.found || /cross[- ]appeal|appel incident/i.test(t));
                        if (crossReply) mark('cross_reply_memo', it);
                        else if (mark('appellant_memo', it)) m.appellant_memo.served = serviceFor(items, i, memoRx, 'A');
                    } else if (side === 'R') {
                        isStepFiling = true;
                        if (mark('respondent_memo', it)) m.respondent_memo.served = serviceFor(items, i, memoRx, 'R');
                    }
                }
            } else {
                // Tribunal material (r.318)
                if (/^(?:original material|certified cop(?:y|ies) of (?:the )?(?:original material|record|tribunal record)|copie certifiée)/i.test(t)) mark('tribunal_record', it);

                // Affidavits (r.306 / r.307): deemed filed when proof of service is filed.
                var proof = FCA_RX.serviceProof.test(t);
                var servedAff = /(?:confirming service of|attestant la signification d[eu']s?|service of)\s*(?:the\s+|his\s+|her\s+|their\s+|its\s+|les\s+|l')?(?:(?:applicant|appellant)'?s?'?\s+|amended\s+|rule 306\s+)*affidavit/i.test(t) ||
                                /affidavits? et (?:les )?pièces de la (?:partie )?demanderesse|rule 306|\br\.\s*306/i.test(t);
                var respAff = /respondent'?s?'?\s+(?:rule 307\s+)?affidavit|rule 307|\br\.\s*307|affidavit du défendeur|affidavit de (?:la partie )?(?:défenderesse|l'intimé)/i.test(t);
                if (proof && respAff) {
                    respAffItems.push(it);
                    isStepFiling = true;
                } else if (proof && servedAff && side !== 'R' && side !== 'intervener') {
                    if (mark('applicant_affidavits', it)) m.applicant_affidavits.served = serviceDateIn(t);
                    isStepFiling = true;
                } else if (/^affidavit (?:of|de)\b/i.test(t) && !proof && !FCA_RX.motionContext.test(t) && !/confirming service|attestant la signification/i.test(t)) {
                    if (side === 'A') { mark('applicant_affidavits', it); isStepFiling = true; }
                    else if (side === 'R') { respAffItems.push(it); isStepFiling = true; }
                }

                var recordRx = /^(?:applicant'?s'? record|application record|respondent'?s'? record|record\b|dossier (?:de la partie |du |de la |de l')(?:demande|défende|intim))/i;
                if (recordRx.test(t) && /\bfiled\b|déposé/i.test(t) && side !== 'intervener') {
                    var appRec  = /^(?:applicant'?s'? record|application record|dossier (?:de la partie |du |de la )demande)/i.test(t) || (/^record\b/i.test(t) && side === 'A');
                    var respRec = /^(?:respondent'?s'? record|dossier (?:de la partie |du |de la |de l')(?:défende|intim))/i.test(t) || (/^record\b/i.test(t) && side === 'R');
                    if (appRec && mark('applicant_record', it)) {
                        m.applicant_record.served = serviceFor(items, i, /record|dossier/i, 'A');
                    }
                    if (respRec && mark('respondent_record', it)) {
                        m.respondent_record.served = serviceFor(items, i, /record|dossier/i, 'R');
                    }
                    isStepFiling = true;
                }
            }

            if (FCA_RX.requisition.test(t)) { mark('requisition', it); isStepFiling = true; }

            // Hearing scheduled — the latest order fixing time and place wins.
            if (FCA_RX.hearingOrder.test(t) && !/fixing\s+(?:a\s+|the\s+)?motion|fixant\s+(?:la\s+)?requête|\b(?:this|the) motion is set down/i.test(t)) {
                var hs = { found: true, date: null, time: null, place: null };
                var mo = t.match(new RegExp('(?:sitting|séance spéciale)\\s+(?:in|at|à)\\s+(.+?)\\s+(?:on|le)\\s+' + FCA_DATE + '(?:\\s+(?:to begin at|à)\\s+(\\d{1,2}:\\d{2}))?', 'i'));
                var mn = t.match(/\bin\s+([A-ZÀ-Ý][^\n]*?),?\s+beginning at\s+(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?\s?m\.?)?)\s*,?\s+on\s+(?:[A-Z][a-z]+day,?\s+)?([A-Z][a-z]+\s+\d{1,2},\s*\d{4})/);
                if (mo)      { hs.place = mo[1].trim(); hs.date = parseDocketDate(mo[2]); hs.time = mo[3] || null; }
                else if (mn) { hs.place = mn[1].trim(); hs.time = mn[2].trim(); hs.date = parseDocketDate(mn[3]); }
                m.hearing_scheduled = hs;
            }

            // Heard — not a hearing of a motion ("Before the Court: Motion for a stay ...").
            if (FCA_RX.heard.test(t)) {
                var before = t.match(/before the court\s*:\s*([^\n]{0,40})/i);
                if (!(before && /motion|requête/i.test(before[1]))) mark('heard', it);
            }

            // Outcome on the merits — judgments and final orders only; the latest wins.
            var finalEntry = FCA_RX.finalDecision.test(t) || FCA_RX.decisionOnMerits.test(t);
            if (finalEntry && !/^(?:reasons|motifs|traduction|copy of)/i.test(t)) {
                var res = resultOf(t);
                if (res) m.outcome = { status: res, date: it.d };
            }

            // Discontinuance of the whole proceeding (not of a cross-appeal or in part)
            if (FCA_RX.discontinuance.test(t) && side !== 'intervener' &&
                !/cross|incident|in part|en partie|as against|à l'égard d/i.test(t)) mark('discontinued', it);

            // Motions. Stay motions tracked separately, as for the Federal Court.
            if (FCA_RX.noticeOfMotion.test(t)) {
                if (FCA_RX.stayMotion.test(t)) { stayEntries.push(it); m.stay.status = 'filed'; }
                else { openMotions.push({ items: [it], responded: false }); anyMotion = true; }
            } else {
                openMotions.forEach(function (mo2) {
                    if (mo2.items.some(function (x) { return refersTo(t, x); })) {
                        mo2.items.push(it);
                        if (FCA_RX.motionResponse.test(t)) mo2.responded = true;
                    }
                });
                if (FCA_RX.motionResponse.test(t) && !referencedNumbers(t).length && openMotions.length) {
                    openMotions[openMotions.length - 1].responded = true;
                }
            }
            if (/^(?:order|ordonnance)\b/i.test(t) && !FCA_RX.hearingOrder.test(t) && !finalEntry) {
                var refs = referencedNumbers(t);
                var isStayOrder = stayEntries.some(function (s) { return refersTo(t, s); }) ||
                                  (stayEntries.length && FCA_RX.stayMotion.test(t) && !refs.length);
                if (isStayOrder) {
                    var sr = resultOf(t);
                    if (sr === 'allowed' || sr === 'allowed_in_part') m.stay.status = 'granted';
                    else if (sr === 'dismissed') m.stay.status = 'dismissed';
                } else if (openMotions.length) {
                    openMotions = openMotions.filter(function (mo3) {
                        if (!refs.length) return false;   // an order naming no document closes all
                        return !mo3.items.some(function (x) { return refersTo(t, x); });
                    });
                }
            }

            // Status review (r.382.2 – 382.4)
            if (FCA_RX.statusReview.test(t)) m.status_review = { status: 'issued', date: it.d };
            else if (m.status_review.status === 'issued' && FCA_RX.statusReviewReps.test(t)) m.status_review.status = 'responded';
            else if (m.status_review.status && /^(?:order|ordonnance)\b/i.test(t) && /status review|examen de l'état/i.test(t)) m.status_review.status = 'decided';

            // Rule 74 review of the notice of appeal (timelines suspended while it runs)
            var evType = null;
            if (court && FCA_RX.rule74.test(t) && !FCA_RX.rule74Passed.test(t)) {
                if (m.r74_review.status !== 'pending') m.r74_review = { status: 'pending', date: it.d };
                evType = 'suspension';
            } else if (court && m.r74_review.status === 'pending' && FCA_RX.rule74Passed.test(t)) {
                m.r74_review.status = 'concluded';
            }

            // Time events: extensions, court-fixed schedules, suspensions.
            var isOriginating = FCA_RX.noticeOfAppeal.test(t) || FCA_RX.noticeOfApplication.test(t);
            if (!evType && court && FCA_RX.suspension.test(t)) evType = 'suspension';
            if (!evType && court && !FCA_RX.hearingOrder.test(t) && !FCA_RX.statusReview.test(t) &&
                !FCA_RX.finalDecision.test(t) && FCA_RX.schedule.test(t)) evType = 'schedule';
            if (!evType && !isOriginating && FCA_RX.extension.test(t)) evType = 'extension';
            if (evType && it.d) {
                var ev = { date: it.d, type: evType, steps: evType === 'suspension' ? null : stepTargets(t, kind) };
                if (evType === 'suspension') ev.explicit = FCA_RX.suspension.test(t);   // says so, not just a Rule 74 review
                m.time_events.push(ev);
            }
            it.step = isStepFiling && !FCA_RX.noticeOfAppeal.test(t) && !FCA_RX.noticeOfApplication.test(t);
        });

        // r.307 runs from service of the applicant's affidavits: a respondent's affidavit served
        // before them (e.g. on an earlier motion) is not the r.307 step.
        if (respAffItems.length) {
            var after = m.applicant_affidavits.found
                ? respAffItems.filter(function (x) { return x.d >= m.applicant_affidavits.date; })[0] : null;
            var ra = after || respAffItems[0];
            m.respondent_affidavits = { found: true, date: ra.d, served: serviceDateIn(ra.t) };
        }

        // A Rule 74 review is over once a party takes a further step after it.
        if (m.r74_review.status === 'pending' && items.some(function (x) { return x.step && x.d > m.r74_review.date; })) {
            m.r74_review.status = 'concluded';
        }
        if (m.outcome.status) m.r74_review.status = m.r74_review.status && 'concluded';

        var lastStep = items.filter(function (x) { return x.step; }).map(function (x) { return x.d; }).sort().pop() || null;
        m.time_events.forEach(function (ev) {
            if (ev.type === 'suspension') ev.active = !lastStep || ev.date >= lastStep;
        });
        if (m.r74_review.status === 'concluded') {
            m.time_events.forEach(function (ev) { if (ev.type === 'suspension' && ev.date <= m.r74_review.date) ev.active = false; });
        }

        if (openMotions.length) m.motion.status = openMotions.some(function (x) { return x.responded; }) ? 'decision_pending' : 'filed_no_response';
        else if (anyMotion)     m.motion.status = 'decided_or_abandoned';
        return m;
    }

    // Dispatch: 'aljr' (or no kind) → the Federal Court detector, unchanged.
    function detectMilestones(entries, kind) {
        if (kind === 'appeal' || kind === 'fca_application') return detectFcaMilestones(entries, kind);
        if (kind === 'other') return { kind: 'other' };
        var m = detectMilestonesRegex(entries);
        m.kind = 'aljr';
        return m;
    }

    // ── FCA deadlines ─────────────────────────────────────────────────────────────
    //
    // Each due date is null or { date: Date (UTC), est: bool, extended: bool, rule }.
    //   est:      the period runs from service and only the filing date is known
    //             (or, for the applicant's record, cross-examination completion is unknown).
    //   extended: a consent, order or direction about time touches this step — the
    //             Rules' period no longer applies, so no date is computed.
    // Periods: Federal Courts Rules — see the notes on each line.

    function isoDay(d) { return d.toISOString().split('T')[0]; }
    function minDate(a, b) { return !a ? b : !b ? a : (a < b ? a : b); }

    function stepExtended(m, step, triggerDate) {
        return (m.time_events || []).some(function (ev) {
            if (!ev || !ev.date) return false;
            var st = m[step];
            if (st && st.found && st.date && st.date < ev.date) return false;
            if (ev.steps && ev.steps.length) return ev.steps.indexOf(step) !== -1;
            if (ev.type === 'extension') return true;
            return !triggerDate || ev.date >= triggerDate;
        });
    }

    // start: YYYY-MM-DD. Returns { date, nominal, est, extended, rule } or null.
    function fcaDue(m, step, start, days, est, rule, trigger) {
        if (!start) return null;
        if (stepExtended(m, step, trigger || start)) return { date: null, nominal: null, est: !!est, extended: true, rule: rule };
        var nominal = addDays(start, days);
        return { date: rollToBusinessDay(new Date(nominal.getTime())), nominal: nominal, est: !!est, extended: false, rule: rule };
    }

    function fcaGate(m) {
        if ((m.outcome && m.outcome.status) || (m.discontinued && m.discontinued.found)) return 'closed';
        if ((m.r74_review && m.r74_review.status === 'pending') ||
            (m.time_events || []).some(function (ev) { return ev.type === 'suspension' && ev.active; })) return 'suspended';
        if (m.status_review && m.status_review.status === 'issued') return 'status_review';
        if (m.status_review && m.status_review.status === 'responded') return 'status_review';
        return null;
    }

    function computeAppealDeadlines(m) {
        var out = { appearanceDue: null, agreementDue: null, abMotionDue: null, appealBookDue: null,
                    appellantMemoDue: null, respondentMemoDue: null, crossMemoDue: null,
                    requisitionDue: null, statusReviewDue: null, gate: fcaGate(m) };
        if (out.gate === 'closed' || out.gate === 'suspended') return out;
        if (m.status_review && m.status_review.status === 'issued' && m.status_review.date) {
            // r.382.3(1)/(2): representations within 30 days after issuance of the notice.
            out.statusReviewDue = fcaDue(m, 'status_review_reps', m.status_review.date, 30, false, 'r.382.3');
        }
        if (out.gate === 'status_review') return out;

        var noa = m.notice_of_appeal || {}, later;
        function f(k) { return m[k] && m[k].found; }
        var afterHearing = f('hearing_scheduled') || f('heard');
        if (!noa.found || !noa.date || afterHearing) return out;

        // r.341(1): appearance or cross-appeal within 10 days after service of the notice of appeal.
        later = f('appearance') || f('cross_appeal') || f('ab_agreement') || f('appeal_book') || f('appellant_memo') || f('respondent_memo') || f('requisition');
        if (!later) out.appearanceDue = fcaDue(m, 'appearance', noa.served || noa.date, 10, !noa.served, 'r.341(1)');

        // r.343(1): agreement on the appeal book within 30 days after filing the notice of appeal;
        // r.343(3): failing agreement, the appellant's motion within 10 days after that period expires.
        later = f('ab_agreement') || f('appeal_book') || f('appellant_memo') || f('respondent_memo') || f('requisition');
        if (!later) {
            out.agreementDue = fcaDue(m, 'ab_agreement', noa.date, 30, false, 'r.343(1)');
            if (out.agreementDue && !out.agreementDue.extended && !f('ab_content_motion')) {
                var ab = fcaDue(m, 'ab_agreement', isoDay(out.agreementDue.nominal), 10, false, 'r.343(3)');
                out.abMotionDue = ab;
            }
        }

        // r.345(1): appeal book within 30 days after the agreement is filed (or the r.343(3) order).
        later = f('appeal_book') || f('appellant_memo') || f('respondent_memo') || f('requisition');
        if (!later && f('ab_agreement')) out.appealBookDue = fcaDue(m, 'appeal_book', m.ab_agreement.date, 30, false, 'r.345(1)');

        // r.346(1): appellant's memorandum within 30 days after filing the appeal book.
        later = f('appellant_memo') || f('respondent_memo') || f('requisition');
        if (!later && f('appeal_book')) out.appellantMemoDue = fcaDue(m, 'appellant_memo', m.appeal_book.date, 30, false, 'r.346(1)');

        // r.346(2): respondent's memorandum within 30 days after service of the appellant's.
        var am = m.appellant_memo || {}, respDue = null;
        if (am.found && am.date) respDue = fcaDue(m, 'respondent_memo', am.served || am.date, 30, !am.served, 'r.346(2)');
        if (!f('respondent_memo') && !f('requisition')) out.respondentMemoDue = respDue;

        var rm = m.respondent_memo || {};
        if (f('cross_appeal')) {
            // r.346(3)(b): appellant's memorandum as respondent to the cross-appeal, within 30 days
            // after service of the respondent's memorandum. The requisition date is left out when
            // there is a cross-appeal (see the notes: r.347 does not say how the two interact).
            if (rm.found && rm.date && !f('cross_reply_memo') && !f('requisition')) {
                out.crossMemoDue = fcaDue(m, 'cross_reply_memo', rm.served || rm.date, 30, !rm.served, 'r.346(3)(b)');
            }
        } else if (!f('requisition')) {
            // r.347(1): requisition within 20 days after service of the respondent's memorandum or
            // 20 days after the time for serving it expires, whichever is earlier.
            var fromService = (rm.found && rm.date) ? fcaDue(m, 'requisition', rm.served || rm.date, 20, !rm.served, 'r.347(1)') : null;
            var fromExpiry  = (respDue && !respDue.extended) ? fcaDue(m, 'requisition', isoDay(respDue.nominal), 20, respDue.est, 'r.347(1)') : null;
            if (fromService && fromService.extended) out.requisitionDue = fromService;
            else if (fromService && fromExpiry && !fromExpiry.extended) {
                out.requisitionDue = fromExpiry.date < fromService.date ? fromExpiry : fromService;
            } else if (fromService) out.requisitionDue = fromService;
            else if (respDue && respDue.extended) out.requisitionDue = { date: null, nominal: null, est: respDue.est, extended: true, rule: 'r.347(1)' };
            else out.requisitionDue = fromExpiry;
            if (out.requisitionDue) out.requisitionDue.pendingExpiry = !(rm.found);
        }
        return out;
    }

    function computeApplicationDeadlines(m) {
        var out = { appearanceDue: null, applicantAffidavitsDue: null, applicantRecordDue: null,
                    respondentRecordDue: null, requisitionDue: null, statusReviewDue: null, gate: fcaGate(m) };
        if (out.gate === 'closed' || out.gate === 'suspended') return out;
        if (m.status_review && m.status_review.status === 'issued' && m.status_review.date) {
            out.statusReviewDue = fcaDue(m, 'status_review_reps', m.status_review.date, 30, false, 'r.382.3');
        }
        if (out.gate === 'status_review') return out;

        var noa = m.notice_of_application || {};
        function f(k) { return m[k] && m[k].found; }
        if (!noa.found || !noa.date || f('hearing_scheduled') || f('heard')) return out;
        var later;

        // r.305: notice of appearance within 10 days after service of the notice of application.
        later = f('appearance') || f('applicant_affidavits') || f('respondent_affidavits') || f('applicant_record') || f('respondent_record') || f('requisition');
        if (!later) out.appearanceDue = fcaDue(m, 'appearance', noa.served || noa.date, 10, !noa.served, 'r.305');

        // r.306: applicant's affidavits served (proof filed) within 30 days after issuance.
        later = f('applicant_affidavits') || f('respondent_affidavits') || f('applicant_record') || f('respondent_record') || f('requisition');
        if (!later) out.applicantAffidavitsDue = fcaDue(m, 'applicant_affidavits', noa.date, 30, false, 'r.306');

        // r.307 → r.308 → r.309: respondent's affidavits within 30 days after service of the
        // applicant's; cross-examinations within 20 days after the respondent's affidavits are
        // filed or that time expires (earlier); applicant's record within 20 days after
        // cross-examinations end or that time expires (earlier). Completion of cross-examinations
        // is not on the docket, so this date is always an estimate (the true one can be earlier).
        later = f('applicant_record') || f('respondent_record') || f('requisition');
        if (!later && (f('applicant_affidavits') || f('respondent_affidavits'))) {
            var aa = m.applicant_affidavits || {}, ra = m.respondent_affidavits || {};
            var expiry307 = null, extended = false;
            if (aa.found && aa.date) {
                if (!ra.found && stepExtended(m, 'respondent_affidavits', aa.served || aa.date)) extended = true;
                else expiry307 = isoDay(addDays(aa.served || aa.date, 30));
            }
            var start308 = minDate(ra.found ? ra.date : null, expiry307);
            if (extended && !ra.found) out.applicantRecordDue = { date: null, nominal: null, est: true, extended: true, rule: 'r.309(1)' };
            else if (start308) {
                var end308 = isoDay(addDays(start308, 20));
                out.applicantRecordDue = fcaDue(m, 'applicant_record', end308, 20, true, 'r.309(1)',
                                                aa.found ? (aa.served || aa.date) : ra.date);
            }
        }

        // r.310(1): respondent's record within 20 days after service of the applicant's record.
        var ar = m.applicant_record || {}, respDue = null;
        if (ar.found && ar.date) respDue = fcaDue(m, 'respondent_record', ar.served || ar.date, 20, !ar.served, 'r.310(1)');
        if (!f('respondent_record') && !f('requisition')) out.respondentRecordDue = respDue;

        // r.314(1): requisition within 10 days after service of the respondent's record or the
        // expiry of the time for doing so, whichever is earlier.
        if (!f('requisition')) {
            var rr = m.respondent_record || {};
            var fromService = (rr.found && rr.date) ? fcaDue(m, 'requisition', rr.served || rr.date, 10, !rr.served, 'r.314(1)') : null;
            var fromExpiry  = (respDue && !respDue.extended) ? fcaDue(m, 'requisition', isoDay(respDue.nominal), 10, respDue.est, 'r.314(1)') : null;
            if (fromService && fromService.extended) out.requisitionDue = fromService;
            else if (fromService && fromExpiry && !fromExpiry.extended) out.requisitionDue = fromExpiry.date < fromService.date ? fromExpiry : fromService;
            else if (fromService) out.requisitionDue = fromService;
            else if (respDue && respDue.extended) out.requisitionDue = { date: null, nominal: null, est: respDue.est, extended: true, rule: 'r.314(1)' };
            else out.requisitionDue = fromExpiry;
            if (out.requisitionDue) out.requisitionDue.pendingExpiry = !rr.found;
        }
        return out;
    }

    // ── FCA badges ────────────────────────────────────────────────────────────────

    var OUTCOME_TEXT = {
        allowed:             ['ALLOWED', 'green'],
        allowed_in_part:     ['ALLOWED IN PART', 'green'],
        dismissed:           ['DISMISSED', 'red'],
        removed:             ['REMOVED FROM FILE', 'red'],
        struck:              ['STRUCK', 'red'],
        transferred:         ['TRANSFERRED TO FC', 'neutral'],
        dismissed_for_delay: ['DISMISSED FOR DELAY', 'red'],
    };

    function fcaBadges(m, todayStr) {
        var out = [], isAppeal = m.kind === 'appeal';
        var due = isAppeal ? computeAppealDeadlines(m) : computeApplicationDeadlines(m);
        function push(text, tone) { out.push({ text: text, tone: tone }); }
        function ds(s) { return s ? ' ' + String(s).split('T')[0] : ''; }
        function f(k) { return m[k] && m[k].found; }
        function dueBadge(label, d) {
            if (!d) return;
            if (d.extended) { push(label + ' DUE — EXTENDED — SEE DOCKET', 'amber'); return; }
            var iso = isoDay(d.date);
            push(label + ' DUE ' + iso + (d.est ? ' (est.)' : ''), iso < todayStr ? 'red' : 'amber');
        }

        var r74 = m.r74_review && m.r74_review.status === 'pending';
        var explicitHold = (m.time_events || []).some(function (ev) { return ev.type === 'suspension' && ev.active && ev.explicit; });
        if (r74) push('RULE 74 REVIEW' + ds(m.r74_review.date) + (explicitHold ? '' : ' — SEE DOCKET'), 'amber');
        if (due.gate === 'suspended' && (explicitHold || !r74)) push('TIMELINES SUSPENDED — SEE DOCKET', 'amber');
        if (m.status_review && m.status_review.status && due.gate !== 'closed') {
            if (m.status_review.status === 'issued')         push('STATUS REVIEW' + ds(m.status_review.date), 'amber');
            else if (m.status_review.status === 'responded') push('STATUS REVIEW — REPS FILED', 'amber');
        }
        dueBadge('STATUS REVIEW REPS', due.statusReviewDue);

        if (isAppeal) {
            dueBadge('APPEARANCE', due.appearanceDue);
            if (f('cross_appeal')) push('CROSS-APPEAL' + ds(m.cross_appeal.date), 'neutral');
            if (f('ab_agreement')) push((m.ab_agreement.by_order ? 'AB CONTENTS ORDER' : 'AB AGREEMENT FILED') + ds(m.ab_agreement.date), 'green');
            else {
                dueBadge('AB AGREEMENT', due.agreementDue);
                // r.343(3) motion: only once the agreement period has run out
                if (due.abMotionDue && due.agreementDue && !due.agreementDue.extended && isoDay(due.agreementDue.date) < todayStr) dueBadge('AB CONTENTS MOTION', due.abMotionDue);
            }
            if (f('appeal_book')) push('APPEAL BOOK FILED' + ds(m.appeal_book.date), 'green');
            else dueBadge('APPEAL BOOK', due.appealBookDue);
            if (f('appellant_memo')) push('APPELLANT MEMO FILED' + ds(m.appellant_memo.date), 'green');
            else dueBadge('APPELLANT MEMO', due.appellantMemoDue);
            if (f('respondent_memo')) push('RESPONDENT MEMO FILED' + ds(m.respondent_memo.date), 'green');
            else dueBadge('RESPONDENT MEMO', due.respondentMemoDue);
            if (f('cross_reply_memo')) push('CROSS-APPEAL MEMO FILED' + ds(m.cross_reply_memo.date), 'green');
            else dueBadge('CROSS-APPEAL MEMO', due.crossMemoDue);
        } else {
            dueBadge('APPEARANCE', due.appearanceDue);
            if (f('tribunal_record')) push('TRIBUNAL RECORD RECEIVED' + ds(m.tribunal_record.date), 'green');
            if (f('applicant_affidavits')) push('APPLICANT AFFIDAVITS' + ds(m.applicant_affidavits.date), 'green');
            else dueBadge('APPLICANT AFFIDAVITS', due.applicantAffidavitsDue);
            if (f('respondent_affidavits')) push('RESPONDENT AFFIDAVITS' + ds(m.respondent_affidavits.date), 'green');
            if (f('applicant_record')) push('APPLICANT RECORD FILED' + ds(m.applicant_record.date), 'green');
            else dueBadge('APPLICANT RECORD', due.applicantRecordDue);
            if (f('respondent_record')) push('RESPONDENT RECORD FILED' + ds(m.respondent_record.date), 'green');
            else dueBadge('RESPONDENT RECORD', due.respondentRecordDue);
        }
        if (f('requisition')) push('REQUISITION FILED' + ds(m.requisition.date), 'green');
        else if (due.requisitionDue) {
            // Before the respondent's memorandum/record is filed, the requisition period runs
            // from the expiry of the respondent's time: show it only once that time has run out.
            var rq = due.requisitionDue, show = true;
            if (rq.pendingExpiry) {
                var prev = isAppeal ? due.respondentMemoDue : due.respondentRecordDue;
                show = !!(prev && !prev.extended && prev.date && isoDay(prev.date) < todayStr);
            }
            if (show) dueBadge('REQUISITION', rq);
        }

        var closed = due.gate === 'closed';
        if (m.stay && m.stay.status && !closed) {
            var sc = { filed: ['STAY FILED', 'amber'], granted: ['STAY GRANTED', 'green'], dismissed: ['STAY DISMISSED', 'red'] }[m.stay.status];
            if (sc) push(sc[0], sc[1]);
        }
        if (m.motion && m.motion.status && !closed) {
            var mc = { filed_no_response: ['MOTION FILED', 'amber'], decision_pending: ['MOTION PENDING', 'amber'],
                       decided_or_abandoned: ['MOTION DECIDED', 'neutral'] }[m.motion.status];
            if (mc) push(mc[0], mc[1]);
        }

        var noun = isAppeal ? 'APPEAL' : 'JR';
        var oc = m.outcome && m.outcome.status && OUTCOME_TEXT[m.outcome.status];
        if (m.hearing_scheduled && m.hearing_scheduled.found && !f('heard') && !oc && !f('discontinued')) {
            var hs = m.hearing_scheduled;
            var when = [hs.date, hs.time].filter(Boolean).join(' ');
            push('HEARING SCHEDULED' + (when ? ' ' + when : '') + (hs.place ? ' — ' + String(hs.place).toUpperCase() : ''), 'red');
        }
        if (f('heard')) {
            var heard = noun + ' HEARD' + ds(m.heard.date);
            if (oc) push(heard + ' — ' + oc[0] + ds(m.outcome.date), oc[1]);
            else    push(heard, 'neutral');
        } else if (oc) {
            push((m.outcome.status === 'transferred' ? '' : noun + ' ') + oc[0] + ds(m.outcome.date), oc[1]);
        }
        if (f('discontinued')) push('DISCONTINUED' + ds(m.discontinued.date), 'green');
        return out;
    }

    // ── FCA counsel ───────────────────────────────────────────────────────────────

    var GOV_RX = /\bMINIST|ATTORNEY GENERAL|PROCUREUR G|\bAGC\b|\bPGC\b|\bMCI\b|\bMPSEP\b|\bCBSA\b|PUBLIC SAFETY|SOLICITOR GENERAL|\bCROWN\b|\bKING\b|\bQUEEN\b|HIS MAJESTY|HER MAJESTY|SA MAJEST|\bCANADA BORDER|REVENUE AGENCY|\bCANADA\s*\(/;

    function nameTokens(s) {
        return String(s || '').toUpperCase()
            .normalize('NFD').replace(/[̀-ͯ]/g, '')
            .replace(/\((?:THE|LE|LA)\)/g, ' ').replace(/\./g, '').replace(/[^A-Z0-9 ]+/g, ' ')
            .split(/\s+/).filter(function (w) {
                return w.length > 1 && ['THE', 'ET', 'AL', 'OF', 'AND', 'LE', 'LA', 'DE', 'DU', 'DES', 'LES', 'IN', 'RIGHT'].indexOf(w) === -1;
            });
    }

    // Court of Appeal counsel: each party goes to the side of the style of cause
    // ("X v. Y" / "X c. Y") whose names it matches best; government parties left
    // unmatched follow the side the government appears on. Parties matching neither
    // side (typically interveners) are left out. Prefers a party with a solicitor.
    function resolveCounselFCA(parties, styleOfCause, kind) {
        var soc = String(styleOfCause || '');
        var parts = soc.split(/\s(?:v\.?|vs\.?|c\.)\s/);
        if (parts.length < 2) parts = soc.split(/\sV(?:S)?\.?\s/i);
        var left = parts.length > 1 ? parts[0] : soc, right = parts.length > 1 ? parts.slice(1).join(' ') : '';
        var lt = nameTokens(left), rt = nameTokens(right);
        var leftGov = GOV_RX.test(left.toUpperCase()), rightGov = GOV_RX.test(right.toUpperCase());
        var sides = { L: [], R: [] };
        (parties || []).forEach(function (p) {
            var n = String(p.PARTY_NAME || '');
            if (!n || /\*\*DELETED\*\*/.test(n)) return;
            var pt = nameTokens(n);
            if (!pt.length) return;
            function score(toks) { return pt.filter(function (w) { return toks.indexOf(w) !== -1; }).length / pt.length; }
            var sl = score(lt), sr = score(rt), side = null;
            if (sl >= 0.5 && sl > sr) side = 'L';
            else if (sr >= 0.5 && sr > sl) side = 'R';
            else if (GOV_RX.test(n.toUpperCase())) side = (leftGov && !rightGov) ? 'L' : (rightGov && !leftGov) ? 'R' : null;
            else if (sl > 0 && sl > sr) side = 'L';
            else if (sr > 0 && sr > sl) side = 'R';
            if (side) sides[side].push(p);
        });
        function pick(list) {
            var withSol = list.filter(function (p) { return p.SOLCTR_FIRM || (p.SOLCTR_CONTACT && p.SOLCTR_CONTACT.trim() && p.SOLCTR_CONTACT.trim() !== '---'); });
            var p = withSol[0] || list[0];
            return p ? { firm: p.SOLCTR_FIRM || '—', counsel: formatCounsel(p.SOLCTR_CONTACT === '---' ? '' : p.SOLCTR_CONTACT) } : null;
        }
        return {
            applicant:  pick(sides.L),
            respondent: pick(sides.R),
            labels: kind === 'appeal' ? { applicant: 'Appellant', respondent: 'Respondent' }
                                      : { applicant: 'Applicant', respondent: 'Respondent' },
        };
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
        milestoneBadges: milestoneBadges,
        resolveCounsel: resolveCounsel,
        entryDescription: entryDescription,
        // Federal Court of Appeal
        parseCourtNumber: parseCourtNumber,
        proceedingKind: proceedingKind,
        detectMilestones: detectMilestones,
        detectFcaMilestones: detectFcaMilestones,
        emptyFcaMilestones: emptyFcaMilestones,
        parseDocketDate: parseDocketDate,
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
