// Federal Court of Appeal: court numbers, proceeding kinds, milestones, deadlines.
// Run with: node --test
const test   = require('node:test');
const assert = require('node:assert/strict');
const core   = require('../public/core.js');

const iso = d => d.toISOString().split('T')[0];

function entry(no, date, text, extra) {
    return Object.assign({ RE_NO: no, DOC_DT: date + 'T00:00:00', RECORDED_ENTRY: text }, extra || {});
}
const appeal = entries => core.detectMilestones(entries, 'appeal');
const app    = entries => core.detectMilestones(entries, 'fca_application');
const texts  = (m, today) => core.milestoneBadges(m, today).map(b => b.text);
const badge  = (m, today, prefix) => core.milestoneBadges(m, today).find(b => b.text.indexOf(prefix) === 0);

const NOA = (no, date) => entry(no, date, 'Notice of Appeal against a decision of the Federal Court filed on ' + date + ' Tariff received');

// ── Court numbers and kinds ───────────────────────────────────────────────────

test('parseCourtNumber accepts FC, FCA and FCA preliminary numbers', () => {
    assert.deepEqual(core.parseCourtNumber(' imm-12345-25 '), { valid: true, court: 'FC', division: 't', normalized: 'IMM-12345-25' });
    assert.deepEqual(core.parseCourtNumber('T-1234-26'),       { valid: true, court: 'FC', division: 't', normalized: 'T-1234-26' });
    assert.deepEqual(core.parseCourtNumber('a-100-24'),        { valid: true, court: 'FCA', division: 'a', normalized: 'A-100-24' });
    assert.deepEqual(core.parseCourtNumber('26-A-29'),         { valid: true, court: 'FCA', division: 'a', normalized: '26-A-29' });
    assert.equal(core.parseCourtNumber('A–100–24').normalized, 'A-100-24');   // en dashes
    ['', 'A-100', 'IMM 12345 25', '2026-A-29', 'A-100-24-1', null].forEach(s =>
        assert.equal(core.parseCourtNumber(s).valid, false, String(s)));
});

test('proceedingKind: FC files stay aljr; FCA appeals, s.28 applications, others', () => {
    assert.equal(core.proceedingKind({ DIVISION: 'T', ENGLISH_NATURE_DESC: 'Imm - Appl. for leave & jud. review' }), 'aljr');
    assert.equal(core.proceedingKind({}), 'aljr');
    const fca = n => core.proceedingKind({ DIVISION: 'A', ENGLISH_PROCEEDING_TYPE: 'Federal Court of Appeal', ENGLISH_NATURE_DESC: n });
    assert.equal(fca('Appeal (S.27 - Final) - Immigration'), 'appeal');
    assert.equal(fca('Appeal (S.27 - Interloc.) - Application for Judicial Review'), 'appeal');
    assert.equal(fca('Appeal from Trial (Final)'), 'appeal');
    assert.equal(fca('Statutory Appeal - Tax Court of Canada'), 'appeal');
    assert.equal(fca('S.28 Others'), 'fca_application');
    assert.equal(fca('Application - s. 28 Federal Court Act'), 'fca_application');
    assert.equal(fca('Appeal Division of the Social Security Tribunal '), 'fca_application');
    assert.equal(fca('Statutory Appeal - Canadian Radio-television and Telecom. Comm.'), 'other');
    assert.equal(core.proceedingKind({ Division: 'A', FRENCH_NATURE_DESC: 'Appel (Art.27 - Finale) - Immigration' }), 'appeal');
    // Preliminary files (extension of time / leave) have no milestones
    assert.equal(core.proceedingKind({ DIVISION: 'A', COURT_NO: '26-A-29', ENGLISH_PROCEEDING_TYPE: 'F.C.A. Preliminary',
                                       ENGLISH_NATURE_DESC: 'Extension of Time - Others' }), 'other');
    assert.equal(core.proceedingKind({ DIVISION: 'A', ENGLISH_PROCEEDING_TYPE: 'F.C.A. Preliminary',
                                       ENGLISH_NATURE_DESC: 'Application - s. 28 Federal Court Act' }), 'other');
    // Division can come from the court number
    assert.equal(core.proceedingKind({ COURT_NO: 'A-1-26', ENGLISH_NATURE_DESC: 'S.28 Others' }), 'fca_application');
});

test('proceedingKind: the originating document settles a miscoded nature', () => {
    const c = { DIVISION: 'A', ENGLISH_NATURE_DESC: 'S.28 Others' };
    assert.equal(core.proceedingKind(c, [NOA(1, '2026-10-01')]), 'appeal');
    assert.equal(core.proceedingKind({ DIVISION: 'A', ENGLISH_NATURE_DESC: 'Appeal (S.27 - Final) - Others' },
        [entry(1, '2026-10-01', 'Notice of application with regard to Judicial Review (s.28) filed on 01-OCT-2026')]), 'fca_application');
    // never turns an 'other' file into one with milestones
    assert.equal(core.proceedingKind({ DIVISION: 'A', ENGLISH_NATURE_DESC: 'Special thing' }, [NOA(1, '2026-10-01')]), 'other');
});

test('detectMilestones dispatches: aljr is the Federal Court detector, unchanged', () => {
    const es = [entry(1, '2026-08-08', "Applicant's record on behalf of Applicant filed on 08-AUG-2026")];
    const m = core.detectMilestones(es, 'aljr');
    assert.equal(m.kind, 'aljr');
    delete m.kind;
    assert.deepEqual(m, core.detectMilestonesRegex(es));
    assert.deepEqual(core.detectMilestones(es), Object.assign(core.detectMilestonesRegex(es), { kind: 'aljr' }));
    assert.deepEqual(core.detectMilestones(es, 'other'), { kind: 'other' });
    assert.deepEqual(core.milestoneBadges({ kind: 'other' }, '2026-09-01'), []);
});

test('parseDocketDate reads English and French docket dates', () => {
    assert.equal(core.parseDocketDate('07-APR-2025'), '2025-04-07');
    assert.equal(core.parseDocketDate('26-FEV-2025'), '2025-02-26');
    assert.equal(core.parseDocketDate('20-AOU-2025'), '2025-08-20');
    assert.equal(core.parseDocketDate('June 24, 2026'), '2026-06-24');
    assert.equal(core.parseDocketDate('2026-10-15'), '2026-10-15');
    assert.equal(core.parseDocketDate('31-XYZ-2025'), null);
});

// ── Appeals: Part 6 deadlines ─────────────────────────────────────────────────

test('appeal: appearance (r.341) and appeal-book agreement (r.343(1)) after the notice of appeal', () => {
    // 2026-06-01 + 30 = 2026-07-01 (Canada Day) → 2026-07-02. Appearance from the filing date: estimate.
    let m = appeal([NOA(1, '2026-06-01')]);
    assert.deepEqual(texts(m, '2026-06-02'), ['APPEARANCE DUE 2026-06-11 (est.)', 'AB AGREEMENT DUE 2026-07-02']);
    // With a certificate of service, the appearance runs from service and is not an estimate.
    m = appeal([NOA(1, '2026-06-01'), entry(2, '2026-06-03', "Solicitor's certificate of service on behalf of Jane Roe " +
        'confirming service of the Notice of Appeal upon Respondent by electronic service on 03-JUN-2026 filed on 03-JUN-2026')]);
    assert.equal(m.notice_of_appeal.served, '2026-06-03');
    assert.equal(texts(m, '2026-06-04')[0], 'APPEARANCE DUE 2026-06-15');   // 06-13 is a Saturday
});

test('appeal: service on the Crown under r.133 is effective at filing, not at the Registry email', () => {
    const m = appeal([NOA(1, '2026-06-01'), entry(2, '2026-06-08',
        'Service Copy on behalf of: Ottawa Registry confirming service of 1 - Notice of Appeal with proof of service on ' +
        'Respondent(s) by e-mail served on 2026-06-08 filed on 2026-06-08', { REGISTRY_NOTES_EXTERNAL: 'Pursuant to Rule 133 of the Federal Courts Rules.' })]);
    assert.equal(m.notice_of_appeal.served, '2026-06-01');
    assert.equal(texts(m, '2026-06-09')[0], 'APPEARANCE DUE 2026-06-11');
});

test('appeal: appeal book (r.345), appellant memo (r.346(1)), respondent memo (r.346(2))', () => {
    const base = [NOA(1, '2026-06-01'),
        entry(2, '2026-06-05', 'Notice of appearance on behalf of Respondent filed on 05-JUN-2026'),
        entry(3, '2026-06-30', 'Agreement - Appeal Book on behalf of all parties filed on 2026-06-30')];
    assert.deepEqual(texts(appeal(base), '2026-07-01'), ['AB AGREEMENT FILED 2026-06-30', 'APPEAL BOOK DUE 2026-07-30']);
    const ab = base.concat(entry(4, '2026-07-30', 'Appeal Book on behalf of: Appellant with proof of service on Respondent(s) filed on 2026-07-30'));
    assert.equal(texts(appeal(ab), '2026-08-01')[2], 'APPELLANT MEMO DUE 2026-08-31');   // 08-29 is a Saturday
    // Respondent's memo runs from service of the appellant's: estimate when only the filing date is known.
    let m = appeal(ab.concat(entry(5, '2026-08-28', 'Memorandum of Fact and Law on behalf of: Appellant filed on 2026-08-28')));
    assert.equal(texts(m, '2026-09-01')[3], 'RESPONDENT MEMO DUE 2026-09-28 (est.)');
    m = appeal(ab.concat(entry(5, '2026-08-28', 'Memorandum of Fact and Law on behalf of: Appellant with proof of service on ' +
        'Respondent(s) served on 2026-08-25 filed on 2026-08-28')));
    assert.equal(texts(m, '2026-09-01')[3], 'RESPONDENT MEMO DUE 2026-09-24');
    assert.equal(badge(m, '2026-09-25', 'RESPONDENT MEMO').tone, 'red');
});

test('appeal: a separate certificate of service (by document number) gives the memo service date', () => {
    const m = appeal([NOA(1, '2026-06-01'),
        entry(16, '2026-09-11', 'Memorandum of fact and law on behalf of the appellant filed on 11-SEP-2026', { DOCNO: 13 }),
        entry(17, '2026-09-11', "Solicitor's certificate of service on behalf of Mona Lee confirming service of Doc 12 and 13 " +
            'upon Respondent by email on 10-SEP-2026 filed on 11-SEP-2026', { DOCNO: 14 })]);
    assert.equal(m.appellant_memo.served, '2026-09-10');
});

test('appeal: requisition (r.347(1)) — earlier of service + 20 and expiry + 20', () => {
    const steps = [NOA(1, '2026-06-01'),
        entry(2, '2026-06-30', 'Agreement - Appeal Book on behalf of all parties filed on 2026-06-30'),
        entry(3, '2026-07-30', 'Appeal Book on behalf of: Appellant filed on 2026-07-30'),
        entry(4, '2026-08-28', 'Memorandum of Fact and Law on behalf of: Appellant with proof of service on Respondent(s) served on 2026-08-25 filed on 2026-08-28')];
    // Respondent's memo not filed: the requisition date shows only once its time (09-24) has run out.
    assert.equal(badge(appeal(steps), '2026-09-20', 'REQUISITION'), undefined);
    assert.equal(badge(appeal(steps), '2026-09-25', 'REQUISITION').text, 'REQUISITION DUE 2026-10-14');
    // On time: 09-24 + 20 = 10-14.
    let m = appeal(steps.concat(entry(5, '2026-09-24', 'Memorandum of Fact and Law on behalf of: Respondent with proof of service on Appellant(s) served on 2026-09-24 filed on 2026-09-24')));
    assert.equal(badge(m, '2026-09-25', 'REQUISITION').text, 'REQUISITION DUE 2026-10-14');
    // Late respondent's memo (10-05): still 20 days after its time expired, not after the late service.
    m = appeal(steps.concat(entry(5, '2026-10-05', 'Memorandum of Fact and Law on behalf of: Respondent with proof of service on Appellant(s) served on 2026-10-05 filed on 2026-10-05')));
    assert.equal(badge(m, '2026-10-06', 'REQUISITION').text, 'REQUISITION DUE 2026-10-14');
    m = appeal(steps.concat(
        entry(5, '2026-09-24', 'Memorandum of Fact and Law on behalf of: Respondent filed on 2026-09-24'),
        entry(6, '2026-10-09', 'Requisition for Hearing - Appeal on behalf of: Appellant filed on 2026-10-09')));
    assert.deepEqual(texts(m, '2026-10-10').slice(-2), ['RESPONDENT MEMO FILED 2026-09-24', 'REQUISITION FILED 2026-10-09']);
});

test('appeal: with a cross-appeal, the appellant\'s cross-appeal memo is due (r.346(3)(b)); no requisition date', () => {
    const m = appeal([NOA(1, '2026-06-01'),
        entry(2, '2026-06-10', 'Notice of cross-appeal on behalf of the respondent against a decision filed on 10-JUN-2026'),
        entry(3, '2026-06-30', 'Agreement as to the content of the Appeal book from the appellant the respondent filed on 30-JUN-2026'),
        entry(4, '2026-07-30', 'Appeal Book consisting of 1 volume(s) prepared by the appellant filed on 30-JUL-2026'),
        entry(5, '2026-08-28', 'Memorandum of fact and law on behalf of the appellant filed on 28-AUG-2026'),
        entry(6, '2026-09-24', 'Memorandum of fact and law on behalf of the respondent filed on 24-SEP-2026'),
        entry(7, '2026-09-24', "Solicitor's certificate of service on behalf of Nick Pope confirming service of the Respondent " +
            'Memorandum of Fact and Law upon Appellant by electronic service on 24-SEP-2026 filed on 24-SEP-2026')]);
    assert.equal(m.cross_appeal.found, true);
    const t = texts(m, '2026-10-30');
    assert.ok(t.includes('CROSS-APPEAL MEMO DUE 2026-10-26'));         // 10-24 is a Saturday
    assert.ok(!t.some(x => /^REQUISITION/.test(x)));
});

test('appeal: the seasonal recess is not counted (r.6(3)), in the Court of Appeal too', () => {
    // 2026-12-10 + 30 days not counting Dec 21 – Jan 7 → 2027-01-27
    assert.equal(texts(appeal([NOA(1, '2026-12-10')]), '2026-12-11')[1], 'AB AGREEMENT DUE 2027-01-27');
});

test('appeal: r.343(3) motion date shows only once the agreement is overdue', () => {
    const m = appeal([NOA(1, '2026-06-01'), entry(2, '2026-06-05', 'Notice of appearance on behalf of Respondent filed on 05-JUN-2026')]);
    assert.deepEqual(texts(m, '2026-07-02'), ['AB AGREEMENT DUE 2026-07-02']);
    // nominal expiry 07-01 + 10 = 07-11 (Saturday) → 07-13
    assert.deepEqual(texts(m, '2026-07-03'), ['AB AGREEMENT DUE 2026-07-02', 'AB CONTENTS MOTION DUE 2026-07-13']);
    assert.equal(badge(m, '2026-07-03', 'AB AGREEMENT').tone, 'red');
});

test('appeal: a consent extending one step marks only that step EXTENDED — SEE DOCKET', () => {
    const steps = [NOA(1, '2026-06-01'),
        entry(2, '2026-06-30', 'Agreement - Appeal Book on behalf of all parties filed on 2026-06-30'),
        entry(3, '2026-07-30', 'Appeal Book on behalf of: Appellant filed on 2026-07-30'),
        entry(4, '2026-08-28', 'Memorandum of fact and law on behalf of the appellant filed on 28-AUG-2026'),
        entry(5, '2026-09-10', "Consent to an extension of time of 15 days for the service and filing of the Respondent's " +
            'Memorandum of Facta and Law on behalf of both parties on consent filed on 10-SEP-2026')];
    const t = texts(appeal(steps), '2026-09-11');
    assert.equal(t[t.length - 1], 'RESPONDENT MEMO DUE — EXTENDED — SEE DOCKET');
    assert.equal(badge(appeal(steps), '2026-09-11', 'RESPONDENT MEMO').tone, 'amber');
    // ...and the requisition, which runs from the (now unknown) expiry, is not shown either
    assert.equal(badge(appeal(steps), '2026-10-30', 'REQUISITION'), undefined);
    // A consent about the agreement does not touch the appeal book that follows it.
    const m = appeal([NOA(1, '2026-06-01'),
        entry(2, '2026-06-25', 'Consent on behalf of: Appellant with consent of the Respondent filed on 2026-06-25',
            { REGISTRY_NOTES_EXTERNAL: 'the parties consent to a 15-day extension of time for the filing of the Appeal Book agreement' }),
        entry(3, '2026-07-10', 'Agreement - Appeal Book on behalf of all parties filed on 2026-07-10')]);
    assert.equal(badge(m, '2026-07-11', 'APPEAL BOOK').text, 'APPEAL BOOK DUE 2026-08-10');   // 08-09 is a Sunday
});

test('appeal: an extension asked for before the step\'s period starts still applies to it', () => {
    const m = appeal([NOA(1, '2026-05-01'),
        entry(2, '2026-06-04', 'Letter from the respondent dated 04-JUN-2026 writing on behalf of the parties concerning the timelines. ' +
            "The parties request that the Court issue an Order extending the timelines for the Appellant's memorandum and the Respondent's Memorandum of Fact and Law"),
        entry(3, '2026-06-05', 'Agreement as to the content of the Appeal book from the appellant filed on 05-JUN-2026'),
        entry(4, '2026-06-24', 'Appeal Book consisting of 2 volume(s) prepared by the appellant filed on 24-JUN-2026')]);
    assert.equal(badge(m, '2026-06-25', 'APPELLANT MEMO').text, 'APPELLANT MEMO DUE — EXTENDED — SEE DOCKET');
});

test('appeal: a Court order fixing a schedule replaces the Rules\' periods', () => {
    const m = appeal([NOA(1, '2026-06-01'),
        entry(2, '2026-06-30', 'Agreement - Appeal Book on behalf of all parties filed on 2026-06-30'),
        entry(3, '2026-07-30', 'Appeal Book on behalf of: Appellant filed on 2026-07-30'),
        entry(4, '2026-08-03', 'Order dated 2026-08-03 rendered by The Honourable Mr. Justice Stratas without personal appearance filed on 2026-08-03',
            { REGISTRY_NOTES_EXTERNAL: '"THIS COURT ORDERS that the filing schedule is as follows: (a) Appellants memorandum – October 19, 2026; (b) Respondents memorandum – November 19, 2026"' })]);
    assert.equal(badge(m, '2026-08-04', 'APPELLANT MEMO').text, 'APPELLANT MEMO DUE — EXTENDED — SEE DOCKET');
    // "without personal appearance" in an order is not about the notice of appearance
    assert.equal(m.time_events[0].steps.indexOf('appearance'), -1);
});

test('appeal: a Rule 74 review suspends the timelines; they do not simply resume afterwards', () => {
    const r74 = entry(2, '2026-06-05', 'Directions of the Court - Written directions dated 2026-06-05 rendered by The Honourable Madam Justice Walker',
        { REGISTRY_NOTES_EXTERNAL: 'Under Rule 74 of the Federal Courts Rules, the Court can direct that a notice of appeal be formally reviewed. The timelines in the appeal are suspended pending the Rule 74 review.' });
    let m = appeal([NOA(1, '2026-06-01'), r74]);
    assert.deepEqual(texts(m, '2026-06-06'), ['RULE 74 REVIEW 2026-06-05', 'TIMELINES SUSPENDED — SEE DOCKET']);
    m = appeal([NOA(1, '2026-06-01'), r74, entry(3, '2026-06-20', 'Directions of the Court - Written directions dated 2026-06-20',
        { REGISTRY_NOTES_EXTERNAL: 'The Court thanks the parties for their submissions on the Rule 74 review. The doomed to fail test is not met.' })]);
    assert.deepEqual(texts(m, '2026-06-21'), ['APPEARANCE DUE — EXTENDED — SEE DOCKET', 'AB AGREEMENT DUE — EXTENDED — SEE DOCKET']);
    // A review that does not say the timelines are suspended: flagged, no dates.
    m = appeal([NOA(1, '2026-06-01'), entry(2, '2026-06-05', 'Copy of Decision placed on file dated 2026-06-05',
        { REGISTRY_NOTES_EXTERNAL: 'The Court asks the parties to provide submissions on whether the notice of appeal should be removed pursuant to Rule 74.' })]);
    assert.deepEqual(texts(m, '2026-06-06'), ['RULE 74 REVIEW 2026-06-05 — SEE DOCKET']);
});

test('appeal: an abeyance order holds the timelines', () => {
    const m = appeal([NOA(1, '2026-04-29'),
        entry(2, '2026-06-10', 'Agreement - Appeal Book on behalf of all parties filed on 2026-06-10'),
        entry(3, '2026-07-16', 'Order dated 2026-07-16 rendered by The Honourable Mr. Justice Heckman without personal appearance filed on 2026-07-16',
            { REGISTRY_NOTES_EXTERNAL: 'THIS COURT ORDERS that: 1. This appeal shall be held in abeyance until the expiration of 30 days following the release of the decision of this Court in A-246-25' })]);
    assert.deepEqual(texts(m, '2026-07-17'), ['TIMELINES SUSPENDED — SEE DOCKET', 'AB AGREEMENT FILED 2026-06-10']);
});

test('status review (r.382.2-382.3): representations due 30 days after the notice', () => {
    const base = [NOA(1, '2026-01-05'), entry(2, '2026-07-06', 'Notice of Status Review dated 2026-07-06 rendered by The Honourable Mr. Justice Laskin issued to: all parties by email filed on 2026-07-06')];
    assert.deepEqual(texts(appeal(base), '2026-07-07'), ['STATUS REVIEW 2026-07-06', 'STATUS REVIEW REPS DUE 2026-08-05']);
    const m = appeal(base.concat(entry(3, '2026-07-20', 'Submissions (status review) on behalf of: Appellant filed on 2026-07-20')));
    assert.deepEqual(texts(m, '2026-07-21'), ['STATUS REVIEW — REPS FILED']);
    // a Registry note that a review "may be issued" is not a notice
    assert.equal(appeal([NOA(1, '2026-01-05'), entry(2, '2026-07-01', 'Communication to Court from Registry dated on 2026-07-01',
        { REGISTRY_NOTES_EXTERNAL: 'Status review may be issued' })]).status_review.status, null);
});

// ── Appeals: who filed, outcomes, hearings, motions ──────────────────────────

test('intervener filings, motion memoranda and an appellant\'s "appearance" are not party steps', () => {
    const m = appeal([NOA(1, '2026-06-01'),
        entry(2, '2026-06-05', 'Notice of Appearance on behalf of: Appellant with proof of service on Respondent(s) served on 2026-06-05 filed on 2026-06-05'),
        entry(3, '2026-09-01', 'Memorandum of Fact and Law on behalf of: Intervenor filed on 2026-09-01'),
        entry(4, '2026-09-02', 'Memorandum of fact and law on behalf of the intervenor (Constitutional Law Initiative) filed on 02-SEP-2026'),
        entry(5, '2026-09-03', "Mémoire de l'intervenant (Barreau du Québec) / Nombre de copies reçu: 1 de la part de la partie intervenante déposé le 03-SEP-2026"),
        entry(6, '2026-09-04', 'Memorandum of fact and law on behalf of the respondent in opposition to Doc 5 filed on 04-SEP-2026'),
        entry(7, '2026-09-05', 'Memorandum of fact and law contained within a Motion Record on behalf of the appellant filed on 05-SEP-2026')]);
    assert.equal(m.appearance.found, false);
    assert.equal(m.appellant_memo.found, false);
    assert.equal(m.respondent_memo.found, false);
});

test('French appeal entries count', () => {
    const m = appeal([
        entry(1, '2026-09-15', "Avis d'appel déposé le 15-SEP-2026 contre la décision rendue le 13-JUN-2026 par la juge Saint-Fleur de la Cour fédérale"),
        entry(2, '2026-09-23', "Avis de comparution de la part de l'intimé déposée le 23-SEP-2026"),
        entry(3, '2026-10-14', "Entente quant au contenu du dossier d'appel de la part des parties déposée le 14-OCT-2026"),
        entry(4, '2026-11-12', "Dossier d'appel comprenant 1 volume(s) de la part de la partie appelante déposé le 12-NOV-2026"),
        entry(5, '2026-12-01', 'Mémoire des faits et du droit de la partie appelante déposé le 01-DEC-2026'),
        entry(6, '2027-01-25', 'Mémoire des faits et du droit de la partie intimée déposé le 25-JAN-2027'),
        entry(7, '2027-02-10', "Demande d'audience - Appel de la part de la partie appelante déposée le 10-FEV-2027"),
        entry(8, '2027-03-01', "Ordonnance (temps et lieu) en date du 01-MAR-2027 rendue par D. Lanteigne, Administratrice judiciaire / fixant Appel qui aura lieu à la séance spéciale à Ottawa le 07-AVR-2027 à 09:30")]);
    ['notice_of_appeal', 'appearance', 'ab_agreement', 'appeal_book', 'appellant_memo', 'respondent_memo', 'requisition'].forEach(k =>
        assert.equal(m[k].found, true, k));
    assert.deepEqual(m.hearing_scheduled, { found: true, date: '2027-04-07', time: '09:30', place: 'Ottawa' });
    assert.equal(texts(m, '2027-03-02').pop(), 'HEARING SCHEDULED 2027-04-07 09:30 — OTTAWA');
});

test('hearing: both order formats, the latest order wins, a motion hearing is not the appeal', () => {
    let m = appeal([NOA(1, '2025-01-06'),
        entry(2, '2025-02-26', 'Order (time and place) dated 26-FEB-2025 rendered by D. Lanteigne, Judicial Administrator \nfixing Appeal to be heard at Special Sitting in Ottawa on 07-APR-2025 to begin at 09:30 Filed on 26-FEB-2025'),
        entry(3, '2026-05-05', 'Order scheduling time and place of hearing dated 2026-05-05 issued by D. Lanteigne, Judicial Administrator . This appeal is set down to be heard in Ottawa, Ontario, beginning at 9:30 a.m., on June 24, 2026, for a duration not to exceed four hours.')]);
    assert.deepEqual(m.hearing_scheduled, { found: true, date: '2026-06-24', time: '9:30 a.m.', place: 'Ottawa, Ontario' });
    m = appeal([NOA(1, '2026-01-06'),
        entry(2, '2026-07-07', 'This matter comes on for Hearing on 2026-07-07 at Ottawa virtual before The Honourable Madam Justice Rochester Before the Court: Motion for a stay of execution Result of Hearing: reserved')]);
    assert.equal(m.heard.found, false);
});

test('outcomes: judgments and final orders only', () => {
    const heard = entry(2, '2025-10-20', 'This matter comes on for hearing on 20-OCT-2025 at Toronto \nBefore the Court: appeal \nResult: reserved');
    let m = appeal([NOA(1, '2024-12-09'), heard, entry(3, '2026-05-11',
        'Judgment (Final) dated 2026-05-11 rendered by The Honourable Madam Justice Goyette with personal appearance regarding doc # 1 - NOTICE OF APPEAL Result - granted issued to: all parties by email filed on 2026-05-11')]);
    assert.deepEqual(core.milestoneBadges(m, '2026-05-12'), [{ text: 'APPEAL HEARD 2025-10-20 — ALLOWED 2026-05-11', tone: 'green' }]);
    m = appeal([NOA(1, '2026-06-24'), entry(2, '2026-06-25',
        'Order (Final) dated 2026-06-25 rendered by The Honourable Mr. Justice Stratas with personal appearance regarding 1 - Notice of Appeal Result - Notice of Appeal removed and Court file close issued to: all parties by email filed on 2026-06-25')]);
    assert.deepEqual(texts(m, '2026-06-26'), ['APPEAL REMOVED FROM FILE 2026-06-25']);
    m = appeal([NOA(1, '2025-10-01'), entry(2, '2025-07-10', 'Copy of Judgment and Reasons dated 10-JUL-2025 rendered by The Honourable Madam Justice Blackhawk Original filed on Court File No. T-1598-24'),
        entry(3, '2026-08-11', 'Order dated 2026-08-11 rendered by The Honourable Madam Justice Rochester without personal appearance regarding doc # 58 - Notice of Motion returnable Result - dismissed filed on 2026-08-11')]);
    assert.equal(m.outcome.status, null);
    m = appeal([NOA(1, '2024-03-14'), entry(2, '2025-06-18', 'Judgment dated 18-JUN-2025 rendered by The Honourable Mr. Justice Boivin \nThe Court\'s decision is with regard to Appeal \nResult: granted in part Filed on 18-JUN-2025 \n(Final decision)')]);
    assert.equal(m.outcome.status, 'allowed_in_part');
    m = appeal([NOA(1, '2025-01-06'), entry(2, '2025-01-22', 'Notice of discontinuance on behalf of the appellant filed on 22-JAN-2025')]);
    assert.deepEqual(texts(m, '2025-01-23'), ['DISCONTINUED 2025-01-22']);
});

test('motions and stays in an appeal', () => {
    const stay = entry(58, '2026-06-19', 'Notice of Motion returnable on behalf of: Appellant for stay of execution of the Appellant\'s removal filed on 2026-06-19');
    let m = appeal([NOA(1, '2026-01-06'), stay]);
    assert.equal(m.stay.status, 'filed');
    m = appeal([NOA(1, '2026-01-06'), stay, entry(79, '2026-08-11', 'Order dated 2026-08-11 rendered by The Honourable Madam Justice Rochester without personal appearance regarding doc # 58 - Notice of Motion returnable Result - dismissed filed on 2026-08-11')]);
    assert.equal(m.stay.status, 'dismissed');
    const mot = entry(12, '2026-03-13', 'Notice of Motion in writing on behalf of: Intervenor filed on 2026-03-13');
    const rec = entry(15, '2026-03-13', 'Motion Record on behalf of: Intervenor containing 12 - Notice of Motion in writing filed on 2026-03-13');
    const resp = entry(26, '2026-03-23', 'Motion Record on behalf of: Respondent in response to 15 - Motion Record filed on 2026-03-23');
    assert.equal(appeal([NOA(1, '2026-01-06'), mot, rec]).motion.status, 'filed_no_response');
    assert.equal(appeal([NOA(1, '2026-01-06'), mot, rec, resp]).motion.status, 'decision_pending');
    // the order names the motion record, not the notice — still that motion
    assert.equal(appeal([NOA(1, '2026-01-06'), mot, rec, resp, entry(40, '2026-04-23',
        'Order dated 2026-04-23 rendered by The Honourable Madam Justice Walker Result - granted regarding with respect to ID 15 filed on 2026-04-23')]).motion.status, 'decided_or_abandoned');
    // an order about something else leaves it pending
    assert.equal(appeal([NOA(1, '2026-01-06'), mot, rec, resp, entry(40, '2026-04-23',
        'Order dated 2026-04-23 regarding ID 38 Result - granted filed on 2026-04-23')]).motion.status, 'decision_pending');
});

test('due badges disappear once the step is filed, at the hearing, on a decision or a discontinuance', () => {
    const base = [NOA(1, '2026-06-01')];
    assert.equal(badge(appeal(base.concat(entry(2, '2026-06-20', 'Agreement - Appeal Book on behalf of all parties filed on 2026-06-20'))), '2026-07-03', 'AB AGREEMENT').text, 'AB AGREEMENT FILED 2026-06-20');
    assert.deepEqual(texts(appeal(base.concat(entry(2, '2026-06-20', 'Notice of discontinuance on behalf of the appellant filed on 20-JUN-2026'))), '2026-07-03'), ['DISCONTINUED 2026-06-20']);
    assert.deepEqual(texts(appeal(base.concat(entry(2, '2026-06-20', 'Order (time and place) dated 20-JUN-2026 fixing Appeal to be heard at Special Sitting in Toronto on 20-OCT-2026 to begin at 09:30'))), '2026-07-03'),
        ['HEARING SCHEDULED 2026-10-20 09:30 — TORONTO']);
});

// ── s.28 applications: Part 5 deadlines ───────────────────────────────────────

const NAPP = (no, date) => entry(no, date, 'Notice of application with regard to Judicial Review (s.28) filed on ' + date);
const APP_AFF = entry(5, '2026-06-26', "Solicitor's certificate of service on behalf of Aditya Ram confirming service of Applicant's Affidavit upon Respondent by email on 26-JUN-2026 filed on 26-JUN-2026");

test('application: appearance (r.305) and applicant\'s affidavits (r.306) after the notice', () => {
    // 2026-06-01 + 30 = 07-01 (Canada Day) → 07-02
    assert.deepEqual(texts(app([NAPP(1, '2026-06-01')]), '2026-06-02'), ['APPEARANCE DUE 2026-06-11 (est.)', 'APPLICANT AFFIDAVITS DUE 2026-07-02']);
    // an affidavit proving service of the notice of application is not the r.306 step
    const m = app([NAPP(1, '2026-06-01'), entry(2, '2026-06-08', 'Affidavit of Aditya Ram on behalf of the applicant sworn on 08-JUN-2026 confirming service of DOC 1 on the respondent by Canada Post Xpresspost on 04-JUN-2026 filed on 08-JUN-2026')]);
    assert.equal(m.applicant_affidavits.found, false);
    assert.equal(m.notice_of_application.served, '2026-06-04');
});

test('application: applicant\'s record (rr.307-309) is always an estimate', () => {
    // affidavits served 06-26 → r.307 expiry 07-26 → r.308 ends 08-15 → record 09-04
    let m = app([NAPP(1, '2026-06-01'), APP_AFF]);
    assert.equal(m.applicant_affidavits.served, '2026-06-26');
    assert.equal(badge(m, '2026-06-27', 'APPLICANT RECORD').text, 'APPLICANT RECORD DUE 2026-09-04 (est.)');
    // respondent's affidavits filed 07-10 → cross-examinations end 07-30 → record 08-19
    m = app([NAPP(1, '2026-06-01'), APP_AFF,
        entry(6, '2026-07-10', "Solicitor's certificate of service on behalf of L. Volinets confirming service of the Respondent's Affidavit upon Applicant by electronic mail on 10-JUL-2026 filed on 10-JUL-2026")]);
    assert.equal(badge(m, '2026-07-11', 'APPLICANT RECORD').text, 'APPLICANT RECORD DUE 2026-08-19 (est.)');
    // a respondent's affidavit served before the applicant's (e.g. on a motion) is not the r.307 step
    m = app([NAPP(1, '2026-06-01'),
        entry(4, '2026-06-20', "Solicitor's Certificate of Service on behalf of: Respondent confirming service of the Respondent's Affidavit served on 2026-06-20 filed on 2026-06-20"),
        APP_AFF,
        entry(6, '2026-07-10', "Solicitor's Certificate of Service on behalf of: Respondent confirming service of the Respondent's Rule 307 Affidavit served on 2026-07-10 filed on 2026-07-10")]);
    assert.equal(m.respondent_affidavits.date, '2026-07-10');
});

test('application: respondent\'s record (r.310) and requisition (r.314)', () => {
    const base = [NAPP(1, '2026-06-01'), APP_AFF,
        entry(7, '2026-08-10', "Applicant's Record / Number of copies received/prepared: 1 on behalf of Applicant / with proof of service upon Respondent on 10-AUG-2026 / filed on 10-AUG-2026")];
    assert.equal(badge(app(base), '2026-08-11', 'RESPONDENT RECORD').text, 'RESPONDENT RECORD DUE 2026-08-31');   // 08-30 is a Sunday
    // respondent's record served 08-28 → 09-07 (Labour Day) → 09-08, earlier than expiry + 10 (09-09)
    const m = app(base.concat(entry(8, '2026-08-28', "Respondent's Record / on behalf of Respondent / with proof of service upon Applicant on 28-AUG-2026 / filed on 28-AUG-2026")));
    assert.equal(badge(m, '2026-08-29', 'REQUISITION').text, 'REQUISITION DUE 2026-09-08');
});

test('application: outcomes, transfer to the Federal Court, French entries', () => {
    let m = app([NAPP(1, '2025-12-22'), entry(15, '2026-02-11', 'Order (Final) dated 2026-02-11 rendered by The Honourable Madam Justice Walker without personal appearance regarding doc # 9 - Letter Result - granted issued to: all parties by email filed on 2026-02-11',
        { REGISTRY_NOTES_EXTERNAL: 'The application for judicial review is transferred to the Federal Court.' })]);
    assert.deepEqual(texts(m, '2026-02-12'), ['TRANSFERRED TO FC 2026-02-11']);
    m = app([NAPP(1, '2025-01-13'),
        entry(21, '2026-02-02', 'This matter comes on for Hearing on 2026-02-02 at Toronto in person Before the Court: Judicial Review Result of Hearing: dismissed'),
        entry(22, '2026-02-02', 'Judgment (Final) dated 2026-02-02 rendered by The Honourable Mr. Justice Webb with personal appearance regarding doc # 1 - NOTICE OF APPLICATION Result - dismissed filed on 2026-02-02')]);
    assert.deepEqual(core.milestoneBadges(m, '2026-02-03'), [{ text: 'JR HEARD 2026-02-02 — DISMISSED 2026-02-02', tone: 'red' }]);
    m = app([entry(1, '2026-10-01', 'Avis de demande concernant contrôle judiciaire (art.28) déposé le 01-OCT-2026'),
        entry(3, '2026-10-03', 'Avis de comparution de la part de la partie intimée / déposée le 03-OCT-2026'),
        entry(7, '2026-11-15', 'Affidavit de Magalie Charlebois-Chauret de la part de la partie demanderesse assermenté le 15-NOV-2026 attestant la signification les affidavits et les pièces de la demanderesse à la partie défenderesse par courriel le 15-NOV-2026 déposé le 15-NOV-2026'),
        entry(9, '2027-03-19', 'Dossier de la partie demanderesse / Nombre de copies reçu/préparé: 1 de la part de la partie demanderesse / déposé le 19-MAR-2027'),
        entry(19, '2027-04-26', 'Avis de désistement au nom de : la partie demanderesse déposé(e)(s) le 2027-04-26')]);
    assert.equal(m.appearance.found, true);
    assert.equal(m.applicant_affidavits.served, '2026-11-15');
    assert.equal(m.applicant_record.found, true);
    assert.equal(m.discontinued.date, '2027-04-26');
});

// ── Counsel, and AI-shaped milestones ─────────────────────────────────────────

test('resolveCounsel for the Court of Appeal: both sides from the style of cause, interveners left out', () => {
    const parties = [
        { PARTY_NAME: 'CANADIAN CIVIL LIBERTIES ASSOCIATION', SOLCTR_FIRM: 'CCLA LLP', SOLCTR_CONTACT: 'SWAISLAND, JACQUELINE' },
        { PARTY_NAME: 'ZAITSEV, IEVGEN', SOLCTR_FIRM: 'Jackman Law', SOLCTR_CONTACT: 'JACKMAN, BARBARA' },
        { PARTY_NAME: 'MINISTER OF CITIZENSHIP AND IMMIGRATION (THE)', SOLCTR_FIRM: 'Attorney General of Canada', SOLCTR_CONTACT: 'Provart, John' },
    ];
    assert.deepEqual(core.resolveCounsel(parties, 'THE MINISTER OF CITIZENSHIP AND IMMIGRATION v. IEVGEN ZAITSEV et al.', 'appeal'), {
        applicant:  { firm: 'Attorney General of Canada', counsel: 'John Provart' },
        respondent: { firm: 'Jackman Law', counsel: 'Barbara Jackman' },
        labels:     { applicant: 'Appellant', respondent: 'Respondent' },
    });
    // abbreviations and initials: "MCI" on the left, "A.F.M.B." on the right
    const r = core.resolveCounsel([
        { PARTY_NAME: 'AFMB ET AL', SOLCTR_FIRM: 'Silcoff', SOLCTR_CONTACT: 'SILCOFF, MAUREEN' },
        { PARTY_NAME: 'MINISTER OF PUBLIC SAFETY AND EMERGENCY PREPAREDNESS', SOLCTR_FIRM: 'DOJ', SOLCTR_CONTACT: 'ROE, RICHARD' },
    ], 'MCI et al. v. A.F.M.B. ET AL', 'fca_application');
    assert.equal(r.applicant.firm, 'DOJ');
    assert.equal(r.respondent.firm, 'Silcoff');
    assert.deepEqual(r.labels, { applicant: 'Applicant', respondent: 'Respondent' });
    // French style of cause
    assert.equal(core.resolveCounsel([{ PARTY_NAME: 'PROCUREUR GÉNÉRAL DU CANADA', SOLCTR_FIRM: 'PGC', SOLCTR_CONTACT: 'GIGUÈRE, PHILIPPE' }],
        'MAGALIE CHARLEBOIS-CHAURET c. PROCUREUR GÉNÉRAL DU CANADA', 'fca_application').respondent.counsel, 'Philippe Giguère');
});

test('resolveCounsel with a Federal Court kind keeps the old result and adds labels', () => {
    const parties = [{ PARTY_NAME: 'JANE DOE', SOLCTR_FIRM: 'Smith LLP', SOLCTR_CONTACT: 'SMITH, JOHN' }];
    assert.deepEqual(core.resolveCounsel(parties, 'JANE DOE v. MCI', 'aljr'), {
        applicant: { firm: 'Smith LLP', counsel: 'John Smith' }, respondent: null,
        labels: { applicant: 'Applicant', respondent: 'Respondent' },
    });
});

test('an AI result in the same schema renders through milestoneBadges', () => {
    const m = core.emptyFcaMilestones('appeal');
    m.notice_of_appeal = { found: true, date: '2026-06-01', served: null };
    m.ab_agreement     = { found: true, date: '2026-06-30', by_order: false };
    assert.deepEqual(texts(m, '2026-07-01'), ['AB AGREEMENT FILED 2026-06-30', 'APPEAL BOOK DUE 2026-07-30']);
    m.time_events = [{ date: '2026-07-05', type: 'suspension', steps: null, active: true }];
    assert.deepEqual(texts(m, '2026-07-06'), ['TIMELINES SUSPENDED — SEE DOCKET', 'AB AGREEMENT FILED 2026-06-30']);
    m.time_events = [{ date: '2026-07-05', type: 'extension', steps: ['appeal_book'], active: null }];
    assert.equal(texts(m, '2026-07-06')[1], 'APPEAL BOOK DUE — EXTENDED — SEE DOCKET');
    assert.deepEqual(core.computeDeadlines(core.emptyFcaMilestones('fca_application')).applicantAffidavitsDue, null);
});

// ── Independent review: fixes found on hold-out dockets ───────────────────────

test('outcome: a final order granting a motion to strike is not "appeal allowed"', () => {
    const order = entry(27, '2023-11-15', 'Order dated 15-NOV-2023 rendered by The Honourable Mr. Justice Webb \nMatter considered without personal appearance \n' +
        "The Court's decision is with regard to the motion / document number 13 \nResult: granted \"THIS COURT ORDERS that the Respondent¿s motion to strike " +
        "the Appellant's notice of appeal is allowed and the Appellant¿s notice of appeal is struck.\" Filed on 15-NOV-2023 \n(Final decision)");
    const m = appeal([NOA(1, '2023-08-08'), order]);
    assert.equal(m.outcome.status, 'struck');
    assert.deepEqual(texts(m, '2023-11-20'), ['APPEAL STRUCK 2023-11-15']);
    // A final motion order whose effect on the appeal cannot be read closes the file without guessing
    const vague = entry(5, '2023-11-15', "Order dated 15-NOV-2023 The Court's decision is with regard to the motion / document number 3 Result: granted (Final decision)");
    const m2 = appeal([NOA(1, '2023-08-08'), vague]);
    assert.equal(m2.outcome.status, 'decided');
    assert.equal(texts(m2, '2023-11-20').some(t => /ALLOWED|DUE/.test(t)), false);
    // Judgments on the appeal itself are unchanged
    const j = entry(9, '2024-06-07', "Judgment dated 07-JUN-2024 The Court's decision is with regard to Appeal Result: granted in part");
    assert.equal(appeal([NOA(1, '2023-03-03'), j]).outcome.status, 'allowed_in_part');
});

test('extension: a consent for "all steps" (even "all steps except ...") touches every step', () => {
    const consent = entry(5, '2023-05-02', "Consentement à prorogation de délai R7,de moitié pour toutes les étapes, sauf la demande d'audience " +
        '(voir document, qui est détaillé par date) de la part de toutes les parties déposé le 02-MAI-2023');
    const m = appeal([NOA(1, '2023-04-06'), entry(3, '2023-04-12', 'Avis de comparution de la part de la partie intimée déposée le 12-AVR-2023'), consent]);
    assert.ok(texts(m, '2023-05-17').includes('AB AGREEMENT DUE — EXTENDED — SEE DOCKET'));
    const en = entry(5, '2026-05-02', 'Consent to an extension of time for all steps on behalf of all parties filed on 2026-05-02');
    assert.ok(texts(appeal([NOA(1, '2026-04-06'), en]), '2026-05-03').includes('AB AGREEMENT DUE — EXTENDED — SEE DOCKET'));
});

test('extension: rules named by number ("rule 307, 308, 309 and 310") reach those steps', () => {
    const es = [
        entry(1, '2023-04-27', 'Notice of application and 2 copies with regard to Judicial Review (s.28) filed on 27-APR-2023'),
        entry(2, '2023-04-28', 'Notice of appearance on behalf of Respondent filed on 28-APR-2023'),
        entry(3, '2023-06-06', "Solicitor's certificate of service on behalf of S. White confirming service of the Applicant's Affidavit as per Rule 306 upon Respondent by electronic service on 06-JUN-2023 filed on 06-JUN-2023"),
        entry(4, '2023-07-11', 'Consent to to an extension of time for the parties to serve and file their rule 307, 308, 309 and 310 in conformity with Rule 7 of the Federal Court Rules. on behalf of the applicant the respondent filed on 11-JUL-2023'),
        entry(5, '2023-07-21', "Affidavit of L. Black on behalf of the respondent sworn on 21-JUL-2023 confirming service of Respondent's Affidavit Rule 307 on the applicant by electronic mail on 21-JUL-2023 filed on 21-JUL-2023"),
    ];
    assert.ok(texts(app(es), '2023-07-22').includes('APPLICANT RECORD DUE — EXTENDED — SEE DOCKET'));
    const more = es.concat([entry(6, '2023-09-19', "Applicant's Record Number of copies received/prepared: 1 on behalf of Applicant filed on 19-SEP-2023")]);
    assert.ok(texts(app(more), '2023-09-20').includes('RESPONDENT RECORD DUE — EXTENDED — SEE DOCKET'));
});

test('discontinuance by some named appellants, followed by further steps, is not of the whole appeal', () => {
    const disc = entry(11, '2023-05-26', 'Notice of discontinuance on behalf of MICHELLE GUY, TREVOR SHEFFEL, LEEANNE JAMES, ELISA HO filed on 26-MAY-2023');
    const m = appeal([NOA(1, '2023-03-03'), entry(9, '2023-05-19', 'Memorandum of fact and law on behalf of Appellants filed on 19-MAY-2023'), disc]);
    assert.equal(m.discontinued.found, false);
    assert.ok(texts(m, '2023-05-27').some(t => t.indexOf('RESPONDENT MEMO DUE') === 0));
    // A plain discontinuance later "undone" by a party step
    const d2 = entry(11, '2023-05-26', 'Notice of discontinuance on behalf of the appellant filed on 26-MAY-2023');
    assert.equal(appeal([NOA(1, '2023-03-03'), d2]).discontinued.found, true);
    assert.equal(appeal([NOA(1, '2023-03-03'), d2,
        entry(12, '2023-06-23', 'Requisition for hearing - Appeal from Appellant filed on 23-JUN-2023')]).discontinued.found, false);
});

test('suspension: a French direction that the appeal "est suspendu" holds the timelines', () => {
    const dir = entry(7, '2026-08-18', 'Directives de la cour - Directives écrites daté(e)(s) du 2026-08-18 rendu(e)(s) par Monsieur le juge LeBlanc reçu(e)(s) le 2026-08-18',
        { REGISTRY_NOTES_EXTERNAL: "Le déroulement du présent appel est suspendu jusquà ce que lordonnance de la Cour nommant un amicus curiae soit émise et que le Procureur général et lamicus curiae proposent à la Cour, conjointement, dans les 15 jours de la date de ladite ordonnance, un calendrier." });
    const m = appeal([entry(1, '2026-07-06', "Avis d'appel contre la décision rendu le 10 juin 2026 déposé(e)(s) le 2026-07-06 frais reçus"), dir]);
    assert.deepEqual(texts(m, '2026-11-10'), ['TIMELINES SUSPENDED — SEE DOCKET']);
});

test('records and service: "Dossier (demande)", "Public Applicant\'s Record", French "signifié(e)(s) le"', () => {
    const NOAP = entry(1, '2023-06-16', 'Avis de demande concernant contrôle judiciaire (art.28) déposé le 16-JUN-2023');
    assert.equal(app([NOAP, entry(13, '2023-10-04', 'Dossier (demande) Nombre de copies reçu/préparé: 0 de la part de la partie demanderesse déposé le 04-OCT-2023')]).applicant_record.found, true);
    assert.equal(app([NOAP, entry(48, '2024-05-09', "Public Applicant's Record + 4 hard copies Number of copies received/prepared: 1 on behalf of Applicant filed on 09-MAY-2024")]).applicant_record.found, true);
    assert.equal(app([NOAP, entry(8, '2023-12-01', 'Dossier (requête) dans lequel se trouve(nt) le(s) document(s) original(aux) suivant(s) : 21 de la part AQAADI déposé le 01-DEC-2023')]).applicant_record.found, false);
    const m = appeal([entry(1, '2026-07-06', "Avis d'appel contre la décision déposé(e)(s) le 2026-07-06 frais reçus"),
        entry(2, '2026-07-07', "Attestation de signification de l'avocat au nom de : la partie appelante confirmant la signification de 1 - Avis d'appel avec preuve de signification à la partie intimé par courriel signifié(e)(s) le 2026-07-07 déposé(e)(s) le 2026-07-07")]);
    assert.equal(m.notice_of_appeal.served, '2026-07-07');
    assert.ok(texts(m, '2026-07-08').includes('APPEARANCE DUE 2026-07-17'));
});
