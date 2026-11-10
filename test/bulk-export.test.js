// Run with: node --test
const test   = require('node:test');
const assert = require('node:assert/strict');
const { sheetNameFor } = require('../public/bulk-export.js');

test('sheetNameFor keeps names valid, unique and clear of the Summary tab', () => {
    const used = {};
    assert.equal(sheetNameFor('IMM-12345-25', used), 'IMM-12345-25');
    assert.equal(sheetNameFor('IMM-12345-25', used), 'IMM-12345-25 (2)');
    assert.equal(sheetNameFor('A/B:C', used), 'A-B-C');
    assert.equal(sheetNameFor('Summary', used), 'Summary (2)');
    assert.ok(sheetNameFor('X'.repeat(40), used).length <= 31);
});

// ── Milestones by proceeding kind ─────────────────────────────────────────────

const { milestonesFor, MILESTONES_UNAVAILABLE } = require('../public/bulk-export.js');
const entry = (no, date, text) => ({ RE_NO: no, DOC_DT: date + 'T00:00:00', RECORDED_ENTRY: text });
const NOA   = entry(1, '2026-01-05', 'Notice of Appeal against a decision of the Federal Court filed on 05-JAN-2026');
const texts = ms => ms.badges.map(b => b.text);

test('milestonesFor skips files of a type with no milestone tracking, even when AI is requested', () => {
    const prelim = { cn: '26-A-29', kind: 'other', entries: [NOA] };
    for (const useAI of [false, true]) {
        const ms = milestonesFor(prelim, useAI, '2026-02-01');
        assert.deepEqual(ms.badges, []);
        assert.equal(ms.unavailable, true);
        assert.equal(ms.note, '');   // not reported as an AI failure
    }
    assert.match(MILESTONES_UNAVAILABLE, /not available/);
});

test('milestonesFor derives the kind from the case data when the record has none', () => {
    const file = { cn: 'A-1-26', caseData: { COURT_NO: 'A-1-26', DIVISION: 'A', ENGLISH_NATURE_DESC: 'Extension of Time - Others' }, entries: [NOA] };
    assert.equal(milestonesFor(file, false, '2026-02-01').unavailable, true);
    file.caseData.ENGLISH_NATURE_DESC = 'Appeal (S.27 - Final) - Immigration';
    const ms = milestonesFor(file, false, '2026-02-01');
    assert.equal(ms.source, 'Keyword');
    assert.ok(texts(ms).some(t => /APPEARANCE DUE/.test(t)), texts(ms).join(' | '));
});

test('milestonesFor: Federal Court files keep the immigration detector; AI is used when present', () => {
    const imm = { cn: 'IMM-1-26', kind: 'aljr', caseData: {}, entries: [entry(1, '2026-01-05', 'Application for leave and for judicial review filed')] };
    assert.equal(milestonesFor(imm, false, '2026-02-01').source, 'Keyword');
    const ai = { kind: 'appeal', notice_of_appeal: { found: true, date: '2026-01-05', served: null } };
    const withAI = milestonesFor({ cn: 'A-1-26', kind: 'appeal', entries: [NOA], ai: ai }, true, '2026-02-01');
    assert.equal(withAI.source, 'AI');
    const failed = milestonesFor({ cn: 'A-1-26', kind: 'appeal', entries: [NOA], aiError: 'rate limited' }, true, '2026-02-01');
    assert.match(failed.note, /AI analysis unavailable \(rate limited\)/);
});
