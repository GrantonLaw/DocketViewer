// Worker request contract: court numbers, party-search court, milestone kinds.
// Run with: node --test   (fetch to the Court and to the model is stubbed)
const test   = require('node:test');
const assert = require('node:assert/strict');

const ORIGIN = 'https://docketviewer.test';
const env = { ALLOWED_ORIGINS: ORIGIN, GEMINI_API_KEY: 'test-key' };
let ipCounter = 0;

// Calls the Worker with a stubbed fetch; returns { status, body, calls }.
async function call(query, { method = 'GET', body, reply } = {}) {
    const worker = (await import('../worker.js')).default;
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        if (typeof reply === 'function') return reply(String(url), init);
        return new Response('{"Count":0,"data":[]}', { status: 200 });
    };
    try {
        const req = new Request('https://worker.test/?' + query, {
            method,
            headers: { Origin: ORIGIN, 'CF-Connecting-IP': '10.0.0.' + (++ipCounter), 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const res = await worker.fetch(req, env);
        return { status: res.status, body: await res.json(), calls };
    } finally {
        globalThis.fetch = realFetch;
    }
}

function modelReply(json) {
    return () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }] }), { status: 200 });
}

test('court numbers: FC, FCA and FCA preliminary forms go to the right division', async () => {
    let r = await call('type=case&courtnumber=IMM-12345-25');
    assert.equal(r.status, 200);
    assert.match(r.calls[0].url, /proceedingQueriesCourtNumberList\?division=t&courtnumber=IMM-12345-25$/);
    r = await call('type=re&courtnumber=a-100-24');
    assert.match(r.calls[0].url, /proceedingQueriesRE\?division=a&courtnumber=A-100-24$/);
    r = await call('type=case&courtnumber=26-A-29');
    assert.match(r.calls[0].url, /division=a&courtnumber=26-A-29$/);
    r = await call('type=parties&courtnumber=26-A-29');
    assert.match(r.calls[0].url, /PublicPartiesListInfo\?courtnumber=26-A-29$/);
    for (const bad of ['A-100', '2026-A-29', 'IMM 1 25', '']) {
        r = await call('type=case&courtnumber=' + encodeURIComponent(bad));
        assert.equal(r.status, 400, bad);
        assert.equal(r.calls.length, 0);
    }
});

test('party search: court=fc (default) or fca selects the division; anything else is rejected', async () => {
    let r = await call('type=soc&q=attorney%20general');
    assert.match(r.calls[0].url, /ProceedingsQueriesPartyInfo\?division=t&name=attorney%20general$/);
    r = await call('type=soc&q=smith&court=FCA');
    assert.match(r.calls[0].url, /division=a&name=smith$/);
    r = await call('type=soc&q=smith&court=fc');
    assert.match(r.calls[0].url, /division=t&name=smith$/);
    r = await call('type=soc&q=smith&court=tcc');
    assert.equal(r.status, 400);
    assert.equal(r.calls.length, 0);
});

test('milestones: no kind uses the ALJR prompt and returns the model output as before', async () => {
    const out = { perfected: { found: true, date: '2026-01-01' } };
    const r = await call('type=milestones', { method: 'POST', body: { entries: [{ RE_NO: 1, DOC_DT: '2026-01-01T00:00:00', RECORDED_ENTRY: 'x' }] }, reply: modelReply(out) });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, out);
    const prompt = JSON.parse(r.calls[0].init.body).contents[0].parts[0].text;
    assert.match(prompt, /application for leave and judicial review \(ALJR\)/);
    // explicit 'aljr' is the same path
    const r2 = await call('type=milestones', { method: 'POST', body: { kind: 'aljr', entries: [] } });
    assert.equal(r2.body.perfected.found, false);
    assert.equal(r2.body.kind, undefined);
});

test('milestones: kind selects the FCA prompts; output is filled to the core schema', async () => {
    const entries = [{ RE_NO: 1, DOC_DT: '2026-06-01T00:00:00', RECORDED_ENTRY: 'Notice of Appeal filed', REGISTRY_NOTES_EXTERNAL: 'note text' }];
    const r = await call('type=milestones', { method: 'POST', body: { kind: 'appeal', entries },
        reply: modelReply({ notice_of_appeal: { found: true, date: '2026-06-01', served: null },
                            time_events: [{ date: null, type: null, steps: null, active: null },
                                          { date: '2026-06-05', type: 'extension', steps: ['ab_agreement'], active: null }] }) });
    assert.equal(r.status, 200);
    const prompt = JSON.parse(r.calls[0].init.body).contents[0].parts[0].text;
    assert.match(prompt, /section 27 of the Federal Courts Act/);
    assert.match(prompt, /Registry notes: note text/);
    assert.equal(r.body.kind, 'appeal');
    assert.equal(r.body.notice_of_appeal.found, true);
    assert.deepEqual(r.body.appeal_book, { found: false, date: null });            // filled in
    assert.deepEqual(r.body.time_events, [{ date: '2026-06-05', type: 'extension', steps: ['ab_agreement'], active: null }]);

    const r2 = await call('type=milestones', { method: 'POST', body: { kind: 'fca_application', entries }, reply: modelReply({}) });
    assert.match(JSON.parse(r2.calls[0].init.body).contents[0].parts[0].text, /section 28 of the Federal Courts Act/);
    assert.equal(r2.body.kind, 'fca_application');
    assert.deepEqual(r2.body.applicant_record, { found: false, date: null, served: null });

    // empty entries: no model call
    const r3 = await call('type=milestones', { method: 'POST', body: { kind: 'appeal', entries: [] } });
    assert.equal(r3.calls.length, 0);
    assert.equal(r3.body.kind, 'appeal');
});

test('milestones: other or unknown kinds are rejected without calling the model', async () => {
    for (const kind of ['other', 'bogus']) {
        const r = await call('type=milestones', { method: 'POST', body: { kind, entries: [{ RE_NO: 1, DOC_DT: '2026-01-01T00:00:00' }] } });
        assert.equal(r.status, 400, kind);
        assert.equal(r.calls.length, 0);
    }
});

test('the FCA empty milestone shape matches core.js', async () => {
    const core = require('../public/core.js');
    for (const kind of ['appeal', 'fca_application']) {
        const r = await call('type=milestones', { method: 'POST', body: { kind, entries: [] } });
        assert.deepEqual(r.body, core.emptyFcaMilestones(kind));
    }
});
