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
