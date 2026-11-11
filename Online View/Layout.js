/* Layout.js: wiring for the new shell. Loaded by Auth.js after Script.js and Extras.js. */
(() => {
  'use strict';
  if (typeof DC === 'undefined') return;
  const $ = id => document.getElementById(id);

  /* ───────── balance card ───────── */
  // Cash and bank are tracked separately: income adds, expenses subtract, and a Transfer is a pair of rows
  // (first row = where the money left, second row = where it arrived).
  function balances() {
    const S = DC.getSettings();
    let cash = Number(S.openingCash) || 0, bank = Number(S.openingBank) || 0;
    const move = (method, v) => { if (method === 'Cash') cash += v; else bank += v; };
    const txs = DC.Store.all();
    for (let i = 0; i < txs.length; i++) {
      const t = txs[i];
      if (t.category === 'Income') move(t.method, t.amount);
      else if (t.category === 'Savings' && /^bank deposit$/i.test(t.detail)) {
        // cash paid into the bank leaves the wallet AND arrives in the bank (it used to just vanish)
        if (t.method === 'Cash') { cash -= t.amount; bank += t.amount; }
      } else if (t.category === 'Transfer') {
        const n = txs[i + 1];
        if (n && n.category === 'Transfer' && n.amount === t.amount && n.ts === t.ts && n.method !== t.method) {
          move(t.method, -t.amount); move(n.method, t.amount); i++;
        }
      } else move(t.method, -t.amount);
    }
    return { cash, bank };
  }

  function put(id, text, tone) {
    const n = $(id);
    if (!n) return;
    n.textContent = text;
    if (tone !== undefined) { n.classList.remove('neg', 'pos'); if (tone) n.classList.add(tone); }
  }

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];


  /* ───────── expanded-card details ───────── */
  function fillRows(id, rows) {
    const box = $(id); if (!box) return;
    box.textContent = '';
    rows.forEach(([label, value, tone]) => {
      const r = document.createElement('div'); r.className = 'bal-line';
      const l = document.createElement('span'); l.textContent = label;
      const v = document.createElement('b'); v.textContent = value; if (tone) v.className = tone;
      r.append(l, v); box.appendChild(r);
    });
  }

  function fillList(id, txs, empty) {
    const box = $(id); if (!box) return;
    box.textContent = '';
    if (!txs.length) { const p = document.createElement('p'); p.className = 'mini-empty'; p.textContent = empty; box.appendChild(p); return; }
    txs.forEach(t => {
      const row = document.createElement('div'); row.className = 'mini-tx';
      const l = document.createElement('div'); l.className = 'l';
      const d = document.createElement('b'); d.textContent = t.detail || t.category;
      const m = document.createElement('small'); m.textContent = t.category + ' · ' + t.method + ' · ' + t.date + (t.note ? ' · ' + t.note : '');
      l.append(d, m);
      const a = document.createElement('span'); a.className = 'a';
      if (t.category === 'Income') { a.textContent = '+ ' + DC.money(t.amount); a.classList.add('pos'); }
      else if (t.category === 'Transfer') a.textContent = DC.money(t.amount);
      else { a.textContent = '− ' + DC.money(t.amount); a.classList.add('neg'); }
      row.append(l, a); box.appendChild(row);
    });
  }

  function renderDetails(S, now, dom, dim, b, a, counts, today) {
    const pctStr = n => (Math.round(n * 10) / 10) + '%';
    const prev = DC.agg(now.getFullYear(), now.getMonth() - 1);

    // card 1: balance
    const total = b.cash + b.bank, sp = $('splitWrap');
    if (sp) {
      const ok = total > 0 && b.cash >= 0 && b.bank >= 0;
      sp.hidden = !ok;
      if (ok) {
        const cp = b.cash / total * 100;
        $('splitCash').style.width = cp + '%';
        put('splitCashPct', Math.round(cp) + '%'); put('splitBankPct', Math.round(100 - cp) + '%');
      }
    }
    fillRows('c1Rows', [
      ['Started with', DC.money((Number(S.openingCash) || 0) + (Number(S.openingBank) || 0))],
      ['Income this month', DC.money(a.income), 'pos'],
      ['Spent this month', DC.money(a.expenses)],
      ['Net this month', (a.net > 0 ? '+ ' : '') + DC.money(a.net), a.net < 0 ? 'neg' : a.net > 0 ? 'pos' : '']
    ]);
    const latest = DC.Store.all().slice().sort((x, y) => y.ts - x.ts).slice(0, 5);
    fillList('c1List', latest, 'Nothing recorded yet.');

    // card 2: this month
    const rate = a.income > 0 ? (a.income - a.expenses) / a.income * 100 : null;
    const maxDay = Math.max(0, ...a.daily), maxIdx = a.daily.indexOf(maxDay);
    const diff = prev.expenses > 0 ? (a.expenses - prev.expenses) / prev.expenses * 100 : null;
    const rows2 = [
      ['Income', DC.money(a.income), 'pos'],
      ['Savings rate', rate === null ? '–' : pctStr(rate), rate !== null && rate < 0 ? 'neg' : ''],
      ['Projected month-end', DC.money(a.expenses / Math.max(1, dom) * dim)],
      ['Last month', DC.money(prev.expenses)]
    ];
    if (diff !== null) rows2.push(['vs last month', (diff > 0 ? '+' : '') + pctStr(diff), diff > 0 ? 'neg' : 'pos']);
    if (maxDay > 0) rows2.push(['Biggest day', DC.money(maxDay) + ' (' + (maxIdx + 1) + ' ' + MONTHS[now.getMonth()].slice(0, 3) + ')']);
    fillRows('c2Rows', rows2);

    // card 3: categories
    const cats = Object.entries(a.byCat).sort((x, y) => y[1] - x[1]);
    fillRows('c3Rows', cats.length
      ? [['Total spent', DC.money(a.expenses)], ['Categories used', String(cats.length)], ['Biggest', cats[0][0] + ' · ' + Math.round(cats[0][1] / a.expenses * 100) + '%']]
      : [['Total spent', DC.money(0)]]);

    // card 4: today
    const spentToday = today.filter(counts);
    const biggest = spentToday.reduce((m, t) => t.amount > m.amount ? t : m, { amount: 0 });
    const avg = a.expenses / Math.max(1, dom), sumToday = spentToday.reduce((s, t) => s + t.amount, 0);
    const rows4 = [['Daily average', DC.money(avg)]];
    if (sumToday > 0 && avg > 0) rows4.push(['Today vs average', (sumToday >= avg ? '+ ' : '− ') + DC.money(Math.abs(sumToday - avg)), sumToday > avg ? 'neg' : 'pos']);
    if (biggest.amount > 0) rows4.push(['Biggest today', (biggest.detail || biggest.category) + ' · ' + DC.money(biggest.amount)]);
    fillRows('c4Rows', rows4);
    fillList('c4List', today, 'No entries today yet.');
  }

  DC.balances = balances;   // Calc.js uses this for the "balance now" line

  function renderBalance() {
    const S = DC.getSettings(), now = new Date();
    const dom = now.getDate(), dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const b = balances(), a = DC.agg(now.getFullYear(), now.getMonth());

    // card 1: balance
    put('balTotal', DC.money(b.cash + b.bank));
    put('balCash', DC.money(b.cash), b.cash < 0 ? 'neg' : '');
    put('balBank', DC.money(b.bank), b.bank < 0 ? 'neg' : '');
    put('balIncome', DC.money(a.income));

    // card 2: this month
    put('monthLabel', 'Spent in ' + MONTHS[now.getMonth()]);
    put('balSpent', DC.money(a.expenses));
    put('balNet', (a.net > 0 ? '+ ' : '') + DC.money(a.net), a.net < 0 ? 'neg' : '');
    put('balAvg', DC.money(a.expenses / Math.max(1, dom)));
    const box = $('balBudget');
    if (S.budget > 0) {
      const pct = a.expenses / S.budget * 100;
      box.hidden = false; $('balNoBudget').hidden = true;
      $('balFill').style.width = Math.min(100, pct) + '%';
      $('balFill').className = 'bal-fill' + (pct > 100 ? ' over' : pct > 80 ? ' warn' : '');
      $('balBudgetText').textContent = pct > 100
        ? DC.money(a.expenses - S.budget) + ' over your budget'
        : DC.money(S.budget - a.expenses) + ' left of ' + DC.money(S.budget);
    } else { box.hidden = true; $('balNoBudget').hidden = false; }

    // card 3: top categories this month
    const list = $('catList'), cats = Object.entries(a.byCat).sort((x, y) => y[1] - x[1]);
    list.textContent = '';
    if (!cats.length) {
      const p = document.createElement('p'); p.className = 'cat-empty'; p.textContent = 'No expenses recorded this month yet.'; list.appendChild(p);
    } else {
      const pal = S.chartColors || [];
      cats.forEach(([name, amt], i) => {
        const row = document.createElement('div'); row.className = 'cat-row';
        const n = document.createElement('span'); n.className = 'cat-name'; n.textContent = name;
        const m = document.createElement('span'); m.className = 'cat-amt'; m.textContent = DC.money(amt);
        const pc = document.createElement('span'); pc.className = 'cat-pct'; pc.textContent = Math.round(amt / (a.expenses || 1) * 100) + '%'; m.appendChild(pc);
        const bar = document.createElement('div'); bar.className = 'cat-bar';
        const fill = document.createElement('i'); fill.style.width = (amt / cats[0][1] * 100) + '%'; fill.style.background = pal[i % (pal.length || 1)] || 'var(--accent-green)';
        bar.appendChild(fill); row.append(n, m, bar); list.appendChild(row);
      });
    }

    // card 4: today and pace
    const counts = t => t.category !== 'Income' && t.category !== 'Transfer' &&
      (S.countSavings || (t.category !== 'Savings' && t.category !== 'Investment'));
    const today = DC.Store.onDay(now);
    put('tdSpent', DC.money(today.filter(counts).reduce((s, t) => s + t.amount, 0)));
    put('tdCount', String(today.length));
    put('tdPace', DC.money(a.expenses / Math.max(1, dom) * dim));
    const row = $('tdLeftRow');
    if (S.budget > 0) {
      row.hidden = false;
      put('tdLeft', DC.money(Math.max(0, S.budget - a.expenses) / (dim - dom + 1)));
    } else row.hidden = true;


    renderDetails(S, now, dom, dim, b, a, counts, today);

    // header / rail text
    const bn = $('brandName'), rn = $('railName');
    if (bn && rn) rn.textContent = bn.textContent;
    const tl = $('todayLabel');
    if (tl) tl.textContent = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  }

  /* ───────── card row: dots follow the swipe, tap a card to expand it ───────── */
  const track = $('cardsTrack'), dots = $('cardsDots'), cardsBox = $('cards');
  let openCard = null, pushed = false;

  // the open card is also a history entry, so the phone's Back button closes the card and nothing else
  function showClosed() {
    if (!openCard) return;
    openCard.classList.remove('open'); openCard.setAttribute('aria-expanded', 'false');
    openCard = null; cardsBox.classList.remove('has-open');
  }
  function closeCard() {
    if (!openCard) return;
    showClosed();
    if (pushed) { pushed = false; history.back(); }
  }
  function expand(card) {
    if (openCard === card) return;
    showClosed();
    openCard = card; card.classList.add('open'); card.setAttribute('aria-expanded', 'true');
    cardsBox.classList.add('has-open');
    if (!pushed) { try { history.pushState({ dcCard: true }, ''); pushed = true; } catch (e) { /* ignore */ } }
    setTimeout(() => card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 320);
  }
  window.addEventListener('popstate', () => { if (openCard) { pushed = false; showClosed(); } });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && openCard) closeCard(); });

  if (track && dots) {
    const cardEls = Array.from(track.children);
    cardEls.forEach(card => {
      card.addEventListener('click', e => {
        if (String(window.getSelection && window.getSelection()) !== '') return;     // let people select text
        if (card === openCard) { if (!e.target.closest('.more-body')) closeCard(); } else expand(card);
      });
      card.addEventListener('keydown', e => {
        if (e.target !== card || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault(); card === openCard ? closeCard() : expand(card);
      });
    });
    cardEls.forEach((_, i) => {
      const d = document.createElement('button');
      d.type = 'button'; d.setAttribute('aria-label', 'Show card ' + (i + 1));
      d.addEventListener('click', () => { closeCard(); track.scrollTo({ left: cardEls[i].offsetLeft - cardEls[0].offsetLeft, behavior: 'smooth' }); });
      dots.appendChild(d);
    });
    let raf = 0;
    const syncDots = () => {
      raf = 0;
      const step = cardEls.length > 1 ? cardEls[1].offsetLeft - cardEls[0].offsetLeft : 1;
      let i = Math.round(track.scrollLeft / Math.max(1, step));
      if (track.scrollLeft + track.clientWidth >= track.scrollWidth - 4) i = cardEls.length - 1;
      Array.from(dots.children).forEach((d, k) => d.classList.toggle('on', k === i));
    };
    track.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(syncDots); }, { passive: true });
    window.addEventListener('resize', syncDots);
    syncDots();
  }

  /* ───────── day strip: keep the open day in view ───────── */
  function keepSelectedVisible() {
    const list = document.querySelector('.day-strip .history-list');
    const sel = list && list.querySelector('.history-item.selected');
    if (!sel) return;
    const left = sel.offsetLeft, right = left + sel.offsetWidth;
    if (left < list.scrollLeft || right > list.scrollLeft + list.clientWidth) {
      list.scrollTo({ left: Math.max(0, left - 16), behavior: 'smooth' });
    }
  }

  document.addEventListener('dc:change', () => { renderBalance(); keepSelectedVisible(); });
  renderBalance();
  keepSelectedVisible();

  /* ───────── which tab is showing (the entry bar only belongs on Home) ───────── */
  const panels = document.querySelectorAll('.view-panel');
  const syncTab = () => {
    const a = document.querySelector('.view-panel.active');
    document.body.dataset.tab = a ? a.id.replace('-view', '') : 'home';
    if (document.body.dataset.tab !== 'home') closeCard();
  };
  const mo = new MutationObserver(syncTab);
  panels.forEach(p => mo.observe(p, { attributes: true, attributeFilter: ['class'] }));
  syncTab();

  /* ───────── calendar button → native date picker (Extras.js opens the chosen day) ───────── */
  const dateBtn = $('dateBtn'), pick = $('dayPicker');
  if (dateBtn && pick) {
    dateBtn.addEventListener('click', () => {
      pick.max = new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
      try { pick.showPicker(); } catch (e) { pick.focus(); pick.click(); }
    });
  }

  /* ───────── quick-entry chips: pre-fill the sentence, caret ready for the amount ───────── */
  const input = $('chatInput');
  let lastFill = '';
  document.querySelectorAll('.dock .chip').forEach(chip => {
    chip.addEventListener('mousedown', e => e.preventDefault());   // keep the keyboard open
  });
  document.querySelectorAll('[data-fill]').forEach(chip => {
    chip.addEventListener('click', () => {
      const raw = chip.dataset.fill, at = raw.indexOf('|');
      const text = raw.replace('|', ''), cur = input.value;
      if (!cur.trim() || cur === lastFill) {
        input.value = lastFill = text;
        input.focus();
        input.setSelectionRange(at, at);
      } else {
        // already typing: a category chip just adds "on food" to what's there
        const suffix = raw.slice(at + 1);
        if (suffix && !/\bon\b/i.test(cur)) input.value = cur.replace(/\s+$/, '') + suffix;
        input.focus();
      }
    });
  });

  /* ───────── phone keyboard: hide the bottom nav while typing ───────── */
  input.addEventListener('focus', () => document.body.classList.add('kbd-open'));
  input.addEventListener('blur', () => setTimeout(() => {
    if (document.activeElement !== input) document.body.classList.remove('kbd-open');
  }, 150));
})();
