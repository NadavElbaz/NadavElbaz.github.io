/*
 * Payment Risk Checker — scoring engine.
 * Pure functions, no DOM. Everything runs in the visitor's browser; no data leaves it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RiskEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CATEGORIES = ['Fraud', 'Review', 'Legit', 'Not enough information'];
  var DEFAULT_THRESHOLDS = { fraud: 60, review: 30 };
  var MIN_EVALUABLE = 4;      // a row needs at least this many checks to be judged Legit
  var MIN_BASELINE_ROWS = 20; // amount-based checks compare against the file's median
  var MIN_ROWS = MIN_BASELINE_ROWS; // intake blocks below this many usable payments
  var STEADY_ROWS = 50;       // below this, intake adds a "results get steadier" note
  var MIN_PARSE_SHARE = 0.8;  // a mapped Amount/Date column must read for at least this share of values
  var MAX_FIX_CELLS = 50;     // inline "fix it here" covers at most this many cells
  var MAX_ROWS = 50000;
  var MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  var IDENTITY_KEYS = ['first_name', 'last_name', 'customer_name', 'email', 'card_last4'];

  /* ---------------------------------------------------------------- messages */

  // Every user-facing intake string lives in MESSAGES. Codes are stable: test data and the UI refer to them.
  // level: block (Analyze stays off) | warn | info | ok.  action: which "Fix it here" tool the UI offers.
  function rowsText(list, max) {
    max = max || 3;
    var shown = list.slice(0, max).join(', ');
    return list.length > max ? shown + ' and ' + (list.length - max) + ' more' : shown;
  }
  function qt(s) { s = String(s == null ? '' : s); return '"' + (s.length > 30 ? s.slice(0, 29) + '…' : s) + '"'; }
  function nOf(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function names(list) { return list.map(function (s) { return qt(s.name); }).join(', '); }
  function orderWord(o) { return o === 'dmy' ? 'day-first' : 'month-first'; }

  var MESSAGES = {
    /* ---- blocking: file shape (checked at upload) */
    EMPTY: { level: 'block', action: 'sample', fix: 'Try the sample file',
      title: function () { return 'This file is empty'; },
      text: function () { return 'We found no column names and no payments in it. Export your payments again, or try the sample file to see the expected shape.'; } },
    ONE_COLUMN: { level: 'block', action: 'separator', fix: 'Read it again',
      title: function () { return 'We only found 1 column'; },
      text: function (d) {
        return 'Every line was read as a single column (' + qt(d.header) + '), so the file probably uses a separator we don\'t read. We read comma, semicolon and tab' +
          (d.guess ? '; this file looks like it uses ' + d.guess + '.' : '.') + ' Pick the separator below and read it again, or export the file again as a comma-separated CSV.';
      } },
    HEADER_ONLY: { level: 'block', action: 'paste', fix: 'Add rows here',
      title: function () { return 'No payment rows'; },
      text: function (d) { return 'We found ' + nOf(d.count, 'column name') + ' (' + d.headers + ') but no payment rows under them. Export again with a date range that has payments, or paste rows here.'; } },
    /* ---- blocking: columns */
    NO_AMOUNT: { level: 'block', action: 'map:amount', fix: 'Choose the amount column',
      title: function () { return 'You don\'t have an amount column'; },
      text: function (d) { return 'None of your ' + d.cols + ' columns is matched to Amount (what the customer paid).' + (d.suggest.length ? ' Columns that look like amounts: ' + names(d.suggest) + '.' : ' None of them look like amounts, so the file may need exporting again with an amount column.'); } },
    AMOUNT_NOT_NUMERIC: { level: 'block', action: 'map:amount', fix: 'Choose another column',
      title: function () { return 'The Amount column doesn\'t hold amounts'; },
      text: function (d) {
        var s = d.suggest.length ? ' Columns that look like amounts: ' + names(d.suggest) + '.' : '';
        if (!d.n) return 'The column you picked for Amount (' + qt(d.column) + ') is empty in every payment row.' + s;
        return 'Only ' + d.ok + ' of ' + d.n + ' values in ' + qt(d.column) + ' (' + d.pct + '%) read as an amount, e.g. ' + rowsText(d.examples.map(qt), 3) + ' don\'t. At least ' + Math.round(MIN_PARSE_SHARE * 100) + '% need to read for the column to count.' + s;
      } },
    NO_DATE: { level: 'block', action: 'map:date', fix: 'Choose the date column',
      title: function () { return 'You don\'t have a date column'; },
      text: function (d) { return 'None of your ' + d.cols + ' columns is matched to Date (when each payment happened).' + (d.suggest.length ? ' Columns that look like dates: ' + names(d.suggest) + '.' : ' None of them look like dates, so the file may need exporting again with a date column.'); } },
    DATE_UNREADABLE: { level: 'block', action: 'map:date', fix: 'Choose another column',
      title: function () { return 'The Date column doesn\'t hold dates we can read'; },
      text: function (d) {
        var s = d.suggest.length ? ' Columns that look like dates: ' + names(d.suggest) + '.' : '';
        if (!d.n) return 'The column you picked for Date (' + qt(d.column) + ') is empty in every payment row.' + s;
        return 'Only ' + d.ok + ' of ' + d.n + ' values in ' + qt(d.column) + ' (' + d.pct + '%) read as a date, e.g. ' + rowsText(d.examples.map(qt), 3) + ' don\'t. We read 2026-10-28, 10/28/2026, 28/10/2026 and 28.10.2026, with an optional time.' +
          (d.forced ? ' You chose ' + orderWord(d.order) + ' dates; switching back to automatic may help.' : '') + s;
      } },
    NO_CUSTOMER: { level: 'block', action: 'map:customer', fix: 'Choose a customer column',
      title: function (d) { return d.empty ? 'Your customer columns are empty' : 'You don\'t have a customer column'; },
      text: function (d) {
        return (d.empty ? 'The customer column' + (d.columns.length > 1 ? 's' : '') + ' you picked (' + d.columns.map(qt).join(', ') + ') ' + (d.columns.length > 1 ? 'are' : 'is') + ' blank in every payment row. ' : '') +
          'Match at least one of: first name, last name, full name, email or card last 4. Without one we can\'t tell repeat customers apart, so the repeat-payment and failed-attempt checks can\'t run.';
      } },
    TOO_FEW_ROWS: { level: 'block', action: 'paste', fix: 'Add rows here', runAnyway: 'Run anyway (comparison checks off)',
      title: function (d) { return 'You don\'t have enough payments to compare (found ' + d.usable + ', need ' + MIN_ROWS + ')'; },
      text: function (d) {
        return 'Found ' + nOf(d.usable, 'usable payment') + ', need ' + MIN_ROWS + ' to compare each one against the rest of your file.' +
          (d.failed ? ' Plus ' + nOf(d.failed, 'failed attempt') + ', which don\'t count.' : '') +
          (d.breakdown ? ' Also not counted: ' + d.breakdown + '.' : '') +
          ' Upload a longer date range, or add rows from another export here.';
      } },
    LOW_COVERAGE: { level: 'block', action: 'map:any', fix: 'Choose another column',
      title: function (d) { return 'Not enough checks can run (only ' + d.active + ' of ' + d.total + ')'; },
      text: function (d) {
        return 'A payment needs at least ' + MIN_EVALUABLE + ' checks to be judged, so with these columns every row would come out "Not enough information".' +
          (d.add.length ? ' Match one more of: ' + d.add.join(', ') + '.' : '') +
          (d.noTimes ? ' Times of day in the date column would also help.' : '');
      } },
    /* ---- warnings: analysis can continue */
    CUSTOMER_SPARSE: { level: 'warn', action: 'map:customer', fix: 'Choose another customer column',
      title: function (d) { return 'Only ' + d.withCustomer + ' of ' + d.usable + ' payments say who paid'; },
      text: function (d) {
        return 'The other ' + d.without + ' (e.g. ' + (d.lines.length === 1 ? 'row ' : 'rows ') + rowsText(d.lines, 3) + ') have no name, email or card last 4, so the repeat-customer checks (many payments in a short time, burst of failed attempts, same amount repeated) skip them. If another column holds the customer, match it too.';
      } },
    ROWS_UNREADABLE: { level: 'warn', action: 'fixgrid', fix: 'Fix these rows',
      title: function (d) { return nOf(d.rows, 'payment has', 'payments have') + ' an amount or date we can\'t read'; },
      text: function (d) {
        return (d.rows === 1 ? 'It will' : 'They will') + ' show as "Not enough information": ' + rowsText(d.items, 4) + '.' +
          (d.cells > MAX_FIX_CELLS ? ' You can fix the first ' + MAX_FIX_CELLS + ' values here; for the rest, correct the export and upload it again.' : ' You can fix ' + (d.cells === 1 ? 'it' : 'them') + ' here.');
      } },
    TOTALS_SKIPPED: { level: 'warn', action: 'include-totals', fix: function (d) { return d.items.length === 1 ? 'Count it as a payment' : 'Count them as payments'; },
      title: function (d) { return d.items.length === 1 ? 'Totals row left out' : d.items.length + ' totals rows left out'; },
      text: function (d) { return rowsText(d.items, 4) + (d.items.length === 1 ? ' looks' : ' look') + ' like a total, not a payment, so ' + (d.items.length === 1 ? 'it isn\'t' : 'they aren\'t') + ' checked or counted.'; } },
    TOTALS_INCLUDED: { level: 'warn', action: 'exclude-totals', fix: 'Leave totals out again',
      title: function (d) { return nOf(d.items.length, 'possible totals row') + ' counted as ' + (d.items.length === 1 ? 'a payment' : 'payments') + ' (your choice)'; },
      text: function (d) { return rowsText(d.items, 4) + '. If ' + (d.items.length === 1 ? 'it is' : 'they are') + ' really a total, the median and every comparison will be off.'; } },
    REFUNDS_SKIPPED: { level: 'info',
      title: function (d) { return nOf(d.items.length, 'refund or zero/negative amount', 'refunds or zero/negative amounts') + ' left out'; },
      text: function (d) { return rowsText(d.items, 5) + '. Money going back out isn\'t checked for fraud.'; } },
    HEADER_REPEATED: { level: 'info',
      title: function (d) { return nOf(d.lines.length, 'row repeats', 'rows repeat') + ' the column names'; },
      text: function (d) { return 'Row ' + rowsText(d.lines, 4) + ' look' + (d.lines.length === 1 ? 's' : '') + ' like the header line again (common when exports are joined) and ' + (d.lines.length === 1 ? 'was' : 'were') + ' skipped.'; } },
    NO_TIMES: { level: 'info',
      title: function () { return 'No times of day'; },
      text: function () { return 'Most dates have no time, so the "made in the small hours" check is off.'; } },
    DATE_AMBIGUOUS: { level: 'warn', action: 'date-order', fix: '',
      title: function () { return 'Day or month first?'; },
      text: function (d) {
        return 'Every date in the file, like ' + qt(d.example) + ', could be read either way. We\'re reading them ' + orderWord(d.order) + ', so that one is ' + d.reading + '. Switch below if that\'s wrong.';
      } },
    DATE_DAY_FIRST: { level: 'info', action: 'date-order', fix: '',
      title: function () { return 'Reading dates day-first'; },
      text: function (d) { return qt(d.example) + ' only makes sense day-first, so every date in the file is read that way.'; } },
    DATE_ORDER_OVERRIDE: { level: 'warn', action: 'date-order', fix: '',
      title: function (d) { return 'Reading dates ' + orderWord(d.order) + ' (your choice)'; },
      text: function (d) { return 'The file itself suggests ' + orderWord(d.inferred) + (d.example ? ' (e.g. ' + qt(d.example) + ')' : '') + '. Dates that don\'t fit your choice show up as unreadable.'; } },
    FEW_ROWS_NOTE: { level: 'info',
      title: function (d) { return d.usable + ' usable payments'; },
      text: function () { return 'That\'s enough to run, but results get steadier with ' + STEADY_ROWS + ' or more payments.'; } },
    TRUNCATED: { level: 'warn',
      title: function () { return 'File cut short'; },
      text: function () { return 'Only the first ' + MAX_ROWS.toLocaleString('en-US') + ' rows are used. Export a shorter date range to check the rest.'; } },
    EDITED: { level: 'info', action: 'undo-edits', fix: 'Undo my edits',
      title: function (d) { return nOf(d.n, 'value', 'values') + ' edited here'; },
      text: function () { return 'Used for this analysis only, kept in this browser tab, and marked in the results file (edited_here column).'; } },
    ADDED: { level: 'info', action: 'undo-added', fix: 'Remove the added rows',
      title: function (d) { return nOf(d.n, 'row') + ' added here'; },
      text: function () { return 'Pasted or added from another file. Kept in this browser tab only, and marked "added here" in the results file.'; } },
    FILE_OK: { level: 'ok',
      title: function (d) { return 'File looks good: ' + nOf(d.usable, 'payment') + ' to check'; },
      text: function () { return 'Press "Analyze payments" when the column match looks right.'; } },
    /* ---- upload, append and results notes */
    UPLOAD_SPREADSHEET: { level: 'block', title: function () { return 'That looks like a spreadsheet file'; },
      text: function () { return 'In your spreadsheet app choose File → Export / Save as → CSV, then upload that.'; } },
    UPLOAD_TOO_BIG: { level: 'block', title: function () { return 'That file is over 10 MB'; },
      text: function () { return 'Export a shorter date range and try again.'; } },
    UPLOAD_UNREADABLE: { level: 'block', title: function () { return 'Could not read that file'; },
      text: function () { return 'Try exporting it again, or choose a different file.'; } },
    APPEND_EMPTY: { level: 'block', title: function () { return 'Nothing to add'; },
      text: function () { return 'We found no rows in what you added.'; } },
    APPEND_COLUMNS: { level: 'block', title: function () { return 'Those rows don\'t match your columns'; },
      text: function (d) { return 'They have ' + nOf(d.found, 'column') + ' but your file has ' + d.need + '. Add rows with the same columns in the same order, or include the header line so we can line them up.'; } },
    APPEND_LIMIT: { level: 'block', title: function () { return 'File is full'; },
      text: function () { return 'The file already has ' + MAX_ROWS.toLocaleString('en-US') + ' rows, the most we read.'; } },
    APPEND_OK: { level: 'ok', title: function (d) { return 'Added ' + nOf(d.added, 'row'); },
      text: function (d) { return 'They\'re numbered from row ' + d.from + ' on' + (d.byHeader ? ', lined up by column name' : '') + (d.cut ? '. Some were left out because the file reached ' + MAX_ROWS.toLocaleString('en-US') + ' rows' : '') + '.'; } },
    RUN_ANYWAY_NOTE: { level: 'warn', action: 'undo-run-anyway', fix: 'Undo run anyway', title: function (d) { return (d.done ? 'Ran' : 'Running') + ' with too few payments'; },
      text: function (d) { return 'Only ' + d.usable + ' usable payment' + (d.usable === 1 ? '' : 's') + ', so the checks that compare against your median (unusually large amount, large online payment, large bank payment) are off.'; } }
  };

  function message(code, d) {
    var m = MESSAGES[code], data = d || {};
    var fix = typeof m.fix === 'function' ? m.fix(data) : (m.fix || '');
    return { code: code, level: m.level, title: m.title(data), text: m.text(data), fix: fix, action: m.action || '', runAnyway: m.runAnyway || '', data: data };
  }
  /* ------------------------------------------------------------------ fields */

  var FIELDS = [
    { key: 'amount', group: 'required', label: 'Amount', required: true, hint: 'What the customer paid (before fees)',
      aliases: ['amount', 'paymentamount', 'amountpaid', 'transactionamount', 'grossamount', 'gross', 'total', 'amt', 'sum'] },
    { key: 'date', group: 'required', label: 'Date & time', required: true, hint: 'When the payment happened',
      aliases: ['date', 'datetime', 'createdat', 'created', 'paidat', 'paymentdate', 'transactiondate', 'timestamp', 'time', 'paiddate'] },
    { key: 'first_name', group: 'who', label: 'First name', hint: 'Used to recognize repeat customers',
      aliases: ['firstname', 'first', 'givenname', 'fname'] },
    { key: 'last_name', group: 'who', label: 'Last name', hint: '',
      aliases: ['lastname', 'last', 'surname', 'familyname', 'lname'] },
    { key: 'customer_name', group: 'who', label: 'Customer (full name)', hint: 'Only if first and last name are one column',
      aliases: ['customer', 'customername', 'client', 'clientname', 'name', 'fullname', 'payer', 'payername'] },
    { key: 'email', group: 'who', label: 'Customer email', hint: 'Strongest way to recognize a customer',
      aliases: ['email', 'customeremail', 'emailaddress', 'clientemail', 'payeremail'] },
    { key: 'payment_type', group: 'how', label: 'Payment type', hint: 'Card, bank transfer (ACH), check, cash',
      aliases: ['transactiontype', 'paymenttype', 'paymentmethod', 'tender', 'instrument', 'type', 'method'] },
    { key: 'channel', group: 'how', label: 'Channel', hint: 'How it was collected: client portal, technician app, office',
      aliases: ['transactionmethod', 'channel', 'source', 'origin', 'collectedvia', 'collectedby', 'platform'] },
    { key: 'status', group: 'how', label: 'Status', hint: 'Paid, failed, disputed, refunded…',
      aliases: ['status', 'paymentstatus', 'state', 'result', 'outcome'] },
    { key: 'card_last4', group: 'how', label: 'Card last 4 digits', hint: 'Only the last 4 digits are ever used',
      aliases: ['last4', 'cardlast4', 'cardlastfour', 'card', 'cardnumber', 'lastfour'] },
    { key: 'job_id', group: 'links', label: 'Job ID', hint: '',
      aliases: ['jobid', 'job', 'jobnumber', 'workorder', 'workorderid'] },
    { key: 'invoice_id', group: 'links', label: 'Invoice ID', hint: '',
      aliases: ['invoiceid', 'invoice', 'invoicenumber'] },
    { key: 'estimate_id', group: 'links', label: 'Estimate ID', hint: '',
      aliases: ['estimateid', 'estimate', 'estimatenumber', 'quoteid', 'quote'] },
    { key: 'card_country', group: 'where', label: 'Card country', hint: 'Where the card was issued',
      aliases: ['cardcountry', 'issuercountry', 'bincountry'] },
    { key: 'ip_country', group: 'where', label: 'Payment country (IP)', hint: 'Where the payment came from',
      aliases: ['ipcountry', 'ipaddresscountry', 'geoipcountry'] }
  ];
  var FIELD_BY_KEY = {};
  FIELDS.forEach(function (f) { FIELD_BY_KEY[f.key] = f; });

  var GROUP_LABELS = {
    required: 'Required',
    who: 'Who paid',
    how: 'How it was paid',
    links: 'Linked records',
    where: 'Location (usually only in processor exports)'
  };

  /* --------------------------------------------------------------------- CSV */

  var AUTO_DELIMITERS = [',', ';', '\t'];          // detected automatically
  var DELIMITERS = [',', ';', '\t', '|'];          // the user can also pick these when detection fails
  var DELIMITER_NAMES = { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe (|)' };

  function firstLine(text) {
    var lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) { if (lines[i].trim().length) return lines[i]; }
    return '';
  }

  function countOutsideQuotes(line, d) {
    var n = 0, inQ = false;
    for (var j = 0; j < line.length; j++) {
      var c = line[j];
      if (c === '"') inQ = !inQ;
      else if (c === d && !inQ) n++;
    }
    return n;
  }

  function detectDelimiter(text) {
    var first = firstLine(text), best = ',', bestN = -1;
    AUTO_DELIMITERS.forEach(function (d) {
      var n = countOutsideQuotes(first, d);
      if (n > bestN) { bestN = n; best = d; }
    });
    return best;
  }

  function stripBom(text) { return String(text == null ? '' : text).replace(/^﻿/, ''); }
  function nonBlank(r) { return r.some(function (x) { return String(x).trim() !== ''; }); }

  // Splits CSV text into records (quote-aware: commas, quotes and line breaks inside quoted fields).
  // Returns the non-blank records with their record number (1 = header line).
  function tokenize(text, delim) {
    var records = [], row = [], field = '', inQ = false, i = 0, n = text.length;
    while (i < n) {
      var c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQ = true; i++; continue; }
      if (c === delim) { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); records.push(row); row = []; field = ''; i++; continue; }
      field += c; i++;
    }
    if (field.length || row.length) { row.push(field); records.push(row); }
    var kept = [];
    records.forEach(function (r, idx) { if (nonBlank(r)) kept.push({ r: r, line: idx + 1 }); });
    return kept;
  }

  // delimOverride lets the user pick the separator when detection reads everything as one column.
  function parseCSV(text, delimOverride) {
    text = stripBom(text);
    var delim = DELIMITERS.indexOf(delimOverride) !== -1 ? delimOverride : detectDelimiter(text);
    var kept = tokenize(text, delim);
    if (!kept.length) return { headers: [], rows: [], lineNumbers: [], headerLine: 0, delimiter: delim, truncated: false, added: {} };

    var headers = kept[0].r.map(function (h) { return String(h).trim(); });
    var body = kept.slice(1);
    var truncated = body.length > MAX_ROWS;
    if (truncated) body = body.slice(0, MAX_ROWS);
    var rows = body.map(function (k) {
      var a = k.r.slice(0, headers.length);
      while (a.length < headers.length) a.push('');
      return a;
    });
    return { headers: headers, rows: rows, lineNumbers: body.map(function (k) { return k.line; }), headerLine: kept[0].line, delimiter: delim, truncated: truncated, added: {} };
  }

  // File-shape problems that make column matching meaningless. Returns a message or null.
  function checkShape(parsed) {
    if (!parsed || !parsed.headers.length) return message('EMPTY');
    if (parsed.headers.length < 2) {
      var h = parsed.headers[0] || '', guess = '';
      ['|', ':', '^', '~'].forEach(function (d) { if (!guess && countOutsideQuotes(h, d) > 0) guess = d; });
      return message('ONE_COLUMN', { header: h, guess: guess ? (DELIMITER_NAMES[guess] || '"' + guess + '"') : '', guessDelim: guess });
    }
    if (!parsed.rows.length) {
      var hs = parsed.headers.filter(Boolean);
      return message('HEADER_ONLY', { count: parsed.headers.length, headers: hs.slice(0, 3).join(', ') + (hs.length > 3 ? '…' : '') });
    }
    return null;
  }

  // Adds rows pasted by the user or read from a second export. Pure: returns a new parsed object.
  // Rows that start with a header line are lined up by column name; otherwise they must have the same columns in order.
  function appendRows(parsed, text) {
    text = stripBom(text);
    if (!text.trim()) return { error: message('APPEND_EMPTY') };
    var need = parsed.headers.length;
    var recs = tokenize(text, detectDelimiter(text));
    if (recs.length && recs[0].r.length < 2 && parsed.delimiter) {
      var alt = tokenize(text, parsed.delimiter);
      if (alt.length && alt[0].r.length > recs[0].r.length) recs = alt;
    }
    if (!recs.length) return { error: message('APPEND_EMPTY') };

    var baseNorm = parsed.headers.map(norm);
    var firstNorm = recs[0].r.map(function (h) { return norm(String(h).trim()); });
    var named = baseNorm.filter(Boolean).length;
    var hits = firstNorm.filter(function (h) { return h && baseNorm.indexOf(h) !== -1; }).length;
    var colMap = null;
    if (hits >= Math.max(2, Math.ceil(named / 2))) {
      colMap = baseNorm.map(function (h) { return h ? firstNorm.indexOf(h) : -1; });
      recs = recs.slice(1);
      if (!recs.length) return { error: message('APPEND_EMPTY') };
    } else if (recs[0].r.length !== need) {
      return { error: message('APPEND_COLUMNS', { found: recs[0].r.length, need: need }) };
    }

    var room = MAX_ROWS - parsed.rows.length;
    if (room <= 0) return { error: message('APPEND_LIMIT') };
    var add = recs.slice(0, room).map(function (k) {
      var a = colMap ? colMap.map(function (i) { return i >= 0 && i < k.r.length ? k.r[i] : ''; }) : k.r.slice(0, need);
      while (a.length < need) a.push('');
      return a;
    });
    var maxLine = parsed.headerLine || 1;
    parsed.lineNumbers.forEach(function (l) { if (l > maxLine) maxLine = l; });
    var cut = recs.length > room;
    var added = {};
    Object.keys(parsed.added || {}).forEach(function (k) { added[k] = true; });
    for (var j = 0; j < add.length; j++) added[parsed.rows.length + j] = true;
    return {
      parsed: {
        headers: parsed.headers, rows: parsed.rows.concat(add),
        lineNumbers: parsed.lineNumbers.concat(add.map(function (_, k) { return maxLine + k + 1; })),
        headerLine: parsed.headerLine, delimiter: parsed.delimiter, truncated: parsed.truncated || cut, added: added
      },
      added: add.length,
      note: message('APPEND_OK', { added: add.length, from: maxLine + 1, byHeader: !!colMap, cut: cut })
    };
  }

  // In-memory "fix it here" overlay. edits = { 'rowIndex:colIndex': 'new text' }. Returns a new parsed
  // object with the edited cells swapped in; the uploaded data itself is never changed.
  function applyEdits(parsed, edits) {
    var keys = Object.keys(edits || {});
    if (!keys.length) return parsed;
    var rows = parsed.rows.slice(), edited = {};
    keys.forEach(function (k) {
      var p = k.split(':'), r = +p[0], c = +p[1];
      if (!(r >= 0 && r < rows.length && c >= 0 && c < parsed.headers.length)) return;
      if (!edited[r]) { edited[r] = []; rows[r] = rows[r].slice(); }
      rows[r][c] = String(edits[k]);
      edited[r].push(c);
    });
    var out = {};
    Object.keys(parsed).forEach(function (k) { out[k] = parsed[k]; });
    out.rows = rows; out.edited = edited;
    return out;
  }

  /* ------------------------------------------------------------ cell parsing */

  function parseAmount(s) {
    if (s == null) return NaN;
    var t = String(s).trim();
    if (!t) return NaN;
    var neg = false;
    if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
    t = t.replace(/[^\d.,\-]/g, '');
    if (t.indexOf('-') !== -1) { neg = true; t = t.replace(/-/g, ''); }
    var hasC = t.indexOf(',') !== -1, hasD = t.indexOf('.') !== -1;
    if (hasC && hasD) {
      if (t.lastIndexOf(',') > t.lastIndexOf('.')) t = t.replace(/\./g, '').replace(',', '.');
      else t = t.replace(/,/g, '');
    } else if (hasC) {
      if (/^\d{1,3}(,\d{3})+$/.test(t)) t = t.replace(/,/g, '');
      else if (/,\d{1,2}$/.test(t)) t = t.replace(',', '.');
      else t = t.replace(/,/g, '');
    }
    if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return NaN;
    var v = parseFloat(t);
    return neg ? -v : v;
  }

  // Times are read as written (no timezone shifting) so "3am" stays 3am.
  // order: 'mdy' (default) or 'dmy'. It is decided once per file (see dateOrderInfo), never per row,
  // so "03/04" means the same thing on every row.
  var SLASH_DATE_RE = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/;
  function parseDate(s, order) {
    var t = String(s == null ? '' : s).trim();
    if (!t) return null;
    var y, mo, d, h = 0, mi = 0, se = 0, clock = false, m;
    m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2})?$/);
    if (m) {
      y = +m[1]; mo = +m[2]; d = +m[3];
      if (m[4] !== undefined) { h = +m[4]; mi = +m[5]; se = +(m[6] || 0); clock = true; }
    } else {
      m = t.match(SLASH_DATE_RE);
      if (!m || m[3].length === 3) return null;
      var a = +m[1], b = +m[2];
      y = +m[3]; if (y < 100) y += 2000;
      if (order === 'dmy') { d = a; mo = b; } else { mo = a; d = b; }
      if (m[4] !== undefined) {
        h = +m[4]; mi = +m[5]; se = +(m[6] || 0); clock = true;
        if (m[7]) {
          var p = m[7].toLowerCase();
          if (p === 'pm' && h < 12) h += 12;
          if (p === 'am' && h === 12) h = 0;
        }
      }
    }
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
    var ts = Date.UTC(y, mo - 1, d, h, mi, se);
    if (new Date(ts).getUTCMonth() !== mo - 1) return null; // e.g. Feb 31
    return { ts: ts, hour: h, minute: mi, hasClock: clock && !(h === 0 && mi === 0 && se === 0) };
  }

  function formatDate(date) {
    if (!date) return '';
    var d = new Date(date.ts), p = function (n) { return (n < 10 ? '0' : '') + n; };
    var s = d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
    return date.hasClock ? s + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) : s;
  }

  var moneyFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function formatMoney(n, currency) {
    if (!isFinite(n)) return '';
    var s = moneyFmt.format(Math.abs(n));
    return (n < 0 ? '-' : '') + (currency || '') + s;
  }

  /* ----------------------------------------------------------------- mapping */

  function norm(h) { return String(h).toLowerCase().replace(/[^a-z0-9]/g, ''); }

  function guessMapping(headers) {
    var nh = headers.map(norm), cands = [];
    FIELDS.forEach(function (f) {
      nh.forEach(function (h, idx) {
        if (!h) return;
        var best = 0;
        f.aliases.forEach(function (a) {
          if (h === a) best = Math.max(best, 100);
          else if (a.length >= 5 && h.indexOf(a) !== -1 && !/^total/.test(h)) best = Math.max(best, 55);
        });
        if (best) cands.push({ key: f.key, idx: idx, score: best });
      });
    });
    cands.sort(function (a, b) { return b.score - a.score || a.idx - b.idx; });
    var usedF = {}, usedH = {}, mapping = {}, auto = {};
    FIELDS.forEach(function (f) { mapping[f.key] = -1; });
    cands.forEach(function (c) {
      if (usedF[c.key] || usedH[c.idx]) return;
      usedF[c.key] = true; usedH[c.idx] = true;
      mapping[c.key] = c.idx; auto[c.key] = true;
    });
    // A full-name column is redundant once first and last name were found.
    if (mapping.first_name !== -1 && mapping.last_name !== -1 && mapping.customer_name !== -1) {
      mapping.customer_name = -1; delete auto.customer_name;
    }
    return { mapping: mapping, auto: auto };
  }

  /* ----------------------------------------------------------------- records */

  var FAILED_RE = /fail|declin|denied|reject|error/;
  var BAD_RE = /disput|charge\s*back|fraud|return|revers|nsf/;
  var REFUND_RE = /refund/;
  var DISPOSABLE = ['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org', 'yopmail.com',
    'trashmail.com', 'sharklasers.com', 'getnada.com', 'dispostable.com', 'maildrop.cc', 'throwawaymail.com'];

  function hasAny(mapping, keys) { return keys.some(function (k) { return mapping[k] >= 0; }); }

  var TOTAL_LABEL_RE = /^(grand\s*|sub\s*)?(totals?|sum)\s*:?$/i;

  // Day/month order is decided once for the whole file: if any d/m/y value starts with a number above 12
  // the file is day-first, otherwise month-first. opts.dateOrder ('dmy' | 'mdy') overrides it.
  function dateOrderInfo(parsed, mapping, opts) {
    var forced = opts && (opts.dateOrder === 'dmy' || opts.dateOrder === 'mdy') ? opts.dateOrder : '';
    var info = { order: 'mdy', inferred: 'mdy', forced: forced, hasSlash: false, ambiguous: false, example: '' };
    var c = mapping.date, dayFirst = '', monthFirst = '', amb = '';
    if (c >= 0) {
      parsed.rows.forEach(function (row) {
        var t = String(row[c] == null ? '' : row[c]).trim(), m = t && t.match(SLASH_DATE_RE);
        if (!m) return;
        info.hasSlash = true;
        var a = +m[1], b = +m[2];
        if (a > 12) { if (!dayFirst) dayFirst = t; }
        else if (b > 12) { if (!monthFirst) monthFirst = t; }
        else if (a !== b && !amb) amb = t;
      });
    }
    info.inferred = dayFirst ? 'dmy' : 'mdy';
    info.ambiguous = info.hasSlash && !dayFirst && !monthFirst && !!amb;
    info.example = dayFirst || monthFirst || amb;
    info.order = forced || info.inferred;
    return info;
  }

  function cents(x) { return Math.round(x * 100); }

  // opts: { dateOrder: 'auto' | 'dmy' | 'mdy', includeTotals: bool }
  // Every row becomes a record; rec.skipped says why a row is left out of the analysis:
  // 'header' (header line repeated), 'summary' (no amount and no date), 'total' (a totals row),
  // 'refund' (refund status, zero or negative amount).
  function buildRecords(parsed, mapping, opts) {
    opts = opts || {};
    var dinfo = dateOrderInfo(parsed, mapping, opts), order = dinfo.order;
    var headerNorm = parsed.headers.map(norm), edited = parsed.edited || {}, added = parsed.added || {};
    var recs = [], skipped = { summary: 0, refund: 0, total: 0, header: 0 }, symbols = {};
    function cell(row, key) {
      var i = mapping[key];
      return (i >= 0 && i < row.length) ? String(row[i]).trim() : '';
    }
    parsed.rows.forEach(function (row, n) {
      var amountText = cell(row, 'amount'), dateText = cell(row, 'date');
      var statusText = cell(row, 'status');
      var st = statusText.toLowerCase();
      var sym = amountText.match(/[$€£₪]/);
      if (sym) symbols[sym[0]] = (symbols[sym[0]] || 0) + 1;

      var rec = {
        row: n,
        line: parsed.lineNumbers ? parsed.lineNumbers[n] : n + 2,
        amountText: amountText, dateText: dateText,
        amount: parseAmount(amountText), date: parseDate(dateText, order),
        statusText: statusText,
        isFailed: FAILED_RE.test(st), isBad: BAD_RE.test(st),
        type: cell(row, 'payment_type'), channel: cell(row, 'channel'),
        email: cell(row, 'email').toLowerCase(),
        cardCountry: cell(row, 'card_country'), ipCountry: cell(row, 'ip_country'),
        edited: (edited[n] || []).map(function (c) { return parsed.headers[c] || 'column ' + (c + 1); }),
        added: !!added[n],
        skipped: null, totalWhy: '', wasTotal: false
      };
      var first = cell(row, 'first_name'), last = cell(row, 'last_name');
      rec.name = (first + ' ' + last).trim() || cell(row, 'customer_name');
      var l4 = cell(row, 'card_last4').replace(/\D/g, '');
      rec.last4 = l4 ? l4.slice(-4) : '';
      rec.identity = rec.email ? 'e:' + rec.email : (rec.name ? 'n:' + rec.name.toLowerCase().replace(/\s+/g, ' ') : '');
      rec.key = rec.identity || (rec.last4 ? 'c:' + rec.last4 : '');
      rec.display = rec.name || rec.email || (rec.last4 ? 'Card ending ' + rec.last4 : '');
      rec.job = cell(row, 'job_id'); rec.invoice = cell(row, 'invoice_id'); rec.estimate = cell(row, 'estimate_id');
      rec.ids = [rec.job, rec.invoice, rec.estimate].filter(Boolean);
      rec.idLabel = [rec.job && 'job ' + rec.job, rec.invoice && 'invoice ' + rec.invoice, rec.estimate && 'estimate ' + rec.estimate].filter(Boolean).join(', ');

      var filled = row.filter(function (c) { return String(c).trim() !== ''; });
      var hdrHits = filled.filter(function (c) { var k = norm(c); return k && headerNorm.indexOf(k) !== -1; }).length;
      var label = '';
      row.forEach(function (c) { if (!label && TOTAL_LABEL_RE.test(String(c).trim())) label = String(c).trim(); });

      if (filled.length >= 2 && hdrHits >= Math.ceil(filled.length / 2) && !isFinite(rec.amount)) rec.skipped = 'header';
      else if (!amountText && !dateText) rec.skipped = 'summary';
      else if (label) { rec.skipped = 'total'; rec.totalWhy = 'label'; rec.totalLabel = label; }
      else if (REFUND_RE.test(st) || (isFinite(rec.amount) && rec.amount <= 0)) rec.skipped = 'refund';
      recs.push(rec);
    });

    // A row with no date and no customer whose amount equals the sum of all the other amounts is a totals row.
    var sumAll = 0, sumPos = 0;
    recs.forEach(function (r) {
      if (r.skipped === 'header' || r.skipped === 'total' || !isFinite(r.amount)) return;
      sumAll += cents(r.amount); if (r.amount > 0) sumPos += cents(r.amount);
    });
    recs.forEach(function (r) {
      if (r.skipped || !isFinite(r.amount) || r.amount <= 0 || r.dateText || r.key) return;
      var a2 = 2 * cents(r.amount);
      if (Math.abs(a2 - sumAll) <= 1 || Math.abs(a2 - sumPos) <= 1) { r.skipped = 'total'; r.totalWhy = 'sum'; }
    });
    // The user can say a "totals row" is really a payment.
    if (opts.includeTotals) {
      recs.forEach(function (r) {
        if (r.skipped === 'total' && isFinite(r.amount) && r.amount > 0) { r.skipped = null; r.wasTotal = true; }
      });
    }
    recs.forEach(function (r) { if (r.skipped) skipped[r.skipped]++; });

    var currency = '', best = 0;
    Object.keys(symbols).forEach(function (s) { if (symbols[s] > best) { best = symbols[s]; currency = s; } });
    return { recs: recs, skipped: skipped, currency: currency, dateInfo: dinfo };
  }

  /* ------------------------------------------------------------------ intake */

  var ID_HEADER_RE = /(^|[^a-z])(id|no|nr|number|ref|zip|postal|phone|last ?4|card|account)([^a-z]|$)|#/i;

  // Other columns that look like they hold amounts or dates, for the "Choose the … column" cards.
  function suggestColumns(parsed, mapping, field, base) {
    var out = [], rows = parsed.rows, limit = Math.min(rows.length, 2000), taken = {};
    Object.keys(mapping).forEach(function (k) { if (mapping[k] >= 0) taken[mapping[k]] = true; });
    var need = Math.max(2, Math.ceil(Math.min(base || limit, limit) * MIN_PARSE_SHARE));
    parsed.headers.forEach(function (h, i) {
      if (taken[i]) return;
      if (field === 'amount' && ID_HEADER_RE.test(h)) return;
      var n = 0, ok = 0, pos = 0, asDate = 0;
      for (var k = 0; k < limit; k++) {
        var v = String(rows[k][i] == null ? '' : rows[k][i]).trim();
        if (!v) continue;
        n++;
        var isDate = !!(parseDate(v, 'mdy') || parseDate(v, 'dmy'));
        if (field === 'amount') {
          var a = parseAmount(v);
          if (isFinite(a)) { ok++; if (a > 0) pos++; }
          if (isDate) asDate++;
        } else if (isDate) ok++;
      }
      if (n < need) return;
      if (ok / n < MIN_PARSE_SHARE) return;
      if (field === 'amount' && (pos / n < 0.5 || asDate)) return;
      out.push({ idx: i, name: h || 'column ' + (i + 1) });
    });
    return out.slice(0, 4);
  }

  function shareOf(list, textKey, okFn) {
    var n = 0, ok = 0, examples = [];
    list.forEach(function (r) {
      if (!r[textKey]) return;
      n++;
      if (okFn(r)) ok++;
      else if (examples.length < 3 && examples.indexOf(r[textKey]) === -1) examples.push(r[textKey]);
    });
    return { n: n, ok: ok, share: n ? ok / n : 0, pct: n ? Math.floor(ok / n * 100) : 0, examples: examples };
  }

  function amountLabel(r) { return isFinite(r.amount) ? formatMoney(r.amount) : r.amountText; }
  function shortDay(ts, order) {
    var d = new Date(ts);
    return order === 'dmy' ? d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] : MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate();
  }

  // Checks a parsed file against the current column match before analysis. Re-run on every change.
  // opts: { dateOrder: 'auto' | 'dmy' | 'mdy', includeTotals: bool, runAnyway: bool }
  // Returns { blocking[], warnings[] (levels warn / info / ok), rowIssues[], stats, avail[], ok }.
  // Analyze must stay off while blocking is non-empty.
  function validateIntake(parsed, mapping, opts) {
    opts = opts || {};
    var blocking = [], warnings = [], rowIssues = [];
    var stats = { rows: parsed && parsed.rows ? parsed.rows.length : 0, usable: 0, failed: 0, refunds: 0, totals: 0, summary: 0,
      headerRepeats: 0, unreadableRows: 0, unreadableCells: 0, edited: 0, added: 0,
      dateOrder: 'mdy', inferredOrder: 'mdy', dateOrderForced: false, dateAmbiguous: false, hasSlashDates: false,
      customerRows: 0, activeChecks: 0, totalChecks: RULES.length };
    var shape = checkShape(parsed);
    if (shape) { blocking.push(shape); return { blocking: blocking, warnings: warnings, rowIssues: rowIssues, stats: stats, avail: [], ok: false }; }

    var built = buildRecords(parsed, mapping, opts), recs = built.recs, di = built.dateInfo;
    stats.dateOrder = di.order; stats.inferredOrder = di.inferred; stats.dateOrderForced = !!di.forced;
    stats.dateAmbiguous = di.ambiguous; stats.hasSlashDates = di.hasSlash;
    Object.keys(parsed.edited || {}).forEach(function (k) { stats.edited += parsed.edited[k].length; });
    stats.added = Object.keys(parsed.added || {}).length;

    // Rows that should carry a readable amount and date: payments, failed attempts and refunds.
    var live = recs.filter(function (r) { return r.skipped !== 'header' && r.skipped !== 'summary' && r.skipped !== 'total'; });
    var pays = recs.filter(function (r) { return !r.skipped; });
    var usable = pays.filter(function (r) { return !r.isFailed && isFinite(r.amount) && r.date; });
    stats.usable = usable.length;
    stats.failed = pays.filter(function (r) { return r.isFailed; }).length;
    stats.refunds = built.skipped.refund; stats.totals = built.skipped.total;
    stats.summary = built.skipped.summary; stats.headerRepeats = built.skipped.header;
    var cols = parsed.headers.length;

    /* ---- required columns */
    var amountOk = false, dateOk = false;
    if (mapping.amount < 0) {
      blocking.push(message('NO_AMOUNT', { cols: cols, suggest: suggestColumns(parsed, mapping, 'amount', live.length) }));
    } else {
      var sa = shareOf(live, 'amountText', function (r) { return isFinite(r.amount); });
      if (live.length && sa.share < MIN_PARSE_SHARE) {
        blocking.push(message('AMOUNT_NOT_NUMERIC', { column: parsed.headers[mapping.amount] || 'column ' + (mapping.amount + 1),
          n: sa.n, ok: sa.ok, pct: sa.pct, examples: sa.examples, suggest: suggestColumns(parsed, mapping, 'amount', live.length) }));
      } else amountOk = true;
    }
    if (mapping.date < 0) {
      blocking.push(message('NO_DATE', { cols: cols, suggest: suggestColumns(parsed, mapping, 'date', live.length) }));
    } else {
      var sd = shareOf(live, 'dateText', function (r) { return !!r.date; });
      if (live.length && sd.share < MIN_PARSE_SHARE) {
        blocking.push(message('DATE_UNREADABLE', { column: parsed.headers[mapping.date] || 'column ' + (mapping.date + 1),
          n: sd.n, ok: sd.ok, pct: sd.pct, examples: sd.examples, forced: !!di.forced, order: di.order,
          suggest: suggestColumns(parsed, mapping, 'date', live.length) }));
      } else dateOk = true;
    }

    var custCols = IDENTITY_KEYS.filter(function (k) { return mapping[k] >= 0; });
    var withCustomer = pays.filter(function (r) { return r.key; });
    stats.customerRows = withCustomer.length;
    if (!custCols.length) {
      blocking.push(message('NO_CUSTOMER', { empty: false, columns: [] }));
    } else if (pays.length && !withCustomer.length) {
      blocking.push(message('NO_CUSTOMER', { empty: true, columns: uniq(custCols.map(function (k) { return parsed.headers[mapping[k]]; })) }));
    } else if (pays.length && withCustomer.length / pays.length < MIN_PARSE_SHARE) {
      var without = pays.filter(function (r) { return !r.key; });
      warnings.push(message('CUSTOMER_SPARSE', { withCustomer: withCustomer.length, usable: pays.length, without: without.length,
        lines: without.map(function (r) { return r.line; }) }));
    }

    /* ---- enough payments to compare */
    if (amountOk && dateOk && usable.length < MIN_ROWS) {
      var bits = [];
      var unread = pays.filter(function (r) { return !r.isFailed && !(isFinite(r.amount) && r.date); }).length;
      if (unread) bits.push(nOf(unread, 'payment', 'payments') + ' with an unreadable amount or date');
      if (stats.refunds) bits.push(nOf(stats.refunds, 'refund or zero/negative amount', 'refunds or zero/negative amounts'));
      if (stats.totals + stats.summary) bits.push(nOf(stats.totals + stats.summary, 'totals or blank row'));
      if (stats.headerRepeats) bits.push(nOf(stats.headerRepeats, 'repeated header line'));
      var tf = { usable: usable.length, read: parsed.rows.length, breakdown: bits.join(', '), failed: stats.failed };
      if (opts.runAnyway && usable.length > 0) warnings.push(message('RUN_ANYWAY_NOTE', tf));
      else {
        var tm = message('TOO_FEW_ROWS', tf);
        if (!usable.length) tm.runAnyway = '';
        blocking.push(tm);
      }
    }

    /* ---- row-level problems (only once the columns themselves are accepted) */
    if (amountOk && dateOk) {
      pays.forEach(function (r) {
        if (!isFinite(r.amount)) rowIssues.push({ row: r.row, line: r.line, col: mapping.amount, field: 'amount', value: r.amountText, reason: r.amountText ? 'unreadable' : 'blank', who: r.display });
        if (!r.date) rowIssues.push({ row: r.row, line: r.line, col: mapping.date, field: 'date', value: r.dateText, reason: r.dateText ? 'unreadable' : 'blank', who: r.display });
      });
      var badRows = uniq(rowIssues.map(function (x) { return String(x.row); }));
      stats.unreadableRows = badRows.length; stats.unreadableCells = rowIssues.length;
      if (rowIssues.length) {
        warnings.push(message('ROWS_UNREADABLE', { rows: badRows.length, cells: rowIssues.length,
          items: rowIssues.map(function (x) { return 'row ' + x.line + ' (' + x.field + ' ' + (x.value ? qt(x.value) : 'blank') + ')'; }) }));
      }
    }

    /* ---- rows left out */
    var totalsRows = recs.filter(function (r) { return r.skipped === 'total'; });
    var totalItems = function (list) {
      return list.map(function (r) {
        return 'row ' + r.line + ' (' + (r.totalWhy === 'label' ? qt(r.totalLabel) + (r.amountText ? ', ' + amountLabel(r) : '') : amountLabel(r) + ', the sum of the other amounts, with no date or customer') + ')';
      });
    };
    if (totalsRows.length) {
      var tmsg = message('TOTALS_SKIPPED', { items: totalItems(totalsRows) });
      if (!totalsRows.some(function (r) { return isFinite(r.amount) && r.amount > 0; })) { tmsg.action = ''; tmsg.fix = ''; }
      warnings.push(tmsg);
    }
    var included = recs.filter(function (r) { return r.wasTotal; });
    if (included.length) warnings.push(message('TOTALS_INCLUDED', { items: totalItems(included) }));
    var refunds = recs.filter(function (r) { return r.skipped === 'refund'; });
    if (refunds.length) {
      warnings.push(message('REFUNDS_SKIPPED', { items: refunds.map(function (r) {
        return 'row ' + r.line + ' (' + (REFUND_RE.test(r.statusText.toLowerCase()) ? qt(r.statusText) : r.amountText) + ')';
      }) }));
    }
    var headerRows = recs.filter(function (r) { return r.skipped === 'header'; });
    if (headerRows.length) warnings.push(message('HEADER_REPEATED', { lines: headerRows.map(function (r) { return r.line; }) }));

    /* ---- dates */
    if (mapping.date >= 0 && di.hasSlash) {
      if (di.forced) {
        var om = message('DATE_ORDER_OVERRIDE', { order: di.order, inferred: di.inferred, example: di.example });
        if (di.order === di.inferred) om.level = 'info';
        warnings.push(om);
      } else if (di.ambiguous) {
        var ex = parseDate(di.example, di.order);
        warnings.push(message('DATE_AMBIGUOUS', { example: di.example, order: di.order, reading: ex ? shortDay(ex.ts, di.order) : '' }));
      } else if (di.inferred === 'dmy') {
        warnings.push(message('DATE_DAY_FIRST', { example: di.example, order: di.order }));
      }
    }

    /* ---- what the analysis will be able to do */
    var ctx = buildContext(pays);
    var avail = RULES.map(function (rule) {
      var a = availability(rule, mapping, ctx);
      return { id: rule.id, name: rule.name, points: rule.points, ok: a.ok, missing: a.missing };
    });
    stats.activeChecks = avail.filter(function (a) { return a.ok; }).length;
    if (dateOk && usable.length && !(ctx.clockShare > 0.5)) warnings.push(message('NO_TIMES'));
    // Column coverage is judged as if the file had enough rows; too few rows is TOO_FEW_ROWS's job.
    var colCtx = { nValid: Math.max(ctx.nValid, MIN_BASELINE_ROWS), clockShare: ctx.clockShare };
    var colAvail = RULES.map(function (rule) { return availability(rule, mapping, colCtx); });
    var colActive = colAvail.filter(function (a) { return a.ok; }).length;
    if (amountOk && dateOk && custCols.length && colActive < MIN_EVALUABLE) {
      var add = [];
      colAvail.forEach(function (a) {
        if (a.missing.length === 1 && !/payments in the file|Times of day/.test(a.missing[0]) && add.indexOf(a.missing[0]) === -1) add.push(a.missing[0]);
      });
      blocking.push(message('LOW_COVERAGE', { active: colActive, total: RULES.length, add: add,
        noTimes: !(ctx.clockShare > 0.5) }));
    }
    if (usable.length >= MIN_ROWS && usable.length < STEADY_ROWS) warnings.push(message('FEW_ROWS_NOTE', { usable: usable.length }));
    if (parsed.truncated) warnings.push(message('TRUNCATED'));
    if (stats.edited) warnings.push(message('EDITED', { n: stats.edited }));
    if (stats.added) warnings.push(message('ADDED', { n: stats.added }));

    var rank = { warn: 0, info: 1, ok: 2 };
    warnings.sort(function (a, b) { return rank[a.level] - rank[b.level]; });
    if (!blocking.length && !warnings.some(function (w) { return w.level === 'warn'; })) warnings.unshift(message('FILE_OK', { usable: usable.length }));
    return { blocking: blocking, warnings: warnings, rowIssues: rowIssues, stats: stats, avail: avail, ok: !blocking.length };
  }

  /* ------------------------------------------------------------------- stats */

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var BANK_RE = /\bach\b|bank|e-?check|\bwire\b|transfer|\beft\b|direct debit/i;
  var CARD_RE = /card|visa|master|amex|american express|discover|credit|debit/i;

  function numAsc(a, b) { return a - b; }
  function lowerBound(a, x) { var l = 0, h = a.length; while (l < h) { var m = (l + h) >> 1; if (a[m] < x) l = m + 1; else h = m; } return l; }
  function upperBound(a, x) { var l = 0, h = a.length; while (l < h) { var m = (l + h) >> 1; if (a[m] <= x) l = m + 1; else h = m; } return l; }
  function median(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(numAsc), n = a.length;
    return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dayLabel(ts) { var d = new Date(ts); return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate(); }
  function dayFull(ts) { var d = new Date(ts); return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear(); }
  function clockOf(rec) { return rec.date && rec.date.hasClock ? pad(rec.date.hour) + ':' + pad(rec.date.minute) : ''; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function pctOf(a, b) { return b ? Math.round(a / b * 100) : 0; }
  function fmtX(x) { return x >= 10 ? String(Math.round(x)) : x.toFixed(1); }
  function joinList(a) { return a.length < 3 ? a.join(' and ') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }
  function uniq(a) { var seen = {}; return a.filter(function (x) { if (seen[x]) return false; seen[x] = true; return true; }); }
  function fm(n, ctx) { return formatMoney(n, ctx && ctx.currency); }
  function spanText(ts1, ts2) {
    var m = Math.round((ts2 - ts1) / MIN);
    if (m < 1) return 'under a minute';
    if (m < 90) return plural(m, 'minute');
    var h = Math.round(m / 60);
    return h < 36 ? plural(h, 'hour') : plural(Math.round(h / 24), 'day');
  }
  function whenText(a, b) {
    if (!a.date || !b.date) return '';
    var ca = clockOf(a), cb = clockOf(b);
    if (new Date(a.date.ts).getUTCDate() === new Date(b.date.ts).getUTCDate() && ca && cb) return dayLabel(a.date.ts) + ' ' + ca + (ca === cb ? '' : '–' + cb);
    return dayLabel(a.date.ts) + (a.date.ts === b.date.ts ? '' : ' to ' + dayLabel(b.date.ts));
  }
  function jobsText(recs) {
    var ids = uniq(recs.map(function (o) { return o.job || o.invoice; }).filter(Boolean));
    return ids.length ? (ids.length === 1 ? 'job ' : 'jobs ') + joinList(ids.slice(0, 4)) + (ids.length > 4 ? ' and more' : '') : '';
  }

  // How long a payment can still be pulled back, by payment type.
  function reversal(rec) {
    if (!rec.date || rec.isFailed) return null;
    if (BANK_RE.test(rec.type)) return { kind: 'bank', until: rec.date.ts + 60 * DAY,
      text: 'The customer\'s bank can still reverse this until about ' + dayFull(rec.date.ts + 60 * DAY) + ' (bank payments are often reversible for up to 60 days).' };
    if (CARD_RE.test(rec.type)) return { kind: 'card', until: rec.date.ts + 120 * DAY,
      text: 'The customer can still dispute this card payment until about ' + dayFull(rec.date.ts + 120 * DAY) + ' (chargebacks are often allowed for up to 120 days).' };
    return null;
  }

  function buildContext(recs) {
    var ctx = { groups: Object.create(null), byCard: Object.create(null), hopping: Object.create(null) };
    var pay = recs.filter(function (r) { return isFinite(r.amount) && r.date && !r.isFailed; });
    var amounts = pay.map(function (r) { return r.amount; });
    ctx.median = median(amounts);
    ctx.sortedAmounts = amounts.slice().sort(numAsc);
    ctx.nValid = pay.length;
    ctx.nightCount = pay.filter(function (r) { return r.date.hasClock && r.date.hour < 5; }).length;
    ctx.unlinkedCount = pay.filter(function (r) { return r.ids.length === 0; }).length;
    var dated = recs.filter(function (r) { return r.date; });
    ctx.clockShare = dated.length ? dated.filter(function (r) { return r.date.hasClock; }).length / dated.length : 0;

    recs.forEach(function (r) {
      if (!r.key || !r.date) return;
      var g = ctx.groups[r.key] || (ctx.groups[r.key] = { payRecs: [], failedRecs: [], amt: Object.create(null) });
      if (r.isFailed) g.failedRecs.push(r); else g.payRecs.push(r);
    });
    Object.keys(ctx.groups).forEach(function (k) {
      var g = ctx.groups[k], byTs = function (a, b) { return a.date.ts - b.date.ts; };
      g.payRecs.sort(byTs); g.failedRecs.sort(byTs);
      g.pay = g.payRecs.map(function (r) { return r.date.ts; });
      g.failed = g.failedRecs.map(function (r) { return r.date.ts; });
      g.payPrefix = [0];
      g.payRecs.forEach(function (r) {
        g.payPrefix.push(g.payPrefix[g.payPrefix.length - 1] + (isFinite(r.amount) ? r.amount : 0));
        if (isFinite(r.amount)) { var ak = r.amount.toFixed(2); (g.amt[ak] = g.amt[ak] || []).push(r.date.ts); }
      });
    });

    // Card shared by several customers.
    recs.forEach(function (r) {
      if (r.last4 && r.identity) (ctx.byCard[r.last4] = ctx.byCard[r.last4] || {})[r.identity] = r.display;
    });
    // One customer switching between several cards within a day.
    var byIdentity = Object.create(null);
    recs.forEach(function (r, i) {
      r.i = i;
      if (r.last4 && r.identity && r.date) (byIdentity[r.identity] = byIdentity[r.identity] || []).push(r);
    });
    Object.keys(byIdentity).forEach(function (k) {
      var list = byIdentity[k];
      if (list.length < 3 || list.length > 300) return;
      list.sort(function (a, b) { return a.date.ts - b.date.ts; });
      list.forEach(function (r) {
        var cards = {}, n = 0;
        list.forEach(function (o) {
          if (Math.abs(o.date.ts - r.date.ts) <= 12 * HOUR && !cards[o.last4]) { cards[o.last4] = true; n++; }
        });
        if (n >= 3) ctx.hopping[r.i] = n;
      });
    });
    return ctx;
  }

  /* ------------------------------------------------------------------- rules */

  function ratio(r, ctx) { return ctx.median > 0 && isFinite(r.amount) ? r.amount / ctx.median : 0; }
  function who(r) { return r.display || 'this customer'; }

  var RULES = [
    { id: 'R1', name: 'Already disputed, returned or reversed', points: 100, needs: ['status'],
      desc: 'The status shows the payment already went wrong (dispute, chargeback, return, reversal). Goes straight to Fraud.',
      ready: function (r) { return r.statusText !== ''; },
      test: function (r) {
        return r.isBad ? { points: 100, override: true, detail: 'Status is "' + r.statusText + '" — a dispute or reversal is already open on this payment.' } : null;
      } },
    { id: 'R2', name: 'Burst of failed attempts', points: 40, needs: ['status', 'date', 'identity'],
      desc: '3 or more failed attempts on the same customer within an hour — the classic card-testing pattern.',
      ready: function (r) { return !!r.key && !!r.date; },
      test: function (r, ctx) {
        var g = ctx.groups[r.key];
        if (!g) return null;
        var i0 = lowerBound(g.failed, r.date.ts - 30 * MIN), i1 = upperBound(g.failed, r.date.ts + 30 * MIN), n = i1 - i0;
        if (n < 3) return null;
        var first = g.failedRecs[i0], last = g.failedRecs[i1 - 1];
        var p0 = lowerBound(g.pay, first.date.ts), p1 = upperBound(g.pay, last.date.ts + 30 * MIN), paid = null;
        for (var k = p0; k < Math.min(p1, p0 + 5); k++) { if (!paid || g.payRecs[k].amount > paid.amount) paid = g.payRecs[k]; }
        var text = n + ' failed attempts on ' + who(r) + ' between ' + clockOf(first) + ' and ' + clockOf(last);
        if (paid) text += ', then a payment of ' + fm(paid.amount, ctx) + ' went through at ' + clockOf(paid);
        return { points: 40, detail: text + ' — the classic card-testing pattern.', data: { n: n, first: first, last: last, paid: paid } };
      } },
    { id: 'R3', name: 'Many payments in a short time', points: 30, needs: ['date', 'identity'],
      desc: '3 or more payments from the same customer inside a 24-hour window.',
      ready: function (r) { return !!r.key && !!r.date; },
      test: function (r, ctx) {
        if (r.isFailed) return null;
        var g = ctx.groups[r.key];
        if (!g) return null;
        var i0 = lowerBound(g.pay, r.date.ts - 12 * HOUR), i1 = upperBound(g.pay, r.date.ts + 12 * HOUR), n = i1 - i0;
        if (n < 3) return null;
        var first = g.payRecs[i0], last = g.payRecs[i1 - 1], sum = g.payPrefix[i1] - g.payPrefix[i0];
        var sample = g.payRecs.slice(i0, Math.min(i1, i0 + 6));
        var same = n <= 6 && sample.every(function (o) { return o.amount === first.amount; }) ? first.amount : null;
        var jobs = jobsText(sample);
        var text = n + ' payments from ' + who(r) + ' within ' + spanText(first.date.ts, last.date.ts) + ' (' + whenText(first, last) + '), ' + fm(sum, ctx) + ' in total';
        if (same !== null) text += ' — ' + n + ' × ' + fm(same, ctx);
        if (jobs) text += ', linked to ' + jobs;
        return { points: 30, detail: text + '.', data: { n: n, first: first, last: last, sum: sum, same: same, jobs: jobs } };
      } },
    { id: 'R4', name: 'Unusually large amount', points: 30, needs: ['amount', 'rows20'],
      desc: 'Compared with the median payment in your file: more than 3× adds 10, more than 5× adds 20, more than 10× adds 30.',
      ready: function (r) { return isFinite(r.amount); },
      test: function (r, ctx) {
        if (r.isFailed) return null;
        var x = ratio(r, ctx), p = x > 10 ? 30 : x > 5 ? 20 : x > 3 ? 10 : 0;
        if (!p) return null;
        var pctl = Math.floor(lowerBound(ctx.sortedAmounts, r.amount) / ctx.sortedAmounts.length * 100);
        return { points: p, data: { x: x, pctl: pctl },
          detail: fm(r.amount, ctx) + ' is ' + fmtX(x) + '× your median payment (' + fm(ctx.median, ctx) + ') and bigger than ' + pctl + '% of the payments in this file.' };
      } },
    { id: 'R5', name: 'Card shared or switched', points: 30, needs: ['card_last4', 'strongIdentity'],
      desc: 'One card used by 3 or more different customers, or one customer using 3 or more cards within a day.',
      ready: function (r) { return !!r.last4 && !!r.identity; },
      test: function (r, ctx) {
        var s = ctx.byCard[r.last4], names = s ? Object.keys(s).map(function (k) { return s[k]; }) : [];
        if (names.length >= 3) return { points: 30, detail: 'Card ending ' + r.last4 + ' was used by ' + joinList(names.slice(0, 3)) + (names.length > 3 ? ' and ' + (names.length - 3) + ' more' : '') + '.' };
        if (ctx.hopping[r.i]) return { points: 30, detail: who(r) + ' used ' + ctx.hopping[r.i] + ' different cards within a day.' };
        return null;
      } },
    { id: 'R6', name: 'Card and payment country differ', points: 25, needs: ['card_country', 'ip_country'],
      desc: 'The card was issued in one country but the payment came from another.',
      ready: function (r) { return !!r.cardCountry && !!r.ipCountry; },
      test: function (r) {
        return r.cardCountry.toUpperCase() !== r.ipCountry.toUpperCase()
          ? { points: 25, detail: 'Card issued in ' + r.cardCountry + ' but the payment came from ' + r.ipCountry + '.' } : null;
      } },
    { id: 'R7', name: 'Disposable email address', points: 15, needs: ['email'],
      desc: 'The email uses a throwaway-mail domain.',
      ready: function (r) { return !!r.email; },
      test: function (r) {
        var d = r.email.split('@')[1] || '';
        return DISPOSABLE.indexOf(d) !== -1 ? { points: 15, detail: r.email + ' is on ' + d + ', a throwaway-mail service.' } : null;
      } },
    { id: 'R8', name: 'Large online payment', points: 10, needs: ['channel', 'rows20'],
      desc: 'Paid online by the customer (portal, link, web) and more than 3× the median — nobody was present to check.',
      ready: function (r) { return r.channel !== ''; },
      test: function (r, ctx) {
        if (r.isFailed || !/portal|online|web|link|self|virtual|remote|hosted|e-?commerce|payment page/i.test(r.channel)) return null;
        var x = ratio(r, ctx);
        return x > 3 ? { points: 10, data: { x: x }, detail: 'Paid online ("' + r.channel + '") with nobody there to check the customer, at ' + fmtX(x) + '× your median payment.' } : null;
      } },
    { id: 'R9', name: 'Large bank payment', points: 10, needs: ['payment_type', 'rows20'],
      desc: 'A bank transfer / ACH / e-check more than 3× the median. These can be reversed weeks later.',
      ready: function (r) { return r.type !== ''; },
      test: function (r, ctx) {
        if (r.isFailed || !BANK_RE.test(r.type)) return null;
        var x = ratio(r, ctx);
        if (!(x > 3)) return null;
        var rev = reversal(r);
        return { points: 10, data: { x: x, rev: rev }, detail: 'Bank payment ("' + r.type + '") at ' + fmtX(x) + '× your median. ' + (rev ? rev.text : '') };
      } },
    { id: 'R10', name: 'Not linked to any job or invoice', points: 10, needs: ['ids'],
      desc: 'The payment has no job, invoice or estimate attached.',
      ready: function () { return true; },
      test: function (r, ctx) {
        return r.ids.length === 0 ? { points: 10, detail: 'No job, invoice or estimate is attached — only ' + ctx.unlinkedCount + ' of the ' + ctx.nValid + ' payments in this file are unlinked.' } : null;
      } },
    { id: 'R11', name: 'Made in the small hours', points: 10, needs: ['clock'],
      desc: 'Made between midnight and 5am, using the time exactly as exported.',
      ready: function (r) { return !!r.date && r.date.hasClock; },
      test: function (r, ctx) {
        if (r.date.hour >= 5) return null;
        return { points: 10, detail: 'Made at ' + clockOf(r) + ' — ' + (ctx.nightCount <= 1 ? 'the only payment' : 'one of only ' + ctx.nightCount + ' payments') + ' in this file made between midnight and 5am (time as exported).' };
      } },
    { id: 'R12', name: 'Same amount repeated', points: 10, needs: ['date', 'amount', 'identity'],
      desc: 'The same customer paying exactly the same amount 3 or more times within a week.',
      ready: function (r) { return !!r.key && !!r.date && isFinite(r.amount); },
      test: function (r, ctx) {
        if (r.isFailed) return null;
        var g = ctx.groups[r.key], list = g && g.amt[r.amount.toFixed(2)];
        if (!list) return null;
        var c = upperBound(list, r.date.ts + 3.5 * DAY) - lowerBound(list, r.date.ts - 3.5 * DAY);
        return c >= 3 ? { points: 10, detail: who(r) + ' paid exactly ' + fm(r.amount, ctx) + ' ' + c + ' times within a week.' } : null;
      } }
  ];

  function availability(rule, mapping, ctx) {
    var missing = [];
    rule.needs.forEach(function (n) {
      if (n === 'identity') {
        if (!hasAny(mapping, ['first_name', 'last_name', 'customer_name', 'email', 'card_last4'])) missing.push('Customer name, email or card last 4');
      } else if (n === 'strongIdentity') {
        if (!hasAny(mapping, ['first_name', 'last_name', 'customer_name', 'email'])) missing.push('Customer name or email');
      } else if (n === 'ids') {
        if (!hasAny(mapping, ['job_id', 'invoice_id', 'estimate_id'])) missing.push('Job, invoice or estimate ID');
      } else if (n === 'rows20') {
        if (ctx.nValid < MIN_BASELINE_ROWS) missing.push('At least ' + MIN_BASELINE_ROWS + ' payments in the file');
      } else if (n === 'clock') {
        if (!(ctx.clockShare > 0.5)) missing.push('Times of day in the date column');
      } else if (mapping[n] < 0) {
        missing.push(FIELD_BY_KEY[n].label);
      }
    });
    return { ok: missing.length === 0, missing: missing };
  }

  function ruleAvailability(parsed, mapping, opts) {
    var built = buildRecords(parsed, mapping, opts);
    var recs = built.recs.filter(function (r) { return !r.skipped; });
    var ctx = buildContext(recs);
    return RULES.map(function (rule) {
      var a = availability(rule, mapping, ctx);
      return { id: rule.id, name: rule.name, points: rule.points, ok: a.ok, missing: a.missing };
    });
  }

  /* ----------------------------------------------------------------- analyze */

  function analyze(parsed, mapping, opts) {
    var built = buildRecords(parsed, mapping, opts);
    var recs = built.recs.filter(function (r) { return !r.skipped; });
    var ctx = buildContext(recs);
    ctx.currency = built.currency;
    ctx.mapping = mapping;
    var avail = RULES.map(function (rule) {
      var a = availability(rule, mapping, ctx);
      return { id: rule.id, name: rule.name, points: rule.points, ok: a.ok, missing: a.missing };
    });
    var okById = {};
    avail.forEach(function (a) { okById[a.id] = a.ok; });

    var results = recs.map(function (r) {
      var hits = [], evaluable = 0, score = 0, override = false;
      RULES.forEach(function (rule) {
        if (!okById[rule.id] || !rule.ready(r)) return;
        evaluable++;
        var h = rule.test(r, ctx);
        if (h) {
          hits.push({ id: rule.id, name: rule.name, points: h.points, detail: h.detail, data: h.data || null });
          score += h.points;
          if (h.override) override = true;
        }
      });
      score = Math.min(100, score);
      var nei = null;
      if (!override) {
        var noAmt = !isFinite(r.amount), noDate = !r.date;
        if (noAmt || noDate) {
          nei = 'The ' + (noAmt && noDate ? 'amount and date are' : noAmt ? 'amount is' : 'date is') + ' missing or unreadable.';
        } else if (evaluable < MIN_EVALUABLE) {
          nei = 'Only ' + evaluable + ' of ' + RULES.length + ' checks could run on this row (at least ' + MIN_EVALUABLE + ' needed) — too many details are blank.';
        }
      }
      return { rec: r, score: score, hits: hits, evaluable: evaluable, override: override, nei: nei, category: null, story: null, ctx: ctx };
    });
    var edited = 0, added = 0;
    built.recs.forEach(function (r) { edited += r.edited.length; if (r.added) added++; });
    return { results: results, ctx: ctx, avail: avail, skipped: built.skipped, currency: built.currency, dateInfo: built.dateInfo, edited: edited, added: added, usable: ctx.nValid };
  }

  function categorize(res, t) {
    if (res.nei) return 'Not enough information';
    if (res.override || res.score >= t.fraud) return 'Fraud';
    if (res.score >= t.review) return 'Review';
    return 'Legit';
  }

  /* ----------------------------------------------------------- per-row story */

  function hitOf(res, id) {
    for (var i = 0; i < res.hits.length; i++) if (res.hits[i].id === id) return res.hits[i];
    return null;
  }

  function blankFields(r, ctx) {
    var m = ctx.mapping, out = [];
    if (m.first_name >= 0 || m.last_name >= 0 || m.customer_name >= 0) { if (!r.name) out.push('customer name'); }
    if (m.status >= 0 && !r.statusText) out.push('status');
    if (m.payment_type >= 0 && !r.type) out.push('payment type');
    if (m.channel >= 0 && !r.channel) out.push('channel');
    if (hasAny(m, ['job_id', 'invoice_id', 'estimate_id']) && !r.ids.length) out.push('job/invoice/estimate ID');
    return out;
  }

  function explain(res) {
    var r = res.rec, ctx = res.ctx, cat = res.category, nm = who(r);
    var amt = fm(r.amount, ctx), on = r.date ? ' on ' + dayLabel(r.date.ts) : '';
    var story = { headline: '', step: '', untilTs: null, exposure: 0, missing: [] };
    var h1 = hitOf(res, 'R1'), h2 = hitOf(res, 'R2'), h3 = hitOf(res, 'R3'), h4 = hitOf(res, 'R4'), h9 = hitOf(res, 'R9'), h10 = hitOf(res, 'R10'), h11 = hitOf(res, 'R11');
    var how = (r.type ? ' by ' + r.type : '') + (r.channel ? ' via ' + r.channel : '');
    var flagged = cat === 'Fraud' || cat === 'Review';

    if (res.nei) {
      var noAmt = !isFinite(r.amount), noDate = !r.date;
      story.missing = blankFields(r, ctx);
      var why;
      if (noAmt || noDate) why = 'the ' + (noAmt && noDate ? 'amount and date' : noAmt ? 'amount' : 'date') + ' ' + (noAmt && noDate ? 'are' : 'is') + ' missing or unreadable' + (noDate && r.dateText ? ' ("' + r.dateText + '")' : '');
      else why = 'these details are blank: ' + (story.missing.length ? joinList(story.missing) : 'most fields');
      story.headline = 'Can\'t judge row ' + r.line + (r.display ? ' (' + r.display + ')' : '') + ' — ' + why + '.';
      var fill = noAmt || noDate ? 'the ' + (noAmt && noDate ? 'amount and date' : noAmt ? 'amount' : 'date') : (story.missing.length ? joinList(story.missing) : 'the missing details');
      story.step = (r.idLabel ? 'Open ' + r.idLabel + (r.display ? ' for ' + r.display : '') + ' in your CRM' : 'Find this payment in your CRM (row ' + r.line + (r.date ? ', ' + dayLabel(r.date.ts) : '') + ')') + ', fill in ' + fill + ', then upload the file again.';
      return story;
    }

    if (h1) {
      story.headline = nm + '\'s ' + amt + ' payment' + on + ' is already ' + (/return/i.test(r.statusText) ? 'returned' : /revers/i.test(r.statusText) ? 'reversed' : 'disputed') + '.';
      story.step = 'Respond before your processor\'s deadline (it\'s in the dispute notice). ' + (r.idLabel ? 'Submit your records for ' + r.idLabel + ': the signed estimate, photos and messages with ' + nm + '.' : 'No job or invoice is linked to this payment, so find ' + nm + '\'s job in your CRM right away — without paperwork the dispute is hard to win.');
    } else if (h2 && flagged) {
      var d = h2.data;
      if (r.isFailed) {
        story.headline = 'Failed attempt ' + clockOf(r) + ' — one of ' + d.n + ' on ' + nm + ' within an hour' + (d.paid ? ', followed by a ' + fm(d.paid.amount, ctx) + ' payment' : '') + '.';
        story.step = 'Nothing was charged here. ' + (d.paid ? 'Handle it together with the ' + fm(d.paid.amount, ctx) + ' payment at ' + clockOf(d.paid) + ' (row ' + d.paid.line + '): don\'t retry this card.' : 'Don\'t retry this card; ask ' + nm + ' for a different way to pay.');
      } else {
        story.headline = 'Possible card testing: ' + nm + ' had ' + d.n + ' failed attempts (' + clockOf(d.first) + '–' + clockOf(d.last) + '), then ' + amt + ' went through' + (clockOf(r) ? ' at ' + clockOf(r) : '') + '.';
        story.step = 'Don\'t retry that card. Call ' + nm + ' on a phone number already in your CRM — not one from this payment — and ask your processor whether the ' + amt + ' should be refunded or held.';
      }
    } else if (h3 && flagged) {
      var v = h3.data;
      story.headline = nm + ' paid ' + v.n + ' times in ' + spanText(v.first.date.ts, v.last.date.ts) + ' (' + whenText(v.first, v.last) + '): ' + fm(v.sum, ctx) + ' in total' + (v.same !== null ? ', ' + v.n + ' × ' + fm(v.same, ctx) : '') + '.';
      story.step = 'Call ' + nm + ': are these ' + v.n + ' separate jobs' + (v.jobs ? ' (' + v.jobs + ')' : '') + ' or repeat charges? Hold any further payments from this customer until you\'ve confirmed.';
    } else if (flagged) {
      var bits = [];
      if (h4) bits.push(fmtX(h4.data.x) + '× your median payment');
      if (h10) bits.push('no paperwork attached');
      if (h11) bits.push('made at ' + clockOf(r));
      story.headline = nm + ' paid ' + amt + how + (bits.length ? ' — ' + joinList(bits) : '') + '.';
      if (!bits.length && res.hits.length) story.headline = nm + ' paid ' + amt + how + ' — ' + res.hits[0].name.toLowerCase() + '.';
      if (h10 && h4) story.step = 'Before any work: look up ' + nm + ' in your CRM. No job, invoice or estimate is attached to this ' + amt + ', so if nothing matches, don\'t start the work or release a payout.';
      else if (h4 && r.idLabel) story.step = 'Check that ' + amt + ' matches ' + r.idLabel + ' and keep the signed copy on file.';
      else story.step = 'Verify ' + nm + ' by phone using a number from your CRM, and confirm the payment actually cleared.';
      if (h9 && h9.data.rev) story.step += ' Also hold off on buying materials until the funds are final.';
    } else if (cat === 'Legit') {
      var x = ratio(r, ctx);
      var size = x >= 1.5 ? fmtX(x) + '× your median' : x >= 0.8 ? 'close to your median (' + fm(ctx.median, ctx) + ')' : 'below your median (' + fm(ctx.median, ctx) + ')';
      var tail = r.idLabel ? ', linked to ' + r.idLabel : '';
      story.headline = nm + ' paid ' + amt + how + ' — ' + (res.hits.length ? 'only minor signals (' + joinList(res.hits.map(function (h) { return h.name.toLowerCase(); })) + ')' : 'nothing unusual') + ': ' + size + tail + '.';
      story.step = '';
    }

    if (flagged && !r.isFailed && isFinite(r.amount)) {
      story.exposure = r.amount;
      var rev = reversal(r);
      if (rev && !h1) story.untilTs = rev.until;
    }
    return story;
  }

  function summarize(results, t) {
    var byCat = {}, total = { count: 0, amount: 0 };
    CATEGORIES.forEach(function (c) { byCat[c] = { count: 0, amount: 0 }; });
    results.forEach(function (res) {
      var c = categorize(res, t);
      res.category = c;
      res.story = explain(res);
      // Failed attempts never moved money, so they don't add to the amount at stake.
      var amt = isFinite(res.rec.amount) && !res.rec.isFailed ? res.rec.amount : 0;
      byCat[c].count++; byCat[c].amount += amt;
      total.count++; total.amount += amt;
    });
    return { byCat: byCat, total: total };
  }

  /* ------------------------------------------------------------------- cases */

  var SEV = { 'Fraud': 0, 'Review': 1 };

  function buildCases(results) {
    var flagged = results.filter(function (r) { return r.category === 'Fraud' || r.category === 'Review'; });
    var withKey = flagged.filter(function (r) { return r.rec.key && r.rec.date; }).sort(function (a, b) {
      return a.rec.key < b.rec.key ? -1 : a.rec.key > b.rec.key ? 1 : a.rec.date.ts - b.rec.date.ts;
    });
    var groups = [], cur = null;
    withKey.forEach(function (res) {
      var last = cur && cur[cur.length - 1];
      if (last && last.rec.key === res.rec.key && res.rec.date.ts - last.rec.date.ts <= 48 * HOUR) cur.push(res);
      else { cur = [res]; groups.push(cur); }
    });
    flagged.filter(function (r) { return !(r.rec.key && r.rec.date); }).forEach(function (res) { groups.push([res]); });

    var cases = groups.map(function (rows) {
      var paid = rows.filter(function (r) { return !r.rec.isFailed; });
      var lead = (paid.length ? paid : rows).slice().sort(function (a, b) { return b.score - a.score; })[0];
      var worst = rows.some(function (r) { return r.category === 'Fraud'; }) ? 'Fraud' : 'Review';
      var untils = rows.map(function (r) { return r.story.untilTs; }).filter(Boolean);
      return {
        rows: rows, lead: lead, category: worst, score: lead.score,
        name: lead.rec.display, headline: lead.story.headline, step: lead.story.step,
        payments: paid.length, failed: rows.length - paid.length,
        exposure: rows.reduce(function (s, r) { return s + r.story.exposure; }, 0),
        untilTs: untils.length ? Math.max.apply(null, untils) : null,
        lines: rows.map(function (r) { return r.rec.line; }).sort(function (a, b) { return a - b; })
      };
    });
    cases.sort(function (a, b) { return SEV[a.category] - SEV[b.category] || b.exposure - a.exposure || b.score - a.score; });
    return cases;
  }

  /* ---------------------------------------------------------------- insights */

  function buildInsights(analysis, summary, cases) {
    var ctx = analysis.ctx, all = analysis.results, out = [];
    var isFlag = function (r) { return r.category === 'Fraud' || r.category === 'Review'; };
    var pay = all.filter(function (r) { return !r.rec.isFailed && isFinite(r.rec.amount); });
    var fp = pay.filter(isFlag), N = pay.length;
    var sum = function (list) { return list.reduce(function (s, r) { return s + r.rec.amount; }, 0); };
    var totalAmt = sum(pay), flagAmt = sum(fp);
    var f = function (n) { return fm(n, ctx); };
    if (!N) return out;

    if (fp.length) {
      var shareN = pctOf(fp.length, N), shareM = pctOf(flagAmt, totalAmt);
      out.push({ strength: 20 + Math.max(0, shareM - shareN),
        text: fp.length + ' of ' + N + ' payments (' + shareN + '%) are flagged, and they hold ' + shareM + '% of the money (' + f(flagAmt) + ' of ' + f(totalAmt) + ').' +
          (shareM > shareN + 10 ? ' A handful of large payments carry most of your risk.' : '') });
    }

    function compare(getter) {
      var buckets = {}, best = null;
      pay.forEach(function (r) {
        var v = getter(r.rec);
        if (!v) return;
        var k = v.toLowerCase(), b = buckets[k] || (buckets[k] = { label: v, n: 0, f: 0 });
        b.n++; if (isFlag(r)) b.f++;
      });
      Object.keys(buckets).forEach(function (k) {
        var b = buckets[k], restN = N - b.n, restF = fp.length - b.f;
        if (b.n < 5 || b.f < 3 || !restN) return;
        var diff = b.f / b.n - restF / restN;
        if (diff >= 0.25 && (!best || diff > best.diff)) best = { label: b.label, n: b.n, f: b.f, restN: restN, restF: restF, diff: diff };
      });
      return best;
    }
    var byChannel = ctx.mapping.channel >= 0 ? compare(function (r) { return r.channel; }) : null;
    if (byChannel) out.push({ strength: byChannel.diff * 100, text: 'Channel "' + byChannel.label + '": ' + byChannel.f + ' of ' + byChannel.n + ' payments flagged (' + pctOf(byChannel.f, byChannel.n) + '%), versus ' + byChannel.restF + ' of ' + byChannel.restN + ' (' + pctOf(byChannel.restF, byChannel.restN) + '%) everywhere else.' });
    var byType = ctx.mapping.payment_type >= 0 ? compare(function (r) { return r.type; }) : null;
    if (byType) out.push({ strength: byType.diff * 100, text: 'Payment type "' + byType.label + '": ' + byType.f + ' of ' + byType.n + ' payments flagged (' + pctOf(byType.f, byType.n) + '%), versus ' + byType.restF + ' of ' + byType.restN + ' (' + pctOf(byType.restF, byType.restN) + '%) for the rest.' });

    if (ctx.clockShare > 0.5) {
      var night = pay.filter(function (r) { return r.rec.date && r.rec.date.hasClock && r.rec.date.hour < 5; });
      var day = pay.filter(function (r) { return r.rec.date && r.rec.date.hasClock && r.rec.date.hour >= 5; });
      if (night.length >= 3 && day.length) {
        var nf = night.filter(isFlag).length, df = day.filter(isFlag).length, d = nf / night.length - df / day.length;
        if (d >= 0.25) out.push({ strength: d * 100, text: nf + ' of the ' + night.length + ' payments made between midnight and 5am are flagged, versus ' + df + ' of ' + day.length + ' during the day.' });
      }
    }

    if (ctx.mapping.job_id >= 0 || ctx.mapping.invoice_id >= 0 || ctx.mapping.estimate_id >= 0) {
      var un = pay.filter(function (r) { return !r.rec.ids.length; }), li = pay.filter(function (r) { return r.rec.ids.length; });
      if (un.length >= 3 && li.length) {
        var uf = un.filter(isFlag).length, lf = li.filter(isFlag).length, dd = uf / un.length - lf / li.length;
        if (dd >= 0.25) out.push({ strength: dd * 100, text: un.length + ' payments have no job, invoice or estimate and ' + uf + ' of them are flagged; of the ' + li.length + ' linked payments only ' + lf + ' are flagged.' });
      }
    }

    var repeat = cases.filter(function (c) { return c.rows.length >= 2; });
    if (repeat.length) {
      var rowsIn = repeat.reduce(function (s, c) { return s + c.rows.length; }, 0), flaggedRows = all.filter(isFlag).length;
      if (rowsIn >= 3) out.push({ strength: 15 + rowsIn, text: plural(repeat.length, 'customer') + ' account' + (repeat.length === 1 ? 's' : '') + ' for ' + rowsIn + ' of the ' + flaggedRows + ' flagged rows: ' + joinList(repeat.slice(0, 3).map(function (c) { return c.name + ' (' + c.rows.length + ')'; })) + '.' });
    }

    var bank = 0, card = 0, bankUntil = 0, cardUntil = 0;
    fp.forEach(function (r) {
      var rev = reversal(r.rec);
      if (!rev) return;
      if (rev.kind === 'bank') { bank += r.rec.amount; bankUntil = Math.max(bankUntil, rev.until); }
      else { card += r.rec.amount; cardUntil = Math.max(cardUntil, rev.until); }
    });
    if (bank > 0) out.push({ strength: 10 + pctOf(bank, flagAmt) / 2, text: f(bank) + ' of your flagged money (' + pctOf(bank, flagAmt) + '%) is bank payments that can still be reversed — the latest window runs to about ' + dayFull(bankUntil) + '.' });
    if (card > 0 && pctOf(card, flagAmt) >= 20) out.push({ strength: 8 + pctOf(card, flagAmt) / 2, text: f(card) + ' of your flagged money (' + pctOf(card, flagAmt) + '%) is card payments that can still be disputed — the latest window runs to about ' + dayFull(cardUntil) + '.' });

    out.sort(function (a, b) { return b.strength - a.strength; });
    return out.slice(0, 5);
  }

  /* -------------------------------------------------------------------- tips */

  function buildTips(analysis, cases, insights) {
    var ctx = analysis.ctx, all = analysis.results, tips = [];
    var isFlag = function (r) { return r.category === 'Fraud' || r.category === 'Review'; };
    var pays = all.filter(function (r) { return !r.rec.isFailed && isFinite(r.rec.amount); });
    var flagged = pays.filter(isFlag), med = ctx.median;
    var f = function (n) { return fm(n, ctx); };
    var has = function (id) { return flagged.filter(function (r) { return hitOf(r, id); }); };

    var disp = flagged.filter(function (r) { return r.override; });
    if (disp.length) tips.push('Answer the open dispute' + (disp.length > 1 ? 's' : '') + ' (' + joinList(disp.slice(0, 3).map(function (r) { return (r.rec.display || 'row ' + r.rec.line) + (r.rec.idLabel ? ', ' + r.rec.idLabel : ''); })) + ') before your processor\'s deadline, using the records you have for ' + (disp.length > 1 ? 'each' : 'it') + '.');

    var burst = cases.filter(function (c) { return c.failed >= 3; });
    if (burst.length) tips.push('After 3 failed attempts on one customer within an hour (' + joinList(burst.slice(0, 2).map(function (c) { return c.name + ' on ' + dayLabel(c.rows[0].rec.date.ts); })) + '), stop retrying and ask for a different payment method.');

    var fast = cases.filter(function (c) { return c.lead && hitOf(c.lead, 'R3'); });
    if (fast.length) tips.push('If a customer pays 3 or more times in a day (' + joinList(fast.slice(0, 3).map(function (c) { return c.name; })) + ' here), call before accepting more.');

    var big = has('R4');
    if (big.length && med > 0) tips.push('House rule: any payment above ' + f(3 * med) + ' (3× your median of ' + f(med) + ') gets a phone call to the customer before you start the job. ' + plural(big.length, 'flagged payment') + ' in this file ' + (big.length === 1 ? 'was' : 'were') + ' above that.');

    var bankRows = flagged.filter(function (r) { var rev = reversal(r.rec); return rev && rev.kind === 'bank'; });
    if (bankRows.length) tips.push('Ask your payment provider when bank transfers become final. Until then, don\'t release materials or payouts on large ones — in this file that\'s ' + f(bankRows.reduce(function (s, r) { return s + r.rec.amount; }, 0)) + ' across ' + plural(bankRows.length, 'payment') + '.');

    var unlinked = pays.filter(function (r) { return !r.rec.ids.length; }), unlFlagged = unlinked.filter(isFlag);
    if (analysis.ctx.mapping && (analysis.ctx.mapping.job_id >= 0 || analysis.ctx.mapping.invoice_id >= 0 || analysis.ctx.mapping.estimate_id >= 0) && unlFlagged.length >= 2) {
      tips.push('Attach a job or invoice to every payment: ' + unlinked.length + ' of ' + pays.length + ' payments here have none, and ' + unlFlagged.length + ' of those are flagged. A payment with no paperwork is hard to defend if it\'s disputed.');
    }

    var off = analysis.avail.filter(function (a) { return !a.ok && /email|card|country/i.test(a.missing.join(' ')); });
    if (off.length) {
      var lacking = uniq([].concat.apply([], off.map(function (a) { return a.missing; }))).filter(function (m) { return /email|card|country/i.test(m); });
      tips.push('Your export has no ' + joinList(lacking.map(function (m) { return m.toLowerCase(); })) + ', so ' + off.length + ' checks (' + joinList(off.slice(0, 3).map(function (a) { return a.name.toLowerCase(); })) + ') can\'t run, and repeat customers are matched by name only. If your CRM can add it, results get sharper.');
    }
    if (tips.length < 3) tips.push('For large first-time jobs, take a deposit through a method you can verify before ordering materials.');
    return tips.slice(0, 6);
  }

  /* ------------------------------------------------------------------- recap */

  function buildRecap(analysis, t, summary) {
    var flaggedRules = {}, order = [];
    analysis.results.forEach(function (res) {
      if (res.category !== 'Fraud' && res.category !== 'Review') return;
      res.hits.forEach(function (h) {
        if (!flaggedRules[h.id]) { flaggedRules[h.id] = { id: h.id, name: h.name, count: 0, amount: 0 }; order.push(h.id); }
        flaggedRules[h.id].count++;
        flaggedRules[h.id].amount += isFinite(res.rec.amount) && !res.rec.isFailed ? res.rec.amount : 0;
      });
    });
    var pointsById = {};
    RULES.forEach(function (r) { pointsById[r.id] = r.points; });
    var top = order.map(function (id) { return flaggedRules[id]; }).sort(function (a, b) {
      return pointsById[b.id] - pointsById[a.id] || b.count - a.count || b.amount - a.amount;
    });

    var cases = buildCases(analysis.results);
    var insights = buildInsights(analysis, summary, cases);
    var tips = buildTips(analysis, cases, insights);
    var ruleStats = analysis.avail.map(function (a) {
      var fired = 0;
      analysis.results.forEach(function (res) { if (res.hits.some(function (h) { return h.id === a.id; })) fired++; });
      return { id: a.id, name: a.name, points: a.points, ok: a.ok, missing: a.missing, fired: fired };
    });
    var flagged = { count: summary.byCat.Fraud.count + summary.byCat.Review.count, amount: summary.byCat.Fraud.amount + summary.byCat.Review.amount };
    return { flagged: flagged, topReasons: top, cases: cases, insights: insights, tips: tips, ruleStats: ruleStats };
  }

  /* --------------------------------------------------------------------- CSV */

  function csvCell(v) {
    var s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // keeps spreadsheets from running uploaded text as a formula
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function resultsToCSV(results) {
    var head = ['source_row', 'customer', 'date', 'amount', 'payment_type', 'channel', 'status', 'category', 'score',
      'summary', 'next_step', 'reversible_until', 'evidence', 'rules_fired', 'edited_here'];
    var lines = [head.join(',')];
    results.forEach(function (res) {
      var r = res.rec, st = res.story || { headline: '', step: '', untilTs: null };
      var evidence = res.nei ? [res.nei] : res.hits.map(function (h) { return h.detail; });
      lines.push([
        r.line, csvCell(r.display), csvCell(r.dateText), isFinite(r.amount) ? r.amount : '',
        csvCell(r.type), csvCell(r.channel), csvCell(r.statusText), csvCell(res.category), res.score,
        csvCell(st.headline), csvCell(st.step), st.untilTs ? dayFull(st.untilTs) : '',
        csvCell(evidence.join(' | ')), csvCell(res.hits.map(function (h) { return h.id; }).join(' ')),
        csvCell((r.added ? ['row added here'] : []).concat(r.edited || []).join('; '))
      ].join(','));
    });
    return lines.join('\n');
  }

  return {
    CATEGORIES: CATEGORIES, DEFAULT_THRESHOLDS: DEFAULT_THRESHOLDS, MIN_EVALUABLE: MIN_EVALUABLE,
    FIELDS: FIELDS, GROUP_LABELS: GROUP_LABELS, RULES: RULES,
    MIN_ROWS: MIN_ROWS, MAX_FIX_CELLS: MAX_FIX_CELLS, DELIMITERS: DELIMITERS, DELIMITER_NAMES: DELIMITER_NAMES, MESSAGES: MESSAGES,
    parseCSV: parseCSV, checkShape: checkShape, appendRows: appendRows, applyEdits: applyEdits, message: message,
    validateIntake: validateIntake, guessMapping: guessMapping, ruleAvailability: ruleAvailability,
    parseAmount: parseAmount, parseDate: parseDate,
    analyze: analyze, categorize: categorize, summarize: summarize, buildRecap: buildRecap,
    resultsToCSV: resultsToCSV, formatMoney: formatMoney, formatDate: formatDate, dayFull: dayFull, dayLabel: dayLabel,
    _parseAmount: parseAmount, _parseDate: parseDate
  };
});
