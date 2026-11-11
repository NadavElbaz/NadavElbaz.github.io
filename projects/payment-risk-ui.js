/* Payment Risk Checker — page behaviour. All processing happens locally in the browser. */
(function () {
  'use strict';

  var E = window.RiskEngine;
  var MAX_BYTES = 10 * 1024 * 1024;
  var PAGE = 100;

  var CHIP = {
    'Fraud': { cls: 'fraud', glyph: '✕', label: 'Fraud' },
    'Review': { cls: 'review', glyph: '!', label: 'Review' },
    'Legit': { cls: 'legit', glyph: '✓', label: 'Legit' },
    'Not enough information': { cls: 'info', glyph: '?', label: 'Not enough information' }
  };
  var SEVERITY = { 'Fraud': 0, 'Review': 1, 'Not enough information': 2, 'Legit': 3 };

  var state = {
    parsed: null, baseParsed: null, rawText: '', fileName: '', mapping: null, auto: null,
    intake: null, edits: {}, dateOrder: 'auto', includeTotals: false, runAnyway: false, fixOpen: null, lastDelim: '',
    analysisOpts: null, analysisIntake: null,
    analysis: null, summary: null, recap: null,
    thresholds: { fraud: E.DEFAULT_THRESHOLDS.fraud, review: E.DEFAULT_THRESHOLDS.review },
    mode: 'owner', filter: null, sort: 'risk', query: '', shown: PAGE
  };
  try { var m = localStorage.getItem('rcMode'); if (m === 'owner' || m === 'risk') state.mode = m; } catch (e) {}

  function $(s, r) { return (r || document).querySelector(s); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) { return E.formatMoney(n, state.analysis ? state.analysis.currency : ''); }
  function chip(cat) {
    var c = CHIP[cat];
    return '<span class="rc-chip rc-chip-' + c.cls + '"><span aria-hidden="true">' + c.glyph + '</span> ' + esc(c.label) + '</span>';
  }
  function setMsg(el, text, kind) {
    el.textContent = text || '';
    el.className = 'rc-msg' + (kind ? ' rc-msg-' + kind : '');
  }
  function reduceMotion() { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function scrollToEl(el) { el.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' }); }

  /* ------------------------------------------------------------------ upload */

  var drop = $('#rc-drop'), fileInput = $('#rc-file'), msg = $('#rc-msg');

  $('#rc-choose').addEventListener('click', function (e) { e.stopPropagation(); fileInput.click(); });
  drop.addEventListener('click', function () { fileInput.click(); });
  drop.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  ['dragenter', 'dragover'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('is-over'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('is-over'); });
  });
  drop.addEventListener('drop', function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) readFile(f, loadText);
  });
  fileInput.addEventListener('change', function () {
    if (fileInput.files[0]) readFile(fileInput.files[0], loadText);
    fileInput.value = '';
  });
  $('#rc-sample').addEventListener('click', function (e) {
    e.stopPropagation();
    loadSample();
  });
  function loadSample() {
    setMsg(msg, 'Loading the sample file…');
    fetch('sample-payments.csv', { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (t) { loadText(t, 'sample-payments.csv'); })
      .catch(function () { setMsg(msg, 'Could not load the sample file. Use the download link below it and choose it manually.', 'error'); });
  }

  // Reads a local file as text and hands it to done(text, name). Upload-level problems show as a card.
  function readFile(file, done, onError) {
    onError = onError || function (m) { showIssue($('#rc-upload-issue'), m); };
    if (/\.(xlsx?|numbers|ods)$/i.test(file.name)) { onError(E.message('UPLOAD_SPREADSHEET')); return; }
    if (file.size > MAX_BYTES) { onError(E.message('UPLOAD_TOO_BIG')); return; }
    var reader = new FileReader();
    reader.onload = function () { done(String(reader.result), file.name); };
    reader.onerror = function () { onError(E.message('UPLOAD_UNREADABLE')); };
    reader.readAsText(file);
  }

  function showIssue(el, m, extra) { el.innerHTML = issueHtml(m, { upload: true, extra: extra || '' }); }

  function loadText(text, name, delim) {
    var parsed = E.parseCSV(text, delim);
    var shape = E.checkShape(parsed);
    state.rawText = text; state.fileName = name;
    setMsg(msg, '');
    if (shape && shape.code !== 'HEADER_ONLY') {
      // EMPTY / ONE_COLUMN: column matching is meaningless, so stay on step 1.
      state.parsed = null; state.analysis = null; state.intake = null;
      $('#rc-step-map').hidden = true; $('#rc-step-results').hidden = true;
      var tried = delim ? '<p class="rc-issue-note">Read with ' + esc(E.DELIMITER_NAMES[delim] || delim) + ': still one column.</p>' : '';
      showIssue($('#rc-upload-issue'), shape, tried);
      return;
    }
    $('#rc-upload-issue').innerHTML = '';
    state.parsed = parsed; state.baseParsed = parsed;
    state.edits = {}; state.dateOrder = 'auto'; state.includeTotals = false; state.runAnyway = false;
    state.fixOpen = null;
    var g = E.guessMapping(parsed.headers);
    state.mapping = g.mapping; state.auto = g.auto;
    state.analysis = null; state.filter = null; state.query = ''; state.shown = PAGE;
    $('#rc-step-results').hidden = true;
    setMsg(msg, 'Loaded ' + name + ': ' + parsed.rows.length.toLocaleString() + ' rows, ' + parsed.headers.length + ' columns.', 'ok');
    renderMapping();
    renderFix();
    $('#rc-step-map').hidden = false;
    scrollToEl($('#rc-step-map'));
  }

  /* ------------------------------------------------------------------ intake */

  function effParsed() { return E.applyEdits(state.parsed, state.edits); }
  function intakeOpts() { return { dateOrder: state.dateOrder, includeTotals: state.includeTotals, runAnyway: state.runAnyway }; }

  // Re-runs the file check. Called on every mapping change and every fix.
  function refreshIntake() {
    state.intake = E.validateIntake(effParsed(), state.mapping, intakeOpts());
    renderIntake();
    renderChecks();
    if (state.fixOpen === 'grid') renderGrid();
    if (state.analysis) setMsg($('#rc-stale'), 'The file or column match changed. Press “Analyze payments” again to update these results.', 'warn');
  }

  var LEVEL_LABEL = { block: 'Needs fixing', warn: 'Check this', info: 'Note', ok: 'Ready' };

  function issueHtml(m, o) {
    o = o || {};
    var d = m.data || {}, acts = '';
    // "Fix it here" tools
    if (m.action === 'separator') {
      var pick = E.DELIMITERS.indexOf(d.guessDelim) !== -1 ? d.guessDelim : (state.lastDelim || '|');
      acts += '<label class="rc-inline-field"><span>Separator</span><select id="rc-delim">' + E.DELIMITERS.map(function (x) {
        return '<option value="' + esc(x === '\t' ? 'tab' : x) + '"' + (x === pick ? ' selected' : '') + '>' + esc(E.DELIMITER_NAMES[x]) + '</option>';
      }).join('') + '</select></label>';
      acts += btn('separator', m.fix, true);
    } else if (m.action === 'date-order') {
      var cur = state.dateOrder;
      acts += '<div class="rc-seg rc-seg-sm" role="group" aria-label="Date order">' +
        ['auto', 'mdy', 'dmy'].map(function (k) {
          var label = { auto: 'Automatic', mdy: 'Month first (MM/DD)', dmy: 'Day first (DD/MM)' }[k];
          return '<button type="button" data-act="order" data-order="' + k + '" aria-pressed="' + (cur === k) + '">' + label + '</button>';
        }).join('') + '</div>';
    } else if (m.action && m.fix) {
      acts += btn(m.action, m.fix, m.level === 'block' || m.level === 'warn');
    }
    // Fixes stay editable: reopen the grid even when no cell is unreadable any more.
    if (m.code === 'EDITED') acts += btn('fixgrid', 'Review my fixes');
    // one-click column suggestions
    (d.suggest || []).forEach(function (s) {
      var field = /AMOUNT/.test(m.code) ? 'amount' : 'date';
      acts += '<button type="button" class="rc-btn rc-btn-sm" data-act="use" data-field="' + field + '" data-col="' + s.idx + '">Use “' + esc(s.name) + '”</button>';
    });
    if (m.level === 'block') acts += btn('upload', 'Upload a corrected file');
    if (m.runAnyway) acts += '<button type="button" class="rc-link" data-act="run-anyway">' + esc(m.runAnyway) + '</button>';
    return '<div class="rc-issue rc-issue-' + m.level + '" data-code="' + esc(m.code) + '">' +
      '<p class="rc-issue-title"><span class="rc-issue-tag">' + LEVEL_LABEL[m.level] + '</span> ' + esc(m.title) + '</p>' +
      '<p class="rc-issue-text">' + esc(m.text) + '</p>' + (o.extra || '') +
      (acts ? '<div class="rc-issue-actions">' + acts + '</div>' : '') + '</div>';
  }
  function btn(act, label, primary) {
    return '<button type="button" class="rc-btn rc-btn-sm' + (primary ? ' rc-btn-primary' : '') + '" data-act="' + esc(act) + '">' + esc(label) + '</button>';
  }

  function renderIntake() {
    var v = state.intake, el = $('#rc-intake');
    el.innerHTML = v.blocking.concat(v.warnings).map(function (m) { return issueHtml(m); }).join('');
    var b = v.blocking.length;
    $('#rc-analyze').disabled = b > 0;
    setMsg($('#rc-map-msg'), b ? 'Fix the ' + (b === 1 ? 'problem' : b + ' problems') + ' marked “Needs fixing” above to continue.' : '', b ? 'error' : '');
  }

  function focusSelect(key) {
    var el = $('#rc-map-' + key);
    if (!el) return;
    el.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'center' });
    el.focus({ preventScroll: true });
    var row = el.closest('.rc-map-row');
    row.classList.remove('rc-attn'); void row.offsetWidth; row.classList.add('rc-attn');
  }
  function firstUnmapped(keys) {
    for (var i = 0; i < keys.length; i++) if (state.mapping[keys[i]] < 0) return keys[i];
    return keys[0];
  }

  function onAction(e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var act = b.dataset.act;
    if (act === 'upload') fileInput.click();
    else if (act === 'sample') loadSample();
    else if (act === 'separator') {
      var v = $('#rc-delim').value, d = v === 'tab' ? '\t' : v;
      state.lastDelim = d;
      loadText(state.rawText, state.fileName, d);
    }
    else if (act === 'paste') openFix('paste');
    else if (act === 'fixgrid') openFix('grid');
    else if (act === 'map:amount') focusSelect('amount');
    else if (act === 'map:date') focusSelect('date');
    else if (act === 'map:customer') focusSelect(firstUnmapped(['customer_name', 'first_name', 'email', 'card_last4']));
    else if (act === 'map:any') focusSelect(firstUnmapped(['status', 'payment_type', 'channel', 'job_id', 'invoice_id', 'email', 'card_last4']));
    else if (act === 'use') { setField(b.dataset.field, parseInt(b.dataset.col, 10)); refreshIntake(); }
    else if (act === 'order') { state.dateOrder = b.dataset.order; refreshIntake(); }
    else if (act === 'include-totals') { state.includeTotals = true; refreshIntake(); }
    else if (act === 'exclude-totals') { state.includeTotals = false; refreshIntake(); }
    else if (act === 'run-anyway') { state.runAnyway = true; refreshIntake(); }
    else if (act === 'undo-run-anyway') { state.runAnyway = false; refreshIntake(); }
    else if (act === 'undo-edits') { state.edits = {}; refreshIntake(); }
    else if (act === 'undo-added') {
      var n = state.baseParsed.rows.length;
      Object.keys(state.edits).forEach(function (k) { if (+k.split(':')[0] >= n) delete state.edits[k]; });
      state.parsed = state.baseParsed; renderMapping();
    }
  }
  $('#rc-intake').addEventListener('click', onAction);
  $('#rc-upload-issue').addEventListener('click', onAction);
  $('#rc-intake-notes').addEventListener('click', onAction);

  /* ------------------------------------------------------- fix it here tools */

  function openFix(which) {
    state.fixOpen = which;
    renderFix();
    var panel = $('#rc-fix');
    scrollToEl(panel);
    var first = which === 'paste' ? $('#rc-paste') : $('#rc-grid input');
    if (first) first.focus({ preventScroll: true });
  }

  function renderFix() {
    var el = $('#rc-fix');
    if (!state.fixOpen) { el.innerHTML = ''; el.hidden = true; return; }
    el.hidden = false;
    if (state.fixOpen === 'paste') {
      el.innerHTML = '<h3>Add rows</h3>' +
        '<p class="rc-note">Paste rows copied from a spreadsheet or another export, or add a second CSV file. Include the header line to line columns up by name; without it, rows need the same ' + state.parsed.headers.length + ' columns in the same order.</p>' +
        '<textarea id="rc-paste" rows="6" spellcheck="false" aria-label="Rows to add" placeholder="' + esc(state.parsed.headers.slice(0, 6).join(',')) + '…"></textarea>' +
        '<div class="rc-issue-actions">' + btn('append-paste', 'Add these rows', true) + btn('append-file', 'Add rows from another file') + btn('close-fix', 'Close') + '</div>' +
        '<p class="rc-msg" id="rc-fix-msg" role="status" aria-live="polite"></p>';
    } else {
      el.innerHTML = '<h3>Fix these rows</h3>' +
        '<p class="rc-note">Type the right value for each cell, then press Apply fixes. You can change a fixed cell at any time; clear it and apply to undo that fix. Edits are used for this analysis only, stay in this browser tab, and are marked in the results file.</p>' +
        '<div class="rc-table-wrap" id="rc-grid"></div>' +
        '<div class="rc-issue-actions">' + btn('apply-grid', 'Apply fixes', true) + btn('close-fix', 'Close') + '</div>' +
        '<p class="rc-msg" id="rc-fix-msg" role="status" aria-live="polite"></p>';
      renderGrid();
    }
  }

  function hasEdit(key) { return Object.prototype.hasOwnProperty.call(state.edits, key); }
  function appliedValue(key) { return hasEdit(key) ? String(state.edits[key]) : ''; }

  // Cells that are unreadable in the file itself (no edits applied), so fixed cells stay
  // listed and editable. Same options as the live check; appended rows are included.
  // Edits whose key is not in this list (e.g. after a mapping change) are left in state.edits.
  function baseRowIssues() {
    if (!state.parsed || !state.mapping) return [];
    return E.validateIntake(state.parsed, state.mapping, intakeOpts()).rowIssues;
  }

  function renderGrid() {
    var grid = $('#rc-grid');
    if (!grid) return;
    var issues = baseRowIssues(), max = E.MAX_FIX_CELLS;
    if (!issues.length) { grid.innerHTML = '<p class="rc-empty">This file has no unreadable amount or date cells to fix.</p>'; syncApply(); return; }
    var hdr = state.parsed.headers, shown = issues.slice(0, max);
    grid.innerHTML = '<p class="rc-grid-progress" id="rc-grid-progress"></p>' +
      '<table class="rc-grid"><thead><tr><th>Row</th><th>Customer</th><th>Column</th><th>Now</th><th>Correct value</th><th><span class="rc-sr">Check</span></th></tr></thead><tbody>' +
      shown.map(function (x) {
        var key = x.row + ':' + x.col, id = 'rc-g-' + x.row + '-' + x.col;
        return '<tr><td data-label="Row">' + x.line + '</td><td data-label="Customer">' + (x.who ? esc(x.who) : '<span class="rc-muted">—</span>') + '</td>' +
          '<td data-label="Column">' + esc(hdr[x.col] || x.field) + '</td>' +
          '<td data-label="Now">' + (x.value ? '<code>' + esc(x.value) + '</code>' : '<span class="rc-muted">blank</span>') + '</td>' +
          '<td><label class="rc-sr" for="' + id + '">New ' + x.field + ' for row ' + x.line + '</label>' +
          '<input type="text" id="' + id + '" data-key="' + key + '" data-field="' + x.field + '" autocomplete="off" placeholder="' + (x.field === 'amount' ? 'e.g. 400.00' : 'e.g. 2026-10-10 10:00') + '" value="' + esc(appliedValue(key)) + '" aria-describedby="' + id + '-st ' + id + '-ok"></td>' +
          '<td><span class="rc-grid-fixed" id="' + id + '-st"></span><span class="rc-grid-ok" id="' + id + '-ok"></span></td></tr>';
      }).join('') + '</tbody></table>' +
      (issues.length > max ? '<p class="rc-fine">Showing the first ' + max + ' of ' + issues.length + ' cells. Fix the rest in your export and upload it again.</p>' : '');
    // Fixed cells: show the "reads as …" hint and the fixed status. A fixed value that no
    // longer reads (e.g. after switching day/month order) shows the red hint instead.
    var fixed = 0;
    grid.querySelectorAll('input').forEach(function (inp) {
      if (!hasEdit(inp.dataset.key)) return;
      if (checkCell(inp)) {
        fixed++;
        $('#' + inp.id + '-st').innerHTML = '<span aria-hidden="true">✓</span> fixed';
      }
    });
    $('#rc-grid-progress').textContent = fixed + ' of ' + shown.length + ' cell' + (shown.length === 1 ? '' : 's') + ' fixed';
    syncApply();
  }

  // Apply fixes is enabled only while the grid is "dirty": at least one box differs (trimmed)
  // from its applied value (state.edits[key], or '' when the cell is not fixed). After an
  // apply the grid is re-rendered from state, so only rejected values put back keep it on.
  function syncApply() {
    var b = $('#rc-fix [data-act="apply-grid"]');
    if (!b) return;
    var dirty = Array.prototype.some.call(document.querySelectorAll('#rc-grid input'), function (inp) {
      return inp.value.trim() !== appliedValue(inp.dataset.key);
    });
    b.disabled = !dirty;
    b.setAttribute('aria-disabled', String(!dirty));
  }

  // Live check with the engine's own parsers, so "valid here" means "readable in the analysis".
  function checkCell(input) {
    var v = input.value.trim(), out = $('#' + input.id + '-ok'), ok = null, text = '';
    if (v) {
      if (input.dataset.field === 'amount') {
        var a = E.parseAmount(v);
        ok = isFinite(a);
        text = ok ? (a > 0 ? 'reads as ' + E.formatMoney(a) : 'reads as ' + E.formatMoney(a) + ', left out as a refund') : 'not an amount';
      } else {
        var d = E.parseDate(v, state.intake.stats.dateOrder);
        ok = !!d;
        text = ok ? 'reads as ' + E.formatDate(d) : 'not a date we read';
      }
    }
    input.classList.toggle('is-bad', ok === false);
    input.classList.toggle('is-good', ok === true);
    input.setAttribute('aria-invalid', String(ok === false));
    out.textContent = text;
    out.className = 'rc-grid-ok' + (ok === true ? ' is-good' : ok === false ? ' is-bad' : '');
    return ok;
  }

  $('#rc-fix').addEventListener('input', function (e) {
    if (e.target.matches('#rc-grid input')) { checkCell(e.target); syncApply(); }
  });
  $('#rc-fix').addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var act = b.dataset.act, fm = $('#rc-fix-msg');
    if (act === 'close-fix') { state.fixOpen = null; renderFix(); return; }
    if (act === 'append-paste') { appendText($('#rc-paste').value); return; }
    if (act === 'append-file') { $('#rc-append-file').click(); return; }
    if (act === 'apply-grid') {
      var applied = 0, removed = 0, bad = 0, rejected = {};
      document.querySelectorAll('#rc-grid input').forEach(function (inp) {
        var key = inp.dataset.key, v = inp.value.trim();
        if (v === appliedValue(key)) return;                                  // unchanged
        if (!v) { delete state.edits[key]; removed++; return; }               // cleared: undo this fix
        if (checkCell(inp)) { state.edits[key] = v; applied++; }
        else { rejected[key] = inp.value; bad++; }                            // keeps any earlier fix
      });
      if (!applied && !removed && !bad) { setMsg(fm, 'Change a value in the \u201cCorrect value\u201d box of at least one row, then press Apply fixes.', 'warn'); return; }
      refreshIntake();
      // Put rejected values back so the user can correct them. One-time restore only:
      // later re-renders (mapping changes, reopening the grid) show the applied values again.
      Object.keys(rejected).forEach(function (key) {
        var inp = document.querySelector('#rc-grid input[data-key="' + key + '"]');
        if (!inp) return;
        inp.value = rejected[key];
        checkCell(inp);
      });
      syncApply();
      setMsg($('#rc-fix-msg'), (applied ? 'Applied ' + applied + ' fix' + (applied === 1 ? '' : 'es') + '. ' : '') +
        (removed ? 'Removed ' + removed + ' fix' + (removed === 1 ? '' : 'es') + '. ' : '') + (bad ? bad + ' value' + (bad === 1 ? '' : 's') + ' still can\'t be read and ' + (bad === 1 ? 'was' : 'were') + ' not applied.' : ''), bad ? 'warn' : 'ok');
    }
  });
  $('#rc-append-file').addEventListener('change', function () {
    var f = this.files[0];
    this.value = '';
    if (f) readFile(f, function (text) { appendText(text); }, function (m) { setMsg($('#rc-fix-msg'), m.title + '. ' + m.text, 'error'); });
  });

  function appendText(text) {
    var res = E.appendRows(state.parsed, text), fm = $('#rc-fix-msg');
    if (res.error) { setMsg(fm, res.error.title + '. ' + res.error.text, 'error'); return; }
    state.parsed = res.parsed;
    var ta = $('#rc-paste'); if (ta) ta.value = '';
    renderMapping(); // re-runs the file check
    setMsg($('#rc-fix-msg'), res.note.title + '. ' + res.note.text, 'ok');
  }

  /* ----------------------------------------------------------------- mapping */

  function sampleValue(colIdx) {
    if (colIdx < 0 || !state.parsed) return '';
    var rows = state.parsed.rows, need = Math.ceil(state.parsed.headers.length / 2);
    for (var i = 0; i < Math.min(rows.length, 80); i++) {
      var filled = rows[i].filter(function (c) { return String(c).trim() !== ''; }).length;
      var v = String(rows[i][colIdx] || '').trim();
      if (filled >= need && v) return v;
    }
    return '';
  }

  function renderMapping() {
    var p = state.parsed, html = '';
    var delimName = E.DELIMITER_NAMES[p.delimiter] || 'comma';
    $('#rc-map-intro').textContent = 'We matched your columns automatically (separator: ' + delimName + '). Check each one and fix anything that\'s wrong. A field set to "not in my file" simply skips the checks that need it.';

    var groups = {};
    E.FIELDS.forEach(function (f) { (groups[f.group] = groups[f.group] || []).push(f); });
    ['required', 'who', 'how', 'links', 'where'].forEach(function (g) {
      html += '<fieldset class="rc-map-group"><legend>' + esc(E.GROUP_LABELS[g]) + (g === 'who' ? ' <span class="rc-legend-note">(at least one is required)</span>' : '') + '</legend>';
      groups[g].forEach(function (f) {
        var cur = state.mapping[f.key];
        var opts = '<option value="-1"' + (cur === -1 ? ' selected' : '') + '>— not in my file —</option>';
        p.headers.forEach(function (h, i) {
          opts += '<option value="' + i + '"' + (cur === i ? ' selected' : '') + '>' + esc(h || '(column ' + (i + 1) + ')') + '</option>';
        });
        html += '<div class="rc-map-row">' +
          '<label for="rc-map-' + f.key + '"><span class="rc-map-label">' + esc(f.label) + (f.required ? ' <abbr title="required">*</abbr>' : '') + '</span>' +
          (f.hint ? '<span class="rc-map-hint">' + esc(f.hint) + '</span>' : '') + '</label>' +
          '<select id="rc-map-' + f.key + '" data-key="' + f.key + '">' + opts + '</select>' +
          '<span class="rc-map-eg" data-eg="' + f.key + '">' + exampleHtml(f.key) + '</span></div>';
      });
      html += '</fieldset>';
    });
    $('#rc-map').innerHTML = html;
    refreshIntake();
  }

  function exampleHtml(key) {
    var i = state.mapping[key];
    if (i < 0) return '<span class="rc-muted">—</span>';
    var v = sampleValue(i);
    var tag = state.auto && state.auto[key] ? '<span class="rc-auto">auto</span>' : '';
    return (v ? 'e.g. <code>' + esc(v.length > 28 ? v.slice(0, 27) + '…' : v) + '</code>' : '<span class="rc-muted">no sample</span>') + ' ' + tag;
  }

  // Sets one field's column, keeping one column per field: if it was taken elsewhere, frees the other field.
  function setField(key, col) {
    state.mapping[key] = col;
    var sel = $('#rc-map-' + key); if (sel) sel.value = String(col);
    if (col >= 0) {
      Object.keys(state.mapping).forEach(function (k) {
        if (k !== key && state.mapping[k] === col) {
          state.mapping[k] = -1;
          var other = $('#rc-map-' + k); if (other) other.value = '-1';
          var egOther = $('[data-eg="' + k + '"]'); if (egOther) egOther.innerHTML = exampleHtml(k);
        }
      });
    }
    if (state.auto) delete state.auto[key];
    var eg = $('[data-eg="' + key + '"]'); if (eg) eg.innerHTML = exampleHtml(key);
  }

  $('#rc-map').addEventListener('change', function (e) {
    var sel = e.target.closest('select[data-key]');
    if (!sel) return;
    setField(sel.dataset.key, parseInt(sel.value, 10));
    refreshIntake();
  });

  function renderChecks() {
    var avail = state.intake ? state.intake.avail : [];
    if (!avail.length) { $('#rc-checks').innerHTML = ''; $('#rc-checks-count').textContent = ''; return; }
    var active = avail.filter(function (a) { return a.ok; }).length;
    $('#rc-checks-count').textContent = '(' + active + ' of ' + avail.length + ')';
    $('#rc-checks').innerHTML = avail.map(function (a) {
      return '<li class="' + (a.ok ? 'is-on' : 'is-off') + '"><span class="rc-check-mark" aria-hidden="true">' + (a.ok ? '✓' : '–') + '</span>' +
        '<span><span class="rc-check-name">' + esc(a.name) + '</span>' +
        (a.ok ? '' : '<span class="rc-check-need">Needs: ' + esc(a.missing.join(', ')) + '</span>') + '</span></li>';
    }).join('');
  }

  $('#rc-reset').addEventListener('click', function () {
    state.parsed = null; state.baseParsed = null; state.analysis = null; state.intake = null; state.edits = {}; state.fixOpen = null;
    $('#rc-step-map').hidden = true; $('#rc-step-results').hidden = true;
    $('#rc-upload-issue').innerHTML = '';
    setMsg(msg, '');
    scrollToEl($('#rc-step-upload'));
  });

  /* ----------------------------------------------------------------- analyze */

  $('#rc-analyze').addEventListener('click', function () {
    if (!state.intake || !state.intake.ok) return;
    state.analysisOpts = intakeOpts();
    state.analysisIntake = state.intake;
    state.analysis = E.analyze(effParsed(), state.mapping, state.analysisOpts);
    state.filter = null; state.query = ''; state.shown = PAGE;
    $('#rc-search').value = '';
    setMsg($('#rc-stale'), '');
    recompute();
    $('#rc-step-results').hidden = false;
    setMsg($('#rc-dl-msg'), '');
    renderAll();
    var h = $('#rc-h-results');
    scrollToEl($('#rc-step-results'));
    h.focus({ preventScroll: true });
  });

  // Notes carried from the file check onto the results: edits, added rows, too few rows.
  function intakeNotes() {
    var a = state.analysis, v = state.analysisIntake, notes = [];
    if (a.edited) notes.push(E.message('EDITED', { n: a.edited }));
    if (a.added) notes.push(E.message('ADDED', { n: a.added }));
    if (state.analysisOpts.runAnyway && a.usable < E.MIN_ROWS) notes.push(E.message('RUN_ANYWAY_NOTE', { usable: a.usable, done: true }));
    if (v && v.stats.dateOrderForced) notes.push(E.message('DATE_ORDER_OVERRIDE', { order: v.stats.dateOrder, inferred: v.stats.inferredOrder, example: '' }));
    return notes;
  }

  function renderIntakeNotes() {
    $('#rc-intake-notes').innerHTML = intakeNotes().map(function (m) {
      return '<p class="rc-note-line rc-note-' + m.level + '"><strong>' + esc(m.title) + '.</strong> ' + esc(m.text) + '</p>';
    }).join('');
  }

  function recompute() {
    state.summary = E.summarize(state.analysis.results, state.thresholds);
    state.recap = E.buildRecap(state.analysis, state.thresholds, state.summary);
  }

  function renderAll() {
    syncMode();
    renderIntakeNotes();
    renderStats();
    renderRecap();
    renderTable();
  }

  /* ------------------------------------------------------------------- stats */

  function renderStats() {
    var s = state.summary;
    $('#rc-stats').innerHTML = E.CATEGORIES.map(function (c) {
      var d = s.byCat[c], pct = s.total.count ? Math.round(d.count / s.total.count * 100) : 0;
      return '<button type="button" class="rc-stat" data-cat="' + esc(c) + '" aria-pressed="' + (state.filter === c) + '">' +
        chip(c) + '<span class="rc-stat-n">' + d.count.toLocaleString() + '</span>' +
        '<span class="rc-stat-sub">' + pct + '% of rows</span>' +
        '<span class="rc-stat-amt">' + esc(money(d.amount)) + '</span></button>';
    }).join('');
  }

  $('#rc-stats').addEventListener('click', function (e) {
    var b = e.target.closest('.rc-stat');
    if (!b) return;
    state.filter = state.filter === b.dataset.cat ? null : b.dataset.cat;
    state.shown = PAGE;
    renderStats(); renderTable();
  });

  /* ------------------------------------------------------------------- recap */

  function caseRows(c) { return c.lines.length === 1 ? 'row ' + c.lines[0] : 'rows ' + c.lines[0] + '–' + c.lines[c.lines.length - 1]; }

  // Text shared by the on-screen recap and the PDF / print report. `bold` wraps emphasised parts,
  // `enc` escapes text (pass `same` for plain text).
  function skippedText() {
    var a = state.analysis, bits = [], nTot = a.skipped.summary + a.skipped.total;
    if (nTot) bits.push(nTot + ' totals or blank row' + (nTot > 1 ? 's' : ''));
    if (a.skipped.header) bits.push(a.skipped.header + ' repeated header line' + (a.skipped.header > 1 ? 's' : ''));
    if (a.skipped.refund) bits.push(a.skipped.refund + ' refund or zero-amount row' + (a.skipped.refund > 1 ? 's' : ''));
    return bits.length ? 'Left out of the analysis: ' + bits.join(' and ') + '.' : '';
  }

  function ownerHeadline(bold, enc) {
    var s = state.summary, r = state.recap, a = state.analysis;
    var nFailed = a.results.filter(function (x) { return x.rec.isFailed; }).length, nPay = s.total.count - nFailed;
    var cf = r.cases.filter(function (c) { return c.category === 'Fraud'; }).length, cr = r.cases.length - cf;
    var scope = 'We checked ' + nPay.toLocaleString() + ' payment' + (nPay === 1 ? '' : 's') + ' (' + enc(money(s.total.amount)) + ')' + (nFailed ? ', plus ' + nFailed + ' failed attempt' + (nFailed > 1 ? 's' : '') : '');
    if (!s.total.count) return 'No payments could be read from this file.';
    if (!r.cases.length) return scope + '. Nothing stands out.';
    return scope + '. We found ' + bold(r.cases.length + ' case' + (r.cases.length > 1 ? 's' : '') + ' that need attention') + ': ' +
      cf + ' look like fraud and ' + cr + ' deserve a quick check, with ' + bold(enc(money(r.flagged.amount))) + ' at stake.';
  }

  function riskHeadline(bold, enc) {
    var s = state.summary, r = state.recap;
    return 'Flagged: ' + bold(r.flagged.count.toLocaleString()) + ' of ' + s.total.count.toLocaleString() +
      ' (' + (s.total.count ? Math.round(r.flagged.count / s.total.count * 1000) / 10 : 0) + '%) · ' + enc(money(r.flagged.amount));
  }

  function strongTag(x) { return '<strong>' + x + '</strong>'; }
  function same(x) { return x; }

  function caseCard(c) {
    var rows = caseRows(c);
    return '<article class="rc-case">' +
      '<div class="rc-case-top">' + chip(c.category) + '<span class="rc-case-meta">' + (c.exposure ? esc(money(c.exposure)) + ' at stake · ' : '') + esc(rows) + '</span></div>' +
      '<p class="rc-case-head">' + esc(c.headline) + '</p>' +
      (c.step ? '<p class="rc-case-step"><strong>Next step:</strong> ' + esc(c.step) + '</p>' : '') +
      (c.untilTs ? '<p class="rc-case-until">Can still be reversed until about ' + esc(E.dayFull(c.untilTs)) + '.</p>' : '') +
      '</article>';
  }

  function renderRecap() {
    var s = state.summary, r = state.recap, a = state.analysis, html = '';
    var skipped = skippedText();
    var skipNote = skipped ? '<p class="rc-fine">' + esc(skipped) + '</p>' : '';
    var insights = r.insights.length ? '<h4>What your file tells you</h4><ul class="rc-insights">' + r.insights.map(function (i) { return '<li>' + esc(i.text) + '</li>'; }).join('') + '</ul>' : '';

    if (state.mode === 'owner') {
      var head = ownerHeadline(strongTag, esc);
      var neiRows = a.results.filter(function (x) { return x.category === 'Not enough information'; });

      html += '<div class="rc-recap-grid"><div><h3>Summary</h3><p class="rc-headline">' + head + '</p>' + skipNote + insights + '</div>';
      html += '<div><h3>Look at these first</h3>';
      if (r.cases.length) {
        html += r.cases.slice(0, 5).map(caseCard).join('');
        if (r.cases.length > 5) html += '<p class="rc-fine">' + (r.cases.length - 5) + ' more flagged case' + (r.cases.length - 5 > 1 ? 's are' : ' is') + ' in the table below.</p>';
      } else html += '<p class="rc-fine">Nothing flagged. Run this again on each new export.</p>';
      if (neiRows.length) {
        html += '<article class="rc-case"><div class="rc-case-top">' + chip('Not enough information') + '<span class="rc-case-meta">' + neiRows.length + ' row' + (neiRows.length > 1 ? 's' : '') + '</span></div>' +
          '<ul class="rc-why">' + neiRows.slice(0, 3).map(function (x) { return '<li>' + esc(x.story.headline) + '</li>'; }).join('') + '</ul>' +
          (neiRows.length > 3 ? '<p class="rc-fine">' + (neiRows.length - 3) + ' more in the table below.</p>' : '') + '</article>';
      }
      html += '</div></div>';
      html += '<h3>What to do about it</h3><ul class="rc-bullets rc-tips">' + r.tips.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
    } else {
      var t = state.thresholds;
      html += '<div class="rc-recap-grid"><div><h3>Thresholds</h3>' +
        '<div class="rc-thr"><label for="rc-thr-fraud">Fraud at or above <output id="rc-thr-fraud-out">' + t.fraud + '</output></label>' +
        '<input type="range" id="rc-thr-fraud" min="10" max="100" step="5" value="' + t.fraud + '"></div>' +
        '<div class="rc-thr"><label for="rc-thr-review">Review at or above <output id="rc-thr-review-out">' + t.review + '</output></label>' +
        '<input type="range" id="rc-thr-review" min="5" max="95" step="5" value="' + t.review + '"></div>' +
        '<button type="button" class="rc-btn" id="rc-thr-reset">Reset to 60 / 30</button>' +
        '<p class="rc-headline rc-mt">' + riskHeadline(strongTag, esc) + '</p>' + skipNote + insights + '</div>';
      html += '<div><h3>Rule coverage</h3><div class="rc-table-wrap"><table class="rc-rules"><thead><tr><th>ID</th><th>Check</th><th>Pts</th><th>Fired</th></tr></thead><tbody>' +
        r.ruleStats.map(function (x) {
          return '<tr class="' + (x.ok ? '' : 'is-off') + '"><td>' + x.id + '</td><td>' + esc(x.name) +
            (x.ok ? '' : '<span class="rc-check-need">Needs: ' + esc(x.missing.join(', ')) + '</span>') + '</td><td>' + x.points + '</td><td>' +
            (x.ok ? x.fired : '—') + '</td></tr>';
        }).join('') + '</tbody></table></div></div></div>';
      if (r.cases.length) html += '<h3>Cases, by exposure</h3><div class="rc-cases-row">' + r.cases.slice(0, 6).map(caseCard).join('') + '</div>';
    }
    $('#rc-recap').innerHTML = html;
  }

  $('#rc-recap').addEventListener('input', function (e) {
    if (e.target.id !== 'rc-thr-fraud' && e.target.id !== 'rc-thr-review') return;
    var f = parseInt($('#rc-thr-fraud').value, 10), r = parseInt($('#rc-thr-review').value, 10);
    if (e.target.id === 'rc-thr-fraud' && f <= r) { r = Math.max(5, f - 5); }
    if (e.target.id === 'rc-thr-review' && r >= f) { f = Math.min(100, r + 5); }
    state.thresholds.fraud = f; state.thresholds.review = r;
    recompute(); state.shown = PAGE;
    renderStats(); renderRecap(); renderTable();
    var el = $('#' + e.target.id); if (el) el.focus();
  });
  $('#rc-recap').addEventListener('click', function (e) {
    if (e.target.id !== 'rc-thr-reset') return;
    state.thresholds.fraud = E.DEFAULT_THRESHOLDS.fraud; state.thresholds.review = E.DEFAULT_THRESHOLDS.review;
    recompute(); renderStats(); renderRecap(); renderTable();
  });

  /* ------------------------------------------------------------------- table */

  function visibleRows() {
    var q = state.query.trim().toLowerCase();
    var rows = state.analysis.results.filter(function (res) {
      if (state.filter && res.category !== state.filter) return false;
      if (!q) return true;
      return (res.rec.display || '').toLowerCase().indexOf(q) !== -1 || String(res.rec.line) === q;
    });
    rows.sort(function (a, b) {
      if (state.sort === 'date') return (b.rec.date ? b.rec.date.ts : -1) - (a.rec.date ? a.rec.date.ts : -1);
      if (state.sort === 'amount') return (isFinite(b.rec.amount) ? b.rec.amount : -1) - (isFinite(a.rec.amount) ? a.rec.amount : -1);
      return byRisk(a, b);
    });
    return rows;
  }

  function byRisk(a, b) {
    return SEVERITY[a.category] - SEVERITY[b.category] || b.score - a.score || a.rec.line - b.rec.line;
  }

  function renderTable() {
    var rows = visibleRows(), total = rows.length, slice = rows.slice(0, state.shown), risk = state.mode === 'risk';
    $('#rc-count').textContent = total.toLocaleString() + ' row' + (total === 1 ? '' : 's') + (state.filter ? ' · ' + state.filter : '');
    if (!total) { $('#rc-table').innerHTML = '<p class="rc-empty">No payments match.</p>'; $('#rc-more').hidden = true; return; }

    var head = '<th>Result</th>' + (risk ? '<th class="rc-num">Score</th>' : '') + '<th>Customer</th><th>Date</th><th class="rc-num">Amount</th><th>Paid via</th><th>' + (risk ? 'Story & checks fired' : 'What we found') + '</th>';
    var body = slice.map(function (res) {
      var r = res.rec, via = [r.type, r.channel].filter(Boolean).join(' · ');
      var st = res.story, flaggedRow = res.category === 'Fraud' || res.category === 'Review';
      var details;
      if (res.nei) details = '';
      else if (!res.hits.length) details = '';
      else if (risk) details = '<ul class="rc-why">' + res.hits.map(function (h) {
        return '<li><b>' + h.id + '</b> +' + h.points + ' ' + esc(h.detail) + '</li>';
      }).join('') + '</ul>';
      else details = '<ul class="rc-why">' + res.hits.map(function (h) { return '<li>' + esc(h.detail) + '</li>'; }).join('') + '</ul>';
      var why = '<p class="rc-why-head">' + esc(st.headline) + '</p>' + details +
        (st.step && (flaggedRow || res.nei) && !risk ? '<p class="rc-why-step"><strong>Next step:</strong> ' + esc(st.step) + '</p>' : '') +
        (st.untilTs && flaggedRow && !risk ? '<p class="rc-why-until">Can still be reversed until about ' + esc(E.dayFull(st.untilTs)) + '.</p>' : '');
      return '<tr>' +
        '<td data-label="Result">' + chip(res.category) + '</td>' +
        (risk ? '<td class="rc-num" data-label="Score">' + res.score + '</td>' : '') +
        '<td data-label="Customer"><div>' + (r.display ? esc(r.display) : '<span class="rc-muted">—</span>') + '<span class="rc-rowno">row ' + r.line +
          (r.added ? ' · added here' : '') + (r.edited && r.edited.length ? ' · edited here' : '') + '</span></div></td>' +
        '<td data-label="Date">' + (r.date ? esc(E.formatDate(r.date)) : '<span class="rc-muted">' + esc(r.dateText || '—') + '</span>') + '</td>' +
        '<td class="rc-num" data-label="Amount">' + (isFinite(r.amount) ? esc(money(r.amount)) : '<span class="rc-muted">—</span>') + '</td>' +
        '<td data-label="Paid via">' + (via ? esc(via) : '<span class="rc-muted">—</span>') + '</td>' +
        '<td data-label="' + (risk ? 'Checks' : 'Found') + '">' + why + '</td></tr>';
    }).join('');
    $('#rc-table').innerHTML = '<table class="rc-results"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>';
    $('#rc-more').hidden = total <= state.shown;
    $('#rc-more').textContent = 'Show more (' + Math.min(PAGE, total - state.shown).toLocaleString() + ' of ' + (total - state.shown).toLocaleString() + ' remaining)';
  }

  $('#rc-more').addEventListener('click', function () { state.shown += PAGE; renderTable(); });
  $('#rc-search').addEventListener('input', function (e) { state.query = e.target.value; state.shown = PAGE; renderTable(); });
  $('#rc-sort').addEventListener('change', function (e) { state.sort = e.target.value; renderTable(); });

  /* -------------------------------------------------------------- mode + CSV */

  function syncMode() {
    document.querySelectorAll('.rc-seg button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
    });
  }
  document.querySelector('.rc-seg').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-mode]');
    if (!b || b.dataset.mode === state.mode) return;
    state.mode = b.dataset.mode;
    try { localStorage.setItem('rcMode', state.mode); } catch (err) {}
    if (state.analysis) renderAll(); else syncMode();
  });

  function currentCSV() { return E.resultsToCSV(state.analysis.results); }
  function resultsFileName(ext) { return (state.fileName || 'payments').replace(/\.[^.]+$/, '') + '-risk-results.' + ext; }
  function csvFileName() { return resultsFileName('csv'); }

  function saveBlob(blob, name) {
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function download() {
    if (!state.analysis) return;
    var csv = currentCSV(), name = csvFileName(), n = state.analysis.results.length;
    saveBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), name);
    setMsg($('#rc-dl-msg'), 'Download started: ' + name + ' (' + n.toLocaleString() + ' rows). Look in your browser\'s Downloads folder. If nothing appears, open “Download didn\'t start?” just below.', 'ok');
    var fb = $('#rc-csv-fallback');
    fb.hidden = false;
  }
  document.querySelectorAll('.rc-dl').forEach(function (b) { b.addEventListener('click', download); });

  // Fallback for browsers that block downloads: show the CSV as text and offer to copy it.
  $('#rc-csv-fallback').addEventListener('toggle', function () {
    if (this.open && state.analysis) $('#rc-csv-text').value = currentCSV();
  });
  $('#rc-copy').addEventListener('click', function () {
    var ta = $('#rc-csv-text');
    if (!ta.value && state.analysis) ta.value = currentCSV();
    function done(ok) { setMsg($('#rc-dl-msg'), ok ? 'Copied. Paste it into a text file or a spreadsheet.' : 'Couldn\'t copy automatically — click inside the box, press Ctrl/Cmd+A, then Ctrl/Cmd+C.', ok ? 'ok' : 'warn'); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(ta.value).then(function () { done(true); }, function () { ta.select(); done(document.execCommand && document.execCommand('copy')); });
    } else { ta.select(); done(document.execCommand && document.execCommand('copy')); }
  });

  /* ------------------------------------------------------- PDF + print report */

  // The PDF and the print fallback are drawn from one plain-text report, so both show the same thing:
  // the current view and thresholds, every row sorted highest risk first, no on-screen filter or search.
  var PDF_LIBS = ['vendor/jspdf-2.5.2.umd.min.js', 'vendor/jspdf-autotable-3.8.4.min.js'];
  var DISCLAIMER = 'Proof of concept: it points out payments worth a second look; it can\'t prove fraud or innocence, and the weights are not tuned on real data. Use it alongside your payment provider\'s own tools.';
  // jsPDF's built-in Helvetica draws Windows-1252 only (Latin-1 plus a few typographic marks).
  // Anything else (₪, Hebrew, other scripts, emoji) sends the report to the print fallback.
  var NOT_HELVETICA = /[^\n\x20-\x7E\xA0-\xFF€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/;

  function stamp(d) {
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function clean(s) { return String(s).replace(/[\t\r\v\f]+/g, ' ').replace(/[\x00-\x08\x0E-\x1F\x7F]/g, ''); }
  function walkStrings(o, fn) {
    if (typeof o === 'string') return fn(o);
    if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) o[i] = walkStrings(o[i], fn); }
    else if (o && typeof o === 'object') Object.keys(o).forEach(function (k) { o[k] = walkStrings(o[k], fn); });
    return o;
  }

  function buildReport() {
    var s = state.summary, r = state.recap, a = state.analysis, risk = state.mode === 'risk', t = state.thresholds;
    var nei = s.byCat['Not enough information'].count;
    var rows = a.results.slice().sort(byRisk);
    var rep = {
      risk: risk,
      title: 'Payment risk results',
      fileName: state.fileName || 'payments',
      meta: [
        ['File', state.fileName || '(no file name)'],
        ['Generated', stamp(new Date())],
        ['View', risk ? 'Risk team' : 'Business owner'],
        ['Thresholds', 'Fraud at ' + t.fraud + ' points or more, Review at ' + t.review + ' or more'],
        ['Privacy', 'Generated in your browser. No data was uploaded.']
      ],
      counts: E.CATEGORIES.map(function (c) {
        var d = s.byCat[c];
        return { cat: c, cells: [c, d.count.toLocaleString(), (s.total.count ? Math.round(d.count / s.total.count * 100) : 0) + '%', money(d.amount)] };
      }),
      total: { total: true, cells: ['Total', s.total.count.toLocaleString(), s.total.count ? '100%' : '0%', money(s.total.amount)] },
      summary: [risk ? riskHeadline(same, same) : ownerHeadline(same, same), skippedText()].filter(Boolean),
      insights: r.insights.map(function (i) { return i.text; }),
      notes: intakeNotes().map(function (m) { return m.title + '. ' + m.text; }),
      casesTitle: risk ? 'Cases, by exposure' : 'Cases that need attention',
      cases: r.cases.map(function (c) {
        return { cat: c.category, cells: [c.category, caseRows(c), c.exposure ? money(c.exposure) : '—',
          [c.headline, c.step ? 'Next step: ' + c.step : '', c.untilTs ? 'Can still be reversed until about ' + E.dayFull(c.untilTs) + '.' : ''].filter(Boolean).join('\n')] };
      }),
      neiNote: !risk && nei ? nei + ' row' + (nei > 1 ? 's don\'t' : ' doesn\'t') + ' have enough information to judge. Each one is in the table below, with what is missing.' : '',
      tips: risk ? [] : r.tips.slice(),
      rules: risk ? r.ruleStats.map(function (x) {
        return [x.id, x.name + (x.ok ? '' : '\nNeeds: ' + x.missing.join(', ')), String(x.points), x.ok ? String(x.fired) : '—'];
      }) : [],
      tableTitle: 'All payments (' + rows.length.toLocaleString() + ' row' + (rows.length === 1 ? '' : 's') + ', highest risk first)',
      head: risk ? ['Result', 'Score', 'Row', 'Customer', 'Date', 'Amount', 'Paid via', 'Story & checks fired']
        : ['Result', 'Row', 'Customer', 'Date', 'Amount', 'Paid via', 'What we found'],
      body: rows.map(function (res) {
        var rec = res.rec, st = res.story, flagged = res.category === 'Fraud' || res.category === 'Review';
        var row = String(rec.line);
        if (rec.added) row += '\nadded here';
        if (rec.edited && rec.edited.length) row += '\nedited here: ' + rec.edited.join(', ');
        var found = [st.headline];
        if (!res.nei) res.hits.forEach(function (h) { found.push(risk ? h.id + ' +' + h.points + ' ' + h.detail : '- ' + h.detail); });
        if (!risk && st.step && (flagged || res.nei)) found.push('Next step: ' + st.step);
        if (!risk && st.untilTs && flagged) found.push('Can still be reversed until about ' + E.dayFull(st.untilTs) + '.');
        var cells = [res.category];
        if (risk) cells.push(String(res.score));
        cells.push(row, rec.display || '—', rec.date ? E.formatDate(rec.date) : (rec.dateText || '—'),
          isFinite(rec.amount) ? money(rec.amount) : '—', [rec.type, rec.channel].filter(Boolean).join(' · ') || '—', found.join('\n'));
        return { cat: res.category, cells: cells };
      })
    };
    return walkStrings(rep, clean);
  }

  // First character the built-in PDF font can't draw, or '' when everything fits.
  function firstUndrawable(rep) {
    var found = '';
    walkStrings(rep, function (str) {
      if (!found) { var m = NOT_HELVETICA.exec(str); if (m) found = String.fromCodePoint(str.codePointAt(m.index)); }
      return str;
    });
    return found;
  }

  var INK = [22, 24, 29], MUTED = [90, 96, 112], LINE = [215, 218, 224], HEAD_BG = [236, 238, 242];
  var CAT_RGB = { 'Fraud': [196, 38, 44], 'Review': [148, 87, 10], 'Legit': [22, 116, 63], 'Not enough information': [79, 85, 102] };
  var CAT_TINT = { 'Fraud': [251, 234, 235], 'Review': [250, 241, 228], 'Legit': [231, 243, 236], 'Not enough information': [238, 239, 242] };

  function renderPdf(J, rep) {
    var doc = new J({ unit: 'pt', format: 'a4', compress: true });
    var W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
    var M = 40, BOTTOM = 54, maxW = W - 2 * M, y = M;
    doc.setProperties({ title: rep.title + ' - ' + rep.fileName, creator: 'Payment Risk Checker (generated in the browser)' });

    function room(h) { if (y + h > H - BOTTOM) { doc.addPage(); y = M; } }
    function para(str, o) {
      var size = o.size || 9.5, lh = size * 1.35, indent = o.mark ? 10 : 0, c = o.color || INK;
      doc.setFont('helvetica', o.bold ? 'bold' : 'normal'); doc.setFontSize(size); doc.setTextColor(c[0], c[1], c[2]);
      doc.splitTextToSize(str, maxW - indent).forEach(function (line, i) {
        room(lh);
        if (o.mark && i === 0) doc.text(o.mark, M, y + size);
        doc.text(line, M + indent, y + size);
        y += lh;
      });
      y += o.after || 0;
    }
    function bullet(str) { para(str, { mark: '-', after: 2 }); }
    // `need` keeps a heading with the start of what follows (no orphan headings or table headers).
    function heading(str, need) { room(need || 70); y += 10; para(str, { size: 12.5, bold: true, after: 5 }); }
    function table(head, body, o) {
      o = o || {};
      doc.autoTable({
        startY: y, head: [head], body: body.map(function (r) { return r.cells || r; }),
        margin: { left: M, right: M, top: M, bottom: BOTTOM },
        tableWidth: o.width || 'auto', rowPageBreak: o.avoid ? 'avoid' : 'auto', theme: 'grid',
        styles: { font: 'helvetica', fontSize: o.small ? 7.5 : 8.5, cellPadding: 4, textColor: INK, lineColor: LINE, lineWidth: 0.5, valign: 'top', overflow: 'linebreak' },
        headStyles: { fillColor: HEAD_BG, textColor: INK, fontStyle: 'bold' },
        columnStyles: o.cols || {},
        didParseCell: function (d) {
          if (d.section !== 'body') return;
          var row = body[d.row.index];
          if (!row) return;
          if (row.total) d.cell.styles.fontStyle = 'bold';
          if (row.cat && d.column.index === 0) {
            d.cell.styles.textColor = CAT_RGB[row.cat]; d.cell.styles.fillColor = CAT_TINT[row.cat]; d.cell.styles.fontStyle = 'bold';
          }
        }
      });
      y = doc.lastAutoTable.finalY + 12;
    }

    para(rep.title, { size: 20, bold: true, after: 6 });
    rep.meta.forEach(function (m) { para(m[0] + ': ' + m[1], { size: 9, color: MUTED }); });

    heading('Summary');
    table(['Result', 'Rows', '% of rows', 'Amount'], rep.counts.concat([rep.total]),
      { width: 320, cols: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' } } });
    rep.summary.forEach(function (p) { para(p, { size: 10, after: 4 }); });
    if (rep.insights.length) { para('What your file tells you', { size: 9, bold: true, color: MUTED, after: 2 }); rep.insights.forEach(bullet); }

    if (rep.notes.length) { heading('File check notes'); rep.notes.forEach(bullet); }

    heading(rep.casesTitle);
    if (rep.cases.length) table(['Result', 'Rows', 'At stake', 'What happened and what to do'], rep.cases,
      { cols: { 0: { cellWidth: 72 }, 1: { cellWidth: 62 }, 2: { cellWidth: 64, halign: 'right' } } });
    else para('Nothing flagged. Run this again on each new export.', { color: MUTED, after: 4 });
    if (rep.neiNote) para(rep.neiNote, { size: 9, color: MUTED, after: 4 });

    if (rep.tips.length) { heading('What to do about it'); rep.tips.forEach(bullet); }
    if (rep.rules.length) {
      heading('Rule coverage');
      table(['ID', 'Check', 'Points', 'Fired'], rep.rules, { cols: { 0: { cellWidth: 36 }, 2: { cellWidth: 44, halign: 'right' }, 3: { cellWidth: 44, halign: 'right' } } });
    }

    heading(rep.tableTitle, 150);
    table(rep.head, rep.body, {
      small: true, avoid: true,
      cols: rep.risk
        ? { 0: { cellWidth: 56 }, 1: { cellWidth: 30, halign: 'right' }, 2: { cellWidth: 34 }, 3: { cellWidth: 64 }, 4: { cellWidth: 54 }, 5: { cellWidth: 50, halign: 'right' }, 6: { cellWidth: 58 } }
        : { 0: { cellWidth: 60 }, 1: { cellWidth: 36 }, 2: { cellWidth: 70 }, 3: { cellWidth: 54 }, 4: { cellWidth: 54, halign: 'right' }, 5: { cellWidth: 58 } }
    });

    var n = doc.getNumberOfPages();
    for (var i = 1; i <= n; i++) {
      doc.setPage(i);
      doc.setDrawColor(LINE[0], LINE[1], LINE[2]); doc.setLineWidth(0.5); doc.line(M, H - 42, W - M, H - 42);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
      doc.text(doc.splitTextToSize(DISCLAIMER, maxW - 80), M, H - 31);
      doc.text('Page ' + i + ' of ' + n, W - M, H - 31, { align: 'right' });
    }
    return doc;
  }

  var pdfLib = null;
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.async = false;
      s.onload = function () { resolve(); };
      s.onerror = function () { s.remove(); reject(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
  }
  // Loaded from this site on the first PDF click only; the promise is cached (and dropped on failure so a later click can retry).
  function loadPdfLib() {
    if (!pdfLib) {
      pdfLib = loadScript(PDF_LIBS[0]).then(function () { return loadScript(PDF_LIBS[1]); }).then(function () {
        var J = window.jspdf && window.jspdf.jsPDF;
        if (!J || !J.API || typeof J.API.autoTable !== 'function') throw new Error('PDF library incomplete');
        return J;
      });
      pdfLib.catch(function () { pdfLib = null; });
    }
    return pdfLib;
  }

  var pdfBusy = false;
  function setPdfBusy(on) {
    pdfBusy = on;
    document.querySelectorAll('.rc-pdf').forEach(function (b) {
      b.disabled = on;
      b.textContent = on ? 'Preparing PDF…' : 'Download results (PDF)';
    });
  }

  function showDlMsg(text, kind) {
    var el = $('#rc-dl-msg'), box;
    setMsg(el, text, kind);
    box = el.getBoundingClientRect();
    if (box.top < 0 || box.bottom > window.innerHeight) el.scrollIntoView({ behavior: 'auto', block: 'center' });
  }

  function downloadPdf() {
    if (!state.analysis || pdfBusy) return;
    var rep = buildReport(), bad = firstUndrawable(rep), name = resultsFileName('pdf');
    if (bad) {
      printReport('This file has characters the PDF\'s built-in font can\'t show (for example “' + bad + '”, U+' +
        bad.codePointAt(0).toString(16).toUpperCase() + ')', rep);
      return;
    }
    setPdfBusy(true);
    setMsg($('#rc-dl-msg'), 'Preparing the PDF…');
    loadPdfLib().then(function (J) {
      var pages;
      try {
        var doc = renderPdf(J, rep);
        pages = doc.getNumberOfPages();
        saveBlob(doc.output('blob'), name);
      } catch (err) {
        setPdfBusy(false);
        printReport('Something went wrong while building the PDF', rep);
        return;
      }
      setPdfBusy(false);
      showDlMsg('Download started: ' + name + ' (' + rep.body.length.toLocaleString() + ' rows, ' + pages + ' page' + (pages > 1 ? 's' : '') +
        '). Look in your browser\'s Downloads folder. If nothing appears, press Ctrl/Cmd+P and choose “Save as PDF”.', 'ok');
    }, function () {
      setPdfBusy(false);
      printReport('The PDF tool couldn\'t be loaded', rep);
    });
  }
  document.querySelectorAll('.rc-pdf').forEach(function (b) { b.addEventListener('click', downloadPdf); });

  /* Print fallback: a print-only copy of the same report (all rows), forced to the light theme by the print stylesheet. */

  function printHtml(rep) {
    function cell(c) { return esc(c).replace(/\n/g, '<br>'); }
    function tbl(head, body, cls) {
      return '<table class="' + cls + '"><thead><tr>' + head.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
        body.map(function (r) {
          return '<tr' + (r.total ? ' class="rp-total"' : '') + '>' + (r.cells || r).map(function (c, i) {
            return '<td' + (i === 0 && r.cat ? ' class="rp-cat rp-' + CHIP[r.cat].cls + '"' : '') + '>' + cell(c) + '</td>';
          }).join('') + '</tr>';
        }).join('') + '</tbody></table>';
    }
    function list(items) { return '<ul>' + items.map(function (i) { return '<li>' + esc(i) + '</li>'; }).join('') + '</ul>'; }
    var h = '<h1>' + esc(rep.title) + '</h1><dl class="rp-meta">' +
      rep.meta.map(function (m) { return '<div><dt>' + esc(m[0]) + ':</dt><dd>' + esc(m[1]) + '</dd></div>'; }).join('') + '</dl>' +
      '<p class="rp-fine">' + esc(DISCLAIMER) + '</p>';
    h += '<h2>Summary</h2>' + tbl(['Result', 'Rows', '% of rows', 'Amount'], rep.counts.concat([rep.total]), 'rp-counts');
    h += rep.summary.map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('');
    if (rep.insights.length) h += '<h3>What your file tells you</h3>' + list(rep.insights);
    if (rep.notes.length) h += '<h2>File check notes</h2>' + list(rep.notes);
    h += '<h2>' + esc(rep.casesTitle) + '</h2>' + (rep.cases.length
      ? tbl(['Result', 'Rows', 'At stake', 'What happened and what to do'], rep.cases, 'rp-cases')
      : '<p>Nothing flagged. Run this again on each new export.</p>');
    if (rep.neiNote) h += '<p class="rp-fine">' + esc(rep.neiNote) + '</p>';
    if (rep.tips.length) h += '<h2>What to do about it</h2>' + list(rep.tips);
    if (rep.rules.length) h += '<h2>Rule coverage</h2>' + tbl(['ID', 'Check', 'Points', 'Fired'], rep.rules, 'rp-rules');
    h += '<h2>' + esc(rep.tableTitle) + '</h2>' + tbl(rep.head, rep.body, 'rp-rows' + (rep.risk ? ' rp-risk' : ''));
    h += '<p class="rp-fine">' + esc(DISCLAIMER) + '</p>';
    return h;
  }

  function fillPrint(rep) {
    $('#rc-print').innerHTML = printHtml(rep);
    document.body.classList.add('rc-print-report');
  }

  function printReport(reason, rep) {
    if (typeof window.print !== 'function') {
      showDlMsg(reason + ', and this browser can\'t print. Use “Download results (CSV)” instead.', 'error');
      return;
    }
    fillPrint(rep);
    showDlMsg(reason + ', so your browser\'s print dialog opened instead. Choose “Save as PDF” as the printer to save the same report.', 'warn');
    setTimeout(function () { window.print(); }, 80);
  }

  // Ctrl/Cmd+P on the results prints the same report.
  window.addEventListener('beforeprint', function () {
    if (state.analysis && !$('#rc-step-results').hidden && !document.body.classList.contains('rc-print-report')) fillPrint(buildReport());
  });
  window.addEventListener('afterprint', function () {
    document.body.classList.remove('rc-print-report');
    $('#rc-print').innerHTML = '';
  });

  /* ------------------------------------------------------------ rules table */

  $('#rc-rules-table').innerHTML = '<thead><tr><th>ID</th><th>Check</th><th>Points</th><th>What it looks for</th></tr></thead><tbody>' +
    E.RULES.map(function (r) {
      return '<tr><td>' + r.id + '</td><td>' + esc(r.name) + '</td><td>' + (r.points === 100 ? 'Fraud' : '+' + r.points) + '</td><td>' + esc(r.desc) + '</td></tr>';
    }).join('') + '</tbody>';

  syncMode();
})();
