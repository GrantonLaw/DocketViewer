// Bulk Excel export — builds a workbook with a Summary tab and one tab per
// court file, laid out like the single-file docket page.
//
// DOM-free: takes the ExcelJS module as an argument and relies only on the
// helpers in core.js, so it runs unmodified in the browser and in Node.

(function (root) {
    'use strict';

    var core = (typeof module !== 'undefined' && module.exports) ? require('./core.js') : root;

    // Milestone tones match the badge colours on the page (.s-green etc.)
    var TONE_FILL = { green: 'FF3F7D5C', amber: 'FFC97F17', red: 'FFB23A48', gray: 'FF5B6773', neutral: 'FF3A4653' };
    var BRAND     = 'FF1A5C8A';
    var LABEL_BG  = 'FFF1F4F7';
    var BORDER    = { style: 'thin', color: { argb: 'FFCBD2D9' } };
    var BOX       = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };

    var DISCLAIMER =
        'Court file data reproduced from the Federal Court of Canada — Court Files and Decisions (fct-cf.gc.ca). ' +
        'Automated milestone detection, whether keyword-based or AI-powered (Gemini), is provided for convenience ' +
        'only and may be incomplete, inaccurate, or out of date. It does not constitute legal advice. Verify all ' +
        'procedural milestones and deadlines against the official court record.';

    // Excel sheet names: max 31 chars, none of []:*?/\ , unique, and not "Summary"
    function sheetNameFor(cn, used) {
        var base = String(cn).replace(/[\[\]:*?\/\\]/g, '-').slice(0, 31) || 'File';
        var name = base, n = 2;
        while (used[name.toLowerCase()] || name.toLowerCase() === 'summary') {
            var suffix = ' (' + n++ + ')';
            name = base.slice(0, 31 - suffix.length) + suffix;
        }
        used[name.toLowerCase()] = true;
        return name;
    }

    function internalLink(sheetName) {
        return "#'" + sheetName.replace(/'/g, "''") + "'!A1";
    }

    // Merged and fixed-width cells don't auto-fit, so estimate wrapped height
    function wrappedHeight(text, charsPerLine, lineHeight) {
        var lines = String(text || '').split('\n').reduce(function (sum, line) {
            return sum + Math.max(1, Math.ceil(line.length / charsPerLine));
        }, 0);
        return Math.max(1, lines) * lineHeight;
    }

    // Milestones for one file: AI where requested and available, otherwise
    // keyword detection. Returns { badges, source, note }.
    function milestonesFor(file, useAI, todayStr) {
        if (useAI && file.ai) {
            return { badges: core.milestoneBadges(file.ai, todayStr), source: 'AI', note: '' };
        }
        var regex = core.detectMilestonesRegex(file.entries || []);
        return {
            badges: core.milestoneBadges(regex, todayStr),
            source: 'Keyword',
            note:   useAI ? 'AI analysis unavailable' + (file.aiError ? ' (' + file.aiError + ')' : '') + ' — keyword milestones shown' : '',
        };
    }

    function caseFields(c) {
        return {
            styleOfCause: c.STYLE_OF_CAUSE || '—',
            courtNo:      c.COURT_NO || '—',
            nature:       c.ENGLISH_NATURE_DESC || '—',
            office:       c.ENGLISH_CITY_NAME || c.ENGLISH_OFFICE_NAME || '—',
            filed:        core.fmtDate(c.FILE_DT || c.FILING_DATE),
            track:        c.ENGLISH_TRACK_NAME || c.ENGLISH_PROCEEDING_TYPE || '—',
        };
    }

    function backLink(ws) {
        var cell = ws.getCell('A1');
        cell.value = { text: '← Summary', hyperlink: internalLink('Summary') };
        cell.font  = { color: { argb: BRAND }, underline: true, size: 9 };
    }

    // Label in A:B, value in C:D
    function detailRow(ws, label, value, opts) {
        opts = opts || {};
        var row = ws.addRow([]);
        var r   = row.number;
        ws.mergeCells('A' + r + ':B' + r);
        ws.mergeCells('C' + r + ':D' + r);

        var lc = ws.getCell('A' + r);
        lc.value     = label || '';
        lc.font      = { bold: true, size: 9, color: { argb: 'FF5B6773' } };
        lc.alignment = { vertical: 'top' };
        if (label) lc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LABEL_BG } };

        var vc = ws.getCell('C' + r);
        vc.value     = value;
        vc.alignment = { vertical: 'top', wrapText: true };
        vc.font      = opts.font || { size: 10 };
        if (opts.fill) vc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.fill } };

        var text = (value && value.text) || value || '';
        if (String(text).length > 110 || String(text).indexOf('\n') !== -1) row.height = wrappedHeight(text, 110, 14);
        return row;
    }

    function setupFileSheet(ws) {
        ws.columns = [
            { key: 'no',   width: 8 },
            { key: 'date', width: 13 },
            { key: 'off',  width: 16 },
            { key: 'desc', width: 100 },
        ];
        ws.views     = [{ showGridLines: false }];
        ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
                         margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 } };
    }

    function titleRow(ws, text) {
        var row = ws.addRow([text]);
        ws.mergeCells('A' + row.number + ':D' + row.number);
        row.getCell(1).font      = { bold: true, size: 14, color: { argb: 'FF0E2336' } };
        row.getCell(1).alignment = { vertical: 'middle', wrapText: true };
        row.height = Math.max(24, wrappedHeight(text, 85, 20));
    }

    function addFileSheet(ws, file, opts) {
        setupFileSheet(ws);
        backLink(ws);
        ws.addRow([]);

        var f = caseFields(file.caseData);
        titleRow(ws, f.styleOfCause);
        ws.addRow([]);

        var docketUrl = opts.siteUrl ? opts.siteUrl + '?' + encodeURIComponent(file.cn) : null;
        detailRow(ws, 'Court File', docketUrl ? { text: f.courtNo, hyperlink: docketUrl } : f.courtNo,
                  docketUrl ? { font: { size: 10, color: { argb: BRAND }, underline: true } } : null);
        detailRow(ws, 'Nature of Proceeding', f.nature);
        detailRow(ws, 'Office',               f.office);
        detailRow(ws, 'Date Filed',           f.filed);
        detailRow(ws, 'Track',                f.track);

        var counsel = core.resolveCounsel(file.parties, f.styleOfCause);
        ws.addRow([]);
        detailRow(ws, 'Firm (Applicant)',    counsel.applicant ? counsel.applicant.firm    : '—');
        detailRow(ws, 'Counsel (Applicant)', counsel.applicant ? counsel.applicant.counsel : '—');
        if (counsel.respondent) {
            detailRow(ws, 'Firm (Respondent)',    counsel.respondent.firm);
            detailRow(ws, 'Counsel (Respondent)', counsel.respondent.counsel);
        }

        var ms = milestonesFor(file, opts.useAI, opts.todayStr);
        ws.addRow([]);
        var msLabel = ms.source === 'AI' ? 'Milestones (AI)' : 'Milestones';
        var first   = true;
        if (ms.note) {
            detailRow(ws, msLabel, ms.note, { font: { size: 9, italic: true, color: { argb: 'FF7A8694' } } });
            first = false;
        }
        if (!ms.badges.length) {
            detailRow(ws, first ? msLabel : '', 'No milestones detected yet',
                      { font: { size: 10, italic: true, color: { argb: 'FF7A8694' } } });
        }
        ms.badges.forEach(function (b) {
            detailRow(ws, first ? msLabel : '', b.text, {
                fill: TONE_FILL[b.tone] || TONE_FILL.neutral,
                font: { size: 10, bold: true, color: { argb: 'FFFFFFFF' } },
            });
            first = false;
        });

        // Recorded entries — newest first, as the page shows them
        var entries = (file.entries || []).slice().sort(function (a, b) { return b.RE_NO - a.RE_NO; });
        ws.addRow([]);
        var heading = ws.addRow(['Recorded Entries (' + entries.length + ')']);
        heading.getCell(1).font = { bold: true, size: 11, color: { argb: 'FF0E2336' } };

        var head = ws.addRow(['#', 'Date', 'Office', 'Description']);
        head.eachCell(function (cell) {
            cell.font   = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
            cell.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
            cell.border = BOX;
        });

        entries.forEach(function (e, i) {
            var desc = core.entryDescription(e);
            var row  = ws.addRow([e.RE_NO, (e.DOC_DT || '').split('T')[0], e.ENGLISH_OFFICE_NAME || '—', desc]);
            row.eachCell({ includeEmpty: true }, function (cell, col) {
                cell.border    = BOX;
                cell.font      = { size: 9 };
                cell.alignment = { vertical: 'top', wrapText: col === 4, horizontal: col === 1 ? 'left' : undefined };
                if (i % 2) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF6F8FA' } };
            });
            row.height = wrappedHeight(desc, 115, 12.5);
        });

        // Repeat the entries header on every printed page
        ws.pageSetup.printTitlesRow = head.number + ':' + head.number;
        return ms;
    }

    function addErrorSheet(ws, file, opts) {
        setupFileSheet(ws);
        backLink(ws);
        ws.properties.tabColor = { argb: TONE_FILL.red };
        ws.addRow([]);
        titleRow(ws, file.cn);
        ws.addRow([]);

        var notFound = file.status === 'notfound';
        detailRow(ws, 'Court File', file.cn);
        detailRow(ws, 'Status', notFound ? 'Not found' : 'Could not be retrieved',
                  { fill: TONE_FILL.red, font: { size: 10, bold: true, color: { argb: 'FFFFFFFF' } } });
        detailRow(ws, 'Detail', notFound
            ? 'No court file matching this number was found on the Federal Court docket. Check the number for typos.'
            : 'The Federal Court server did not respond for this file, even after a retry. Run the search again to retry.');
        detailRow(ws, 'Checked', opts.generatedAt);
    }

    function addSummarySheet(ws, rows, opts) {
        ws.columns = [
            { key: 'cn',     width: 16 },
            { key: 'soc',    width: 48 },
            { key: 'nature', width: 34 },
            { key: 'office', width: 13 },
            { key: 'filed',  width: 12 },
            { key: 'ms',     width: 60 },
            { key: 'notes',  width: 30 },
        ];
        ws.views     = [{ showGridLines: false }];
        ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

        var title = ws.addRow(['Docket Viewer — Bulk Export']);
        title.getCell(1).font = { bold: true, size: 14, color: { argb: 'FF0E2336' } };

        var notFound = rows.filter(function (r) { return r.file.status === 'notfound'; }).length;
        var errors   = rows.filter(function (r) { return r.file.status === 'error'; }).length;
        var fellBack = rows.filter(function (r) { return r.ms && r.ms.note; }).length;
        var meta = [
            ['Generated',  opts.generatedAt],
            ['Milestones', !opts.useAI ? 'Keyword detection'
                         : 'AI analysis (Gemini)' + (fellBack ? ' — keyword detection for ' + fellBack + ' file' + (fellBack === 1 ? '' : 's') + ' where AI was unavailable' : '')],
            ['Files',      rows.length + (notFound ? ' — ' + notFound + ' not found' : '') + (errors ? ' — ' + errors + ' could not be retrieved' : '')],
        ];
        meta.forEach(function (m) {
            var row = ws.addRow([m[0], m[1]]);
            row.getCell(1).font = { bold: true, size: 9, color: { argb: 'FF5B6773' } };
            row.getCell(2).font = { size: 10 };
        });
        ws.addRow([]);

        var head = ws.addRow(['Court File', 'Style of Cause', 'Nature of Proceeding', 'Office', 'Date Filed', 'Milestones', 'Notes']);
        head.eachCell(function (cell) {
            cell.font      = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
            cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
            cell.border    = BOX;
            cell.alignment = { vertical: 'middle' };
        });

        rows.forEach(function (r, i) {
            var file = r.file, row;
            if (file.status === 'ok') {
                var f = caseFields(file.caseData);
                row = ws.addRow([
                    { text: file.cn, hyperlink: internalLink(r.sheetName) },
                    f.styleOfCause, f.nature, f.office, f.filed,
                    r.ms.badges.map(function (b) { return b.text; }).join('; ') || 'No milestones detected yet',
                    r.ms.note,
                ]);
            } else {
                row = ws.addRow([
                    { text: file.cn, hyperlink: internalLink(r.sheetName) },
                    file.status === 'notfound' ? 'Not found' : 'Could not be retrieved',
                    '', '', '', '', 'See tab for details',
                ]);
            }
            row.eachCell({ includeEmpty: true }, function (cell, col) {
                cell.border    = BOX;
                cell.font      = { size: 9 };
                cell.alignment = { vertical: 'top', wrapText: col === 2 || col === 3 || col === 6 || col === 7 };
                if (i % 2) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF6F8FA' } };
            });
            row.getCell(1).font = { size: 9, color: { argb: BRAND }, underline: true };
            if (file.status !== 'ok') row.getCell(2).font = { size: 9, bold: true, color: { argb: TONE_FILL.red } };
        });

        ws.autoFilter = { from: { row: head.number, column: 1 }, to: { row: head.number + rows.length, column: 7 } };
        ws.views      = [{ showGridLines: false, state: 'frozen', ySplit: head.number }];

        ws.addRow([]);
        var disc = ws.addRow([DISCLAIMER]);
        ws.mergeCells('A' + disc.number + ':G' + disc.number);
        disc.getCell(1).font      = { size: 8, italic: true, color: { argb: 'FF7A8694' } };
        disc.getCell(1).alignment = { wrapText: true, vertical: 'top' };
        disc.height = 36;
    }

    // files: [{ cn, status: 'ok'|'notfound'|'error', caseData, entries, parties, ai, aiError }]
    // opts:  { useAI, todayStr (YYYY-MM-DD), generatedAt (display string), siteUrl }
    function buildBulkWorkbook(ExcelJS, files, opts) {
        var wb = new ExcelJS.Workbook();
        wb.creator = 'Docket Viewer';
        wb.created = new Date();

        var summary = wb.addWorksheet('Summary', { properties: { tabColor: { argb: BRAND } } });
        var used    = {};
        var rows    = files.map(function (file) {
            var sheetName = sheetNameFor(file.cn, used);
            var ws        = wb.addWorksheet(sheetName);
            var ms        = null;
            if (file.status === 'ok') ms = addFileSheet(ws, file, opts);
            else                      addErrorSheet(ws, file, opts);
            return { file: file, sheetName: sheetName, ms: ms };
        });
        addSummarySheet(summary, rows, opts);
        return wb;
    }

    var api = { buildBulkWorkbook: buildBulkWorkbook, sheetNameFor: sheetNameFor };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
