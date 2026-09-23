// Run with: node --test
const test   = require('node:test');
const assert = require('node:assert/strict');
const core   = require('../public/core.js');

const iso = d => d.toISOString().split('T')[0];

function entry(no, date, text) {
    return { RE_NO: no, DOC_DT: date + 'T00:00:00', RECORDED_ENTRY: text };
}

const PERFECTED = "Applicant's record on behalf of Applicant filed on 01-SEP-2026";

test('rollToBusinessDay skips weekends and FC holidays', () => {
    assert.equal(iso(core.rollToBusinessDay(new Date('2026-09-23'))), '2026-09-23'); // Wed
    assert.equal(iso(core.rollToBusinessDay(new Date('2026-09-26'))), '2026-09-28'); // Sat → Mon
    assert.equal(iso(core.rollToBusinessDay(new Date('2026-09-30'))), '2026-10-01'); // Truth & Reconciliation
    // 2026-12-25 falls within the seasonal recess (Dec 21 – Jan 7), so it rolls all the
    // way past the recess, not just past Christmas/Boxing Day/the weekend.
    assert.equal(iso(core.rollToBusinessDay(new Date('2026-12-25'))), '2027-01-08'); // Fri, first day after recess
});

test('rollToBusinessDay skips the Monday/Tuesday-after-Christmas holidays', () => {
    // 2026-12-28 (Mon after a Friday Christmas) and 2027-12-27/28 (Mon/Tue after a Saturday
    // Christmas) are themselves within the seasonal recess, so exercise FC_HOLIDAYS directly.
    assert.ok(core.FC_HOLIDAYS.has('2026-12-28'));
    assert.ok(core.FC_HOLIDAYS.has('2027-12-27'));
    assert.ok(core.FC_HOLIDAYS.has('2027-12-28'));
});

test('isSeasonalRecess covers Dec 21 – Jan 7 across the year boundary', () => {
    assert.equal(core.isSeasonalRecess(new Date('2026-12-20')), false);
    assert.equal(core.isSeasonalRecess(new Date('2026-12-21')), true);
    assert.equal(core.isSeasonalRecess(new Date('2026-12-31')), true);
    assert.equal(core.isSeasonalRecess(new Date('2027-01-01')), true);
    assert.equal(core.isSeasonalRecess(new Date('2027-01-07')), true);
    assert.equal(core.isSeasonalRecess(new Date('2027-01-08')), false);
});

test('RMOA due 30 days after perfection, rolled forward', () => {
    const m = core.detectMilestonesRegex([entry(1, '2026-08-08', PERFECTED)]);
    assert.equal(m.perfected.date, '2026-08-08');
    // 2026-09-07 is Labour Day → Tuesday 2026-09-08
    assert.equal(iso(core.computeDeadlines(m).rmoaDue), '2026-09-08');
});

test('no RMOA deadline once RMOA is filed', () => {
    const m = core.detectMilestonesRegex([
        entry(1, '2026-08-08', PERFECTED),
        entry(2, '2026-09-01', 'Memorandum of argument on behalf of the Respondent filed'),
    ]);
    assert.equal(m.rmoa.found, true);
    assert.equal(core.computeDeadlines(m).rmoaDue, null);
});

test('CTR due 21 days after production order; cleared once filed', () => {
    const order = entry(1, '2026-09-01', 'Order ... the tribunal shall send certified copies of its record');
    let m = core.detectMilestonesRegex([order]);
    assert.equal(m.ctr.status, 'ordered');
    assert.equal(iso(core.computeDeadlines(m).ctrDue), '2026-09-22');

    m = core.detectMilestonesRegex([order, entry(2, '2026-09-15',
        'Certified copy of the record and audio files sent by RAD pursuant to the order of the Court')]);
    assert.equal(m.ctr.status, 'filed');
    assert.equal(core.computeDeadlines(m).ctrDue, null);
});

test('CTR due rolls past weekends and holidays', () => {
    // 2026-09-09 + 21 = 2026-09-30 (Truth & Reconciliation) → 2026-10-01
    let m = core.detectMilestonesRegex([entry(1, '2026-09-09', 'Production Order issued')]);
    assert.equal(iso(core.computeDeadlines(m).ctrDue), '2026-10-01');
    // 2026-09-05 + 21 = 2026-09-26 (Saturday) → Monday 2026-09-28
    m = core.detectMilestonesRegex([entry(1, '2026-09-05', 'Production Order issued')]);
    assert.equal(iso(core.computeDeadlines(m).ctrDue), '2026-09-28');
});

test('cancelled entries are ignored', () => {
    const m = core.detectMilestonesRegex([entry(1, '2026-08-08', '*** CANCELLED ' + PERFECTED)]);
    assert.equal(m.perfected.found, false);
});

test('JR scheduled, new 2026 format', () => {
    const m = core.detectMilestonesRegex([entry(1, '2026-09-01',
        'Result - Leave granted, Judicial Review scheduled at Toronto on Tuesday, November 17, 2026, to commence at 9:30 a.m.')]);
    assert.equal(m.jr_scheduled.found, true);
    assert.equal(m.jr_scheduled.datetime, 'Tuesday, November 17, 2026 9:30 a.m.');
});

test('formatCounsel and fmtDate', () => {
    assert.equal(core.formatCounsel('SMITH, JANE'), 'Jane Smith');
    assert.equal(core.formatCounsel(''), '—');
    assert.equal(core.fmtDate('2026-09-23T00:00:00'), '2026-09-23');
    assert.equal(core.fmtDate('/Date(1790121600000)/'), '2026-09-23');
});

test('formatCounsel handles accented names', () => {
    assert.equal(core.formatCounsel('BÉLANGER, MARIE-ÈVE'), 'Marie-Ève Bélanger');
});

test('RMOA deadline skips the seasonal recess (FC Rules r.6(3))', () => {
    const m = core.detectMilestonesRegex([entry(1, '2026-12-10', PERFECTED)]);
    // 30 days from 2026-12-10, not counting Dec 21 – Jan 7, rolled to a business day.
    assert.equal(iso(core.computeDeadlines(m).rmoaDue), '2027-01-27');
});

test('leave-dismissed regex requires "dismissing the application for leave", not just nearby words', () => {
    // A stay motion dismissal that merely mentions "application for leave" in passing
    // must not be mistaken for a leave dismissal.
    const m = core.detectMilestonesRegex([entry(1, '2026-01-01',
        'Order rendered dismissing the motion for a stay of removal pending the ' +
        'determination of the application for leave and for judicial review')]);
    assert.equal(m.leave_dismissed.found, false);
});

test('a leave-dismissal entry with (Final Decision) does not also mark JR as heard', () => {
    const m = core.detectMilestonesRegex([entry(1, '2026-01-01',
        'Order rendered dismissing the application for leave and for judicial review (Final Decision)')]);
    assert.equal(m.leave_dismissed.found, true);
    assert.equal(m.jr_heard.found, false);
});

test('a new motion after a prior one was decided is picked up again', () => {
    const m = core.detectMilestonesRegex([
        entry(1, '2026-01-01', 'Notice of motion filed'),
        entry(2, '2026-01-05', 'Order rendered dismissing the motion'),
        entry(3, '2026-02-01', 'Notice of motion filed'),
    ]);
    assert.equal(m.motion.status, 'filed_no_response');
});

test('a new stay motion after a prior one was dismissed is picked up again', () => {
    const m = core.detectMilestonesRegex([
        entry(1, '2026-01-01', 'Notice of motion for a stay of removal filed'),
        entry(2, '2026-01-05', 'Order rendered dismissing the motion for a stay of removal'),
        entry(3, '2026-02-01', 'Notice of motion for a stay of removal filed'),
    ]);
    assert.equal(m.stay.status, 'filed');
});

test('a notice of discontinuance clears WITH COURT', () => {
    const m = core.detectMilestonesRegex([
        entry(1, '2026-01-01', 'Communication to the Court from the Registry - leave disposition'),
        entry(2, '2026-01-05', 'Notice of discontinuance filed'),
    ]);
    assert.equal(m.pending_leave.found, false);
    assert.equal(m.discontinued.found, true);
});
