/* Extras.js: load AFTER Script.js (non-module script)
   1) Chat is per day. Each day keeps its own saved conversation; entries go to the day that's open.
   2) Chart requests: "I want a chart on food expenses of last month", with switchable chart type. */
(() => {
const MFULL = 'January February March April May June July August September October November December'.split(' ');
const MN = MFULL.map(m => m.slice(0, 3));
const NUMW = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
const p2 = n => String(n).padStart(2, '0');
const dkey = d => `${p2(d.getDate())}-${p2(d.getMonth() + 1)}-${d.getFullYear()}`;
const todayKey = () => dkey(new Date());
const sod = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addD = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const sum = a => a.reduce((s, v) => s + v, 0);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sh = n => { const a = Math.abs(n); return a >= 1e6 ? +(n / 1e6).toFixed(1) + 'M' : a >= 1e3 ? +(n / 1e3).toFixed(1) + 'k' : Math.round(n); };
const norm = t => t.replace(/\bexp[ea]n[sc]e?s?\b/g, 'expenses').replace(/\bgr[ae]p[hf]s?\b|\bgrap\b/g, 'graph').replace(/\bchar[rt]s?\b/g, 'chart');
const hexA = (h, a) => { h = String(h).replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); const n = parseInt(h, 16) || 0; return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };

/* ───────── per-day chat ─────────
   Every day has its own saved conversation. Open a day (sidebar or date picker) and anything you
   add that doesn't name a date is filed under THAT day, and its messages are saved to that day's chat. */
const NS = window.DC_NS || '';
const LS = NS + 'dailycal.chat.v2';
let chats = {};
try { const c = JSON.parse(localStorage.getItem(LS)); if (c && typeof c === 'object' && !Array.isArray(c)) chats = c; } catch (err) { /* ignore */ }
let viewKey = todayKey(), replaying = false, live = [];

const save = () => {
  const out = {};
  Object.keys(chats).forEach(k => { if (Array.isArray(chats[k]) && chats[k].length) out[k] = chats[k].slice(-200); });
  try { localStorage.setItem(LS, JSON.stringify(out)); } catch (err) { /* ignore */ }
};
const log = m => { if (!replaying) { (chats[viewKey] = chats[viewKey] || []).push(m); save(); } return m; };

const _u = addUserMessage, _b = addBotText, _t = addBotTable;
addUserMessage = t => { _u(t); log({ k: 'u', t }); };
addBotText = t => { _b(t); log({ k: 'b', t }); };
addBotTable = rows => { _t(rows); log({ k: 't', ids: rows.map(r => r.txId).filter(Boolean) }); };

function clearChat() { live.forEach(c => c.destroy()); live = []; chatLog.innerHTML = ''; }
function leaveChat() { hero.classList.remove('vanish'); quickActions.classList.remove('vanish'); homeView.classList.remove('chat-mode'); }

function renderMsg(m) {
  if (m.k === 'u') _u(m.t);
  else if (m.k === 'b') _b(m.t);
  else if (m.k === 't') {
    const all = DC.Store.all();
    const rows = (m.ids || []).map(id => all.find(x => x.id === id)).filter(Boolean).map(t => DC.Store.toRow(t));
    if (rows.length) _t(rows);
  } else if (m.k === 'c') renderChart(m);
}

const LONG_DAY = d => `${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()]}, ${d.getDate()} ${MFULL[d.getMonth()]} ${d.getFullYear()}`;
const inputDate = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

function dayBanner(day) {
  const b = el('div', 'day-banner');
  const t = el('div', 'day-banner-text');
  t.append(el('strong', '', LONG_DAY(day)), el('span', '', 'Anything you add here without a date is saved to this day.'));
  const back = el('button', 'day-banner-back', 'Back to today');
  back.type = 'button';
  back.addEventListener('click', () => showDay(new Date()));
  b.append(t, back);
  chatLog.appendChild(b);
}

function showDay(d) {
  const day = sod(d), k = dkey(day), isToday = k === todayKey();
  if (day.getTime() > sod(new Date()).getTime()) return;          // no future days
  viewKey = k; setActiveDay(isToday ? null : day);
  clearChat(); replaying = true;
  try {
    if (!isToday) dayBanner(day);
    const saved = chats[k] || [];
    if (saved.length) { enterChatMode(); saved.forEach(renderMsg); if (isToday && !chatLog.children.length) leaveChat(); }
    else {
      const recs = DC.Store.onDay(day);
      if (recs.length) {
        enterChatMode(); replaying = false;                       // first open: save the intro + table into this day's chat
        showRecords(recs, { found: isToday ? 'Here is everything recorded today' : `Here is ${k}`, empty: '' });
      } else if (isToday) leaveChat();
      else { enterChatMode(); _b(`Nothing recorded for ${k} yet. What you add here goes on this day.`); }
    }
  } finally { replaying = false; }
  const pick = document.getElementById('dayPicker');
  if (pick) pick.value = isToday ? '' : inputDate(day);
  DC.renderHistory();
  scrollToBottom();
}

DC.handlers.dayClick = d => { switchTab('home'); showDay(d); };

const _send = handleSend;
handleSend = function (p) {
  // rolled past midnight while viewing "today"? refresh to the new today first
  if (!activeDay && viewKey !== todayKey()) showDay(new Date());
  return _send(p);
};

const pickEl = document.getElementById('dayPicker');
if (pickEl) {
  const syncMax = () => { pickEl.max = inputDate(new Date()); };
  syncMax();
  pickEl.addEventListener('focus', syncMax);
  pickEl.addEventListener('change', () => {
    const m = pickEl.value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) { switchTab('home'); showDay(new Date(+m[1], +m[2] - 1, +m[3])); }
  });
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !activeDay && viewKey !== todayKey()) { showDay(new Date()); }
});

/* ───────── clear chats (transactions are never touched) ───────── */
function clearThisChat() {
  const [d, m, y] = viewKey.split('-').map(Number);
  chats[viewKey] = [{ k: 'x' }]; save();          // a marker keeps the day from re-filling itself with its records
  showDay(new Date(y, m - 1, d));
}
function clearAllChats() { chats = {}; chats[todayKey()] = [{ k: 'x' }]; save(); showDay(new Date()); }
DC.clearChat = clearThisChat; window.DC_clearAllChats = clearAllChats;

/* "Clear chat" lives in the header, next to the day picker, and clears only the day you are looking at. */
(function addClearChatButton() {
  const actions = document.querySelector('.header-actions');
  if (!actions || document.getElementById('clearChatBtn')) return;
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'icon-circle'; b.id = 'clearChatBtn'; b.hidden = true;
  b.setAttribute('aria-label', "Clear this day's chat"); b.title = "Clear this day's chat";
  b.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
  actions.insertBefore(b, actions.firstChild);

  const hasMessages = () => Array.from(chatLog.children).some(n => !n.classList.contains('day-banner'));
  const refresh = () => { b.hidden = document.body.getAttribute('data-tab') !== 'home' || !hasMessages(); };
  new MutationObserver(refresh).observe(chatLog, { childList: true });
  new MutationObserver(refresh).observe(document.body, { attributes: true, attributeFilter: ['data-tab'] });
  refresh();

  b.addEventListener('click', () => {
    const [d, m, y] = viewKey.split('-').map(Number);
    const label = viewKey === todayKey() ? "today's" : LONG_DAY(new Date(y, m - 1, d)) + "'s";
    if (confirm('Clear ' + label + ' chat? Your transactions are kept.')) clearThisChat();
  });
})();

/* ───────── chart requests ───────── */
function parseRange(t) {
  const now = sod(new Date());
  const R = (a, b, label) => ({ from: a.getTime(), to: Math.min(b.getTime(), now.getTime()), label });
  const mon = (y, m) => R(new Date(y, m, 1), new Date(y, m + 1, 0), `${MFULL[m]} ${y}`);
  const num = s => /^\d+$/.test(s) ? +s : NUMW[s];
  let m;
  if (/\b(all time|overall|ever|lifetime|entire history|since the beginning)\b/.test(t)) return { all: true, label: 'All time' };
  if (/\bday before yesterday\b/.test(t)) return R(addD(now, -2), addD(now, -2), 'Day before yesterday');
  if (/\byesterday/.test(t)) return R(addD(now, -1), addD(now, -1), 'Yesterday');
  if (/\b(today|tonight|this morning|this afternoon|this evening)/.test(t)) return R(now, now, 'Today');
  if ((m = t.match(/\b(?:last|past|previous)\s+(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+(day|week|month|year)s?\b/))) {
    const n = num(m[1]), u = m[2];
    const a = u === 'day' ? addD(now, -(n - 1)) : u === 'week' ? addD(now, -(7 * n - 1))
      : u === 'month' ? new Date(now.getFullYear(), now.getMonth() - n, now.getDate()) : new Date(now.getFullYear() - n, now.getMonth(), now.getDate());
    return R(a, now, `Last ${n} ${u}${n > 1 ? 's' : ''}`);
  }
  if (/\blast week\b/.test(t)) { const s = addD(now, -((now.getDay() + 6) % 7) - 7); return R(s, addD(s, 6), 'Last week'); }
  if (/\bthis week\b/.test(t)) return R(addD(now, -((now.getDay() + 6) % 7)), now, 'This week');
  if (/\b(last|previous) month\b/.test(t)) { const d = new Date(now.getFullYear(), now.getMonth() - 1, 1); return mon(d.getFullYear(), d.getMonth()); }
  if (/\bthis month\b/.test(t)) return mon(now.getFullYear(), now.getMonth());
  if (/\blast year\b/.test(t)) return R(new Date(now.getFullYear() - 1, 0, 1), new Date(now.getFullYear() - 1, 11, 31), String(now.getFullYear() - 1));
  if (/\bthis year\b/.test(t)) return R(new Date(now.getFullYear(), 0, 1), now, String(now.getFullYear()));
  if ((m = t.match(/\b(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+(day|week|month)s?\s+ago\b/))) {
    const n = num(m[1]);
    if (m[2] === 'day') return R(addD(now, -n), addD(now, -n), dkey(addD(now, -n)));
    if (m[2] === 'week') return R(addD(now, -7 * n - 6), addD(now, -7 * n), `${n} week${n > 1 ? 's' : ''} ago`);
    const d = new Date(now.getFullYear(), now.getMonth() - n, 1); return mon(d.getFullYear(), d.getMonth());
  }
  if ((m = t.match(DATE_RE))) { const d = parseDate(m[0]); return R(d, d, dkey(d)); }
  if ((m = t.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\b(?:\s+(?:of\s+)?(20\d{2}))?/))) {
    const mi = MONTH_INDEX[m[1].slice(0, 3)];
    return mon(m[2] ? +m[2] : (mi > now.getMonth() ? now.getFullYear() - 1 : now.getFullYear()), mi);
  }
  if ((m = t.match(/\b(20\d{2})\b/))) return R(new Date(+m[1], 0, 1), new Date(+m[1], 11, 31), m[1]);
  return mon(now.getFullYear(), now.getMonth());
}

function parseChart(raw) {
  const t = norm(raw.toLowerCase()).replace(/[\u2018\u2019]/g, "'"), clean = t.replace(/\bshows?\b/g, ' ');
  const sp = { cats: [], detail: [], method: null, metric: 'expense', group: null, type: null };
  sp.type = /\b(doughnut|donut)\b/.test(t) ? 'doughnut' : /\bpie\b/.test(t) ? 'pie' : /\b(radar|spider)\b/.test(t) ? 'radar'
    : /\bpolar\b/.test(t) ? 'polarArea' : /\bhorizontal\b/.test(t) ? 'hbar' : /\barea\b/.test(t) ? 'area'
    : /\b(line|trends?|over time)\b/.test(t) ? 'line' : /\b(bar|column|histogram)\b/.test(t) ? 'bar' : null;

  const inc = /\b(income|gains?|earn\w*|salary|received|inflow|revenue|wages?)\b/.test(t);
  const exp = /\b(expenses?|spend\w*|spent|costs?|paid|outflow|purchases?|expenditure)\b/.test(t);
  sp.metric = inc && exp ? 'both' : inc ? 'income' : 'expense';

  const cats = new Set();
  for (const [k, v] of Object.entries(CAT_ALIASES)) if (new RegExp('\\b' + k + '\\b').test(t)) cats.add(v);
  Object.keys(CATEGORY_DEFS).forEach(n => { if (t.includes(n.toLowerCase())) cats.add(n); });
  if (!cats.size) CATEGORIES.forEach(c => { if (c.items.test(clean)) cats.add(c.name); });
  cats.delete('Income');
  sp.cats = [...cats];

  const skip = new Set(Object.keys(CATEGORY_DEFS).map(n => n.toLowerCase())), seen = new Set();
  DC.Store.all().forEach(x => {
    const d = String(x.detail || '').toLowerCase().trim();
    if (d.length < 3 || seen.has(d) || skip.has(d) || CAT_ALIASES[d] || /specified/.test(d)) return;
    seen.add(d);
    if (new RegExp('(?<![\\p{L}\\p{N}])' + esc(d) + '(?:s|es)?(?![\\p{L}\\p{N}])', 'u').test(t)) sp.detail.push(d);
  });

  const cash = /\bcash\b(?!\s*-?\s*flow)/.test(t), card = /\b(card|bank|online)\b/.test(t);
  if (cash && card) sp.group = 'method'; else if (cash) sp.method = 'Cash'; else if (card) sp.method = NON_CASH_METHOD;

  const G = [[/\b(by|per|each|every)\s+(categor\w+|type)|breakdown|distribution|\bsplit\b|proportion|percentage|\bshare\b/, 'category'],
    [/\b(by|per|each|every)\s+(items?|details?|thing)|\bitems?\b/, 'detail'],
    [/\b(by|per|each|every|vs|versus)\s+(payment|method)/, 'method'],
    [/\b(daily|by day|per day|each day|every day|day by day)\b/, 'day'],
    [/\b(weekly|by week|per week|each week)\b/, 'week'],
    [/\b(monthly|by month|per month|each month|month by month)\b/, 'month']];
  if (!sp.group) for (const [r, k] of G) if (r.test(t)) { sp.group = k; break; }

  Object.assign(sp, parseRange(t));
  if (sp.all) { const ts = DC.Store.all().map(x => x.ts); sp.from = ts.length ? Math.min(...ts) : Date.now(); sp.to = sod(new Date()).getTime(); }
  const days = Math.round((sp.to - sp.from) / 864e5) + 1, pie = ['pie', 'doughnut', 'polarArea'].includes(sp.type);
  if (!sp.group) {
    if (pie || sp.cats.length > 1 || days <= 1)
      sp.group = sp.metric === 'income' || (sp.cats.length < 2 && (sp.cats.length === 1 || sp.detail.length)) ? 'detail' : 'category';
    else sp.group = days <= 62 ? 'day' : days <= 210 ? 'week' : 'month';
  }
  sp.type = sp.type || (['day', 'week', 'month'].includes(sp.group) ? 'bar' : 'doughnut');
  const who = [...sp.cats, ...sp.detail.map(d => d.replace(/(^|\s)\p{L}/gu, c => c.toUpperCase()))].join(', ');
  sp.title = `${who ? who + ' ' : ''}${sp.metric === 'both' ? 'Income vs Expenses' : sp.metric === 'income' ? 'Income' : 'Expenses'} · ${sp.label}`;
  return sp;
}

function buildData(sp) {
  const S = DC.getSettings();
  const rows = DC.Store.all().filter(t => t.ts >= sp.from && t.ts <= sp.to &&
    (!sp.detail.length || sp.detail.includes(String(t.detail).toLowerCase())) && (!sp.method || t.method === sp.method));
  const isExp = t => t.category !== 'Income' && t.category !== 'Transfer' && (S.countSavings || !['Savings', 'Investment'].includes(t.category));
  const sets = [];
  if (sp.metric !== 'expense') sets.push({ name: 'Income', rows: rows.filter(t => t.category === 'Income'), color: S.accent });
  if (sp.metric !== 'income') sets.push({ name: 'Expenses', rows: rows.filter(t => sp.cats.length ? sp.cats.includes(t.category) : isExp(t)), color: S.negative });

  const G = sp.group, wk = ts => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (d.getDay() + 6) % 7).getTime(); };
  let keys = [], labels = [], keyOf;
  if (G === 'day') {
    for (let c = new Date(sp.from); c.getTime() <= sp.to; c.setDate(c.getDate() + 1)) { keys.push(c.getTime()); labels.push(`${c.getDate()} ${MN[c.getMonth()]}`); }
    keyOf = t => t.ts;
  } else if (G === 'week') {
    for (let c = new Date(wk(sp.from)); c.getTime() <= sp.to; c.setDate(c.getDate() + 7)) { keys.push(c.getTime()); labels.push(`${c.getDate()} ${MN[c.getMonth()]}`); }
    keyOf = t => wk(t.ts);
  } else if (G === 'month') {
    const f = new Date(sp.from);
    for (let c = new Date(f.getFullYear(), f.getMonth(), 1); c.getTime() <= sp.to; c.setMonth(c.getMonth() + 1)) { keys.push(c.getTime()); labels.push(`${MN[c.getMonth()]} ${String(c.getFullYear()).slice(2)}`); }
    keyOf = t => { const d = new Date(t.ts); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };
  } else {
    const f = t => t[G === 'category' ? 'category' : G === 'method' ? 'method' : 'detail'], tot = {};
    sets.forEach(s => s.rows.forEach(t => { tot[f(t)] = (tot[f(t)] || 0) + t.amount; }));
    keys = Object.keys(tot).sort((a, b) => tot[b] - tot[a]); keyOf = f;
    if (keys.length > 12) { const top = new Set(keys.slice(0, 11)); keyOf = t => top.has(f(t)) ? f(t) : 'Other'; keys = [...top, 'Other']; }
    labels = keys;
  }
  sets.forEach(s => {
    const m = new Map(keys.map(k => [k, 0]));
    s.rows.forEach(t => { const k = keyOf(t); if (m.has(k)) m.set(k, m.get(k) + t.amount); });
    s.data = keys.map(k => +m.get(k).toFixed(2)); s.total = sum(s.data);
  });
  return { labels, series: sets, time: ['day', 'week', 'month'].includes(G), count: sum(sets.map(s => s.rows.length)) };
}

const TYPES = [['bar', 'Bar'], ['hbar', 'Horizontal'], ['line', 'Line'], ['area', 'Area'], ['pie', 'Pie'], ['doughnut', 'Donut'], ['polarArea', 'Polar'], ['radar', 'Radar']];

function config(d, type) {
  const S = DC.getSettings(), pal = S.chartColors, pieLike = ['pie', 'doughnut', 'polarArea'].includes(type), barLike = type === 'bar' || type === 'hbar';
  Chart.defaults.color = S.muted; Chart.defaults.borderColor = S.border;
  let labels = d.labels, ds;
  if (pieLike) {
    if (d.series.length > 1) { labels = d.series.map(s => s.name); ds = [{ data: d.series.map(s => s.total), backgroundColor: d.series.map(s => s.color) }]; }
    else {
      const ix = d.labels.map((_, i) => i).filter(i => d.series[0].data[i] > 0);
      labels = ix.map(i => d.labels[i]); ds = [{ data: ix.map(i => d.series[0].data[i]), backgroundColor: ix.map(i => pal[i % pal.length]) }];
    }
    ds[0].borderColor = S.card; ds[0].borderWidth = 2;
  } else {
    const multi = !d.time && d.series.length === 1;
    ds = d.series.map(s => ({
      label: s.name, data: s.data, borderColor: s.color, pointBackgroundColor: s.color,
      backgroundColor: barLike ? (multi ? s.data.map((_, j) => pal[j % pal.length]) : s.color) : (type === 'line' ? s.color : hexA(s.color, 0.2)),
      fill: type === 'area' || type === 'radar', tension: S.tension, borderWidth: barLike ? 0 : S.lineWidth,
      pointRadius: d.labels.length > 40 ? 0 : S.pointRadius, borderRadius: barLike ? 4 : 0, maxBarThickness: 36
    }));
  }
  const grid = { color: hexA(S.muted, 0.16) };
  const opt = {
    responsive: true, maintainAspectRatio: false, animation: S.chartAnim ? { duration: 500 } : false,
    plugins: {
      legend: { display: pieLike || ds.length > 1, position: 'bottom', labels: { color: S.muted, usePointStyle: true, boxWidth: 8 } },
      tooltip: { callbacks: { label: c => ` ${pieLike ? c.label : (c.dataset.label || '')}: ${DC.money(c.raw)}` } }
    }
  };
  if (type === 'radar' || type === 'polarArea') opt.scales = { r: { beginAtZero: true, grid, angleLines: grid, ticks: { backdropColor: 'transparent', color: S.muted, callback: sh } } };
  else if (!pieLike) {
    const v = { beginAtZero: true, grid: S.showGrid ? grid : { display: false }, ticks: { color: S.muted, callback: sh }, border: { display: false } };
    const c = { grid: { display: false }, ticks: { color: S.muted, maxRotation: 60, autoSkip: true } };
    opt.scales = type === 'hbar' ? { x: v, y: c } : { x: c, y: v };
    if (type === 'hbar') opt.indexAxis = 'y';
  }
  if (type === 'doughnut') opt.cutout = S.cutout + '%';
  return { type: type === 'hbar' ? 'bar' : type === 'area' ? 'line' : type, data: { labels, datasets: ds }, options: opt };
}

const SPECIAL = [
  [/\b(pace|on track|run ?rate)\b/, 'pace'],
  [/\b(net savings?|projected (savings?|balance)|savings? (forecast|projection)|balance (forecast|projection))\b/, 'netsave'],
  [/\b(forecast|predict\w*|projection|projected|future)\b/, 'forecast']
];

function special(kind) {
  const F = DC.computeForecast(), S = DC.getSettings();
  if (!F || F.empty) return null;
  const n = F.hist.length, L = F.labels.length, blank = () => new Array(L).fill(null);
  const base = { tension: S.tension, borderWidth: S.lineWidth, pointRadius: S.pointRadius, pointHoverRadius: S.pointRadius + 2 };
  const solid = (label, data, c) => Object.assign({ label, data, borderColor: c, backgroundColor: c, pointBackgroundColor: c }, base);
  const hollow = (label, data, c) => Object.assign({ label, data }, base, { borderColor: c, borderDash: [7, 5], backgroundColor: S.card, pointBackgroundColor: S.card, pointBorderColor: c, pointBorderWidth: 2 });
  let labels = F.labels, ds, title, sub, zero = true;
  if (kind === 'forecast') {
    const eA = blank(), iA = blank(), eF = blank(), iF = blank();
    F.hist.forEach((h, i) => { eA[i] = h.expenses; iA[i] = h.income; });
    if (n > 0) { eF[n - 1] = F.hist[n - 1].expenses; iF[n - 1] = F.hist[n - 1].income; }
    for (let k = 0; k <= F.M; k++) { eF[n + k] = F.fe[k]; iF[n + k] = F.fi[k]; }
    ds = [solid('Expenses', eA, S.negative), hollow('Expenses (forecast)', eF, S.negative), solid('Income', iA, S.accent), hollow('Income (forecast)', iF, S.accent)];
    title = 'Income and expenses: history and forecast';
    sub = `Next month: expenses ${DC.money(F.fe[1])} · income ${DC.money(F.fi[1])}`;
  } else if (kind === 'netsave') {
    const bA = blank(), bF = blank(), bN = blank();
    F.balHist.forEach((v, i) => { bA[i] = v; });
    bF[n > 0 ? n - 1 : n] = F.proj[0];
    for (let k = 1; k <= F.steps; k++) bF[n + k - 1] = F.proj[k];
    bN[n] = F.proj[0] + F.cur.net;
    ds = [Object.assign(solid('Net savings', bA, S.accent), { fill: true, backgroundColor: hexA(S.accent, 0.14) }), hollow('Net savings (forecast)', bF, S.secondary),
      { label: 'Now (incl. this month so far)', data: bN, showLine: false, pointStyle: 'rectRot', pointRadius: 7, backgroundColor: S.accent, borderColor: S.accent }];
    title = 'Projected net savings'; sub = `By ${F.labels[L - 1]}: ${DC.money(F.proj[F.steps])}`; zero = false;
  } else {
    labels = Array.from({ length: F.dim }, (_, i) => String(i + 1));
    const act = new Array(F.dim).fill(null), pace = new Array(F.dim).fill(null), typ = new Array(F.dim).fill(null);
    let cum = 0;
    for (let d = 0; d < F.dom; d++) { cum += F.cur.daily[d] || 0; act[d] = cum; }
    const rate = F.cur.expenses / F.dom;
    for (let d = F.dom - 1; d < F.dim; d++) pace[d] = F.cur.expenses + rate * (d - (F.dom - 1));
    for (let d = 0; d < F.dim; d++) typ[d] = F.fe[0] * (d + 1) / F.dim;
    const nop = { pointRadius: 0, pointHoverRadius: 4 };
    ds = [Object.assign(solid('Spent so far', act, S.negative), nop, { fill: true, backgroundColor: hexA(S.negative, 0.14) }),
      Object.assign(hollow('Current pace', pace, S.negative), nop), Object.assign(hollow('Typical month (forecast)', typ, S.secondary), nop, { borderDash: [2, 4] })];
    if (S.budget > 0) ds.push(Object.assign(hollow('Budget', new Array(F.dim).fill(S.budget), S.accent), nop, { borderDash: [10, 4] }));
    title = "This month's pace"; sub = `At this rate: ${DC.money(F.pace)} by month end · ${DC.money(F.cur.expenses)} so far`;
  }
  Chart.defaults.color = S.muted; Chart.defaults.borderColor = S.border;
  const grid = { color: hexA(S.muted, 0.16) };
  return { title, sub, config: { type: 'line', data: { labels, datasets: ds }, options: {
    responsive: true, maintainAspectRatio: false, animation: S.chartAnim ? { duration: 500 } : false, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: true, position: 'bottom', labels: { color: S.muted, usePointStyle: true, boxWidth: 8 } }, tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${DC.money(c.raw)}` } } },
    scales: { x: { grid: { display: false }, ticks: { color: S.muted, maxRotation: 60, autoSkip: true } }, y: { beginAtZero: zero, grid: S.showGrid ? grid : { display: false }, ticks: { color: S.muted, callback: sh }, border: { display: false } } } } } };
}

function renderSpecial(msg) {
  if (typeof Chart === 'undefined') return _b('Chart.js could not be loaded. Check your connection and reload.');
  const x = special(msg.spec.kind);
  if (!x) return _b("There isn't enough data yet to draw that chart. Add a few expenses first.");
  const row = el('div', 'msg-row bot'), b = el('div', 'bubble bot-bubble chart-bubble'), box = el('div', 'chart-box'), cv = el('canvas');
  b.append(el('div', 'chart-title', x.title), el('div', 'chart-sub', x.sub), box);
  box.appendChild(cv); row.appendChild(b); chatLog.appendChild(row);
  live.push(new Chart(cv, x.config)); scrollToBottom();
}

function renderChart(msg) {
  if (msg.spec.kind) return renderSpecial(msg);
  const sp = msg.spec, d = buildData(sp), ownerKey = viewKey;
  if (typeof Chart === 'undefined') return _b('Chart.js could not be loaded. Check your connection and reload.');
  if (!d.count) return _b(`No records found for ${sp.title}.`);
  const row = el('div', 'msg-row bot'), b = el('div', 'bubble bot-bubble chart-bubble'), box = el('div', 'chart-box'), cv = el('canvas'), sw = el('div', 'type-switch');
  let hi = '';
  if (d.series.length === 1) { const s = d.series[0], m = Math.max(...s.data); hi = ` · Highest: ${d.labels[s.data.indexOf(m)]} (${DC.money(m)})`; }
  b.append(el('div', 'chart-title', sp.title),
    el('div', 'chart-sub', d.series.map(s => `${s.name}: ${DC.money(s.total)}`).join(' · ') + ` · ${d.count} record${d.count === 1 ? '' : 's'}${hi}`), sw, box);
  box.appendChild(cv); row.appendChild(b); chatLog.appendChild(row);
  let ch; const btns = {};
  const draw = type => {
    if (ch) { ch.destroy(); live = live.filter(c => c !== ch); }
    ch = new Chart(cv, config(d, type)); live.push(ch); sp.type = type;
    Object.entries(btns).forEach(([k, x]) => x.classList.toggle('active', k === type));
  };
  TYPES.forEach(([id, l]) => {
    const x = el('button', 'type-btn', l); x.type = 'button'; btns[id] = x;
    x.addEventListener('click', () => { draw(id); if ((chats[ownerKey] || []).includes(msg)) save(); });
    sw.appendChild(x);
  });
  draw(sp.type); scrollToBottom();
}

function tryChart(text) {
  const t = norm(text.toLowerCase());
  if (!/\b(charts?|graphs?|plots?|pie|donut|doughnut|histogram|diagram|visuali[sz]\w*|trends?)\b/.test(t) &&
      !/\b(in|as|a|on)\s+(a\s+)?(bar|pie|donut|doughnut|radar)\b/.test(t)) return false;
  if (/\b(spent|paid|bought|cost)\b/.test(t) && findAmount(t)) return false;   // a normal expense like "paid 300 for chart paper"
  const kind = (SPECIAL.find(([r]) => r.test(t)) || [])[1];
  if (kind) { renderSpecial(log({ k: 'c', spec: { kind } })); return true; }
  const sp = parseChart(text);
  if (!buildData(sp).count) { addBotText(`I couldn't find any records for ${sp.title}, so there's nothing to chart yet.`); return true; }
  renderChart(log({ k: 'c', spec: sp }));
  return true;
}

const _q = tryQuery;
tryQuery = t => tryChart(t) || _q(t);

showDay(new Date());   // restore today's conversation on load
})();