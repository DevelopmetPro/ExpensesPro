/* Calc.js: works out extra details from what the user types.
   Loaded by Auth.js after Script.js, Extras.js and Layout.js.

   1) preprocess(text)  runs BEFORE the sentence parser and does the arithmetic the parser can't:
        quantity x price   "3 coffees at 200 each", "2 x 450 for tickets", "2 kg rice at 320 per kg"
        tip / tax / fees   "4500 for dinner with 10% tip", "1500 electricity bill plus 5% tax", "plus delivery fee 150"
        discounts          "shirt for 3000 with 20% discount", "paid 2400 after 20% discount"
        splitting a bill   "6000 on dinner split between 3 people", "split with 2 friends", "split 4 ways"
        ATM withdrawals    "withdrew 2000 from ATM"  (bank -> cash transfer)
        stated totals      "lunch 350 and dinner 800, total 1150"  (checked against the real sum)
   2) afterAdd(rows, pre) runs AFTER the rows are saved and posts a short summary computed from the
      whole ledger: day total vs usual, category share of the month, budget left, cash/bank now,
      net and savings rate. */
(() => {
  'use strict';
  if (typeof DC === 'undefined') return;

  /* ───────── number helpers ───────── */
  const CUR = '(?:rs\\.?|lkr|usd|inr|eur|gbp|aed|\\$|€|£|₹)';
  const AMT = `(?:${CUR}\\s?)?\\d(?:[\\d,]*\\d)?(?:\\.\\d+)?(?:\\s?(?:k|m|lakhs?|lacs?|crores?)\\b)?(?![\\d.]*\\s?%)`;
  const WN = '\\d+|one|two|three|four|five|six|seven|eight|nine|ten';
  const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const MULT = { k: 1e3, m: 1e6, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, crore: 1e7, crores: 1e7 };
  const EXCL_AFTER = /^(?:\s?(?:am|pm)\b|:\d|\s?%|[-/]\d|(?:st|nd|rd|th)\b|\s?(?:people|persons?|friends?|ways?|of us|guys|kgs?|km|kms|gm|g|l|ml|days?|nights?|hours?|hrs?|minutes?|mins?|pcs?|pieces?|items?|x|×)\b)/i;

  const num = s => { const w = String(s).toLowerCase(); return WORDS[w] || parseFloat(w); };
  const round2 = v => Math.round(v * 100) / 100;
  const plain = v => String(round2(v));
  const money = v => DC.money(v);

  function parseAmt(s) {
    const m = String(s).toLowerCase().replace(new RegExp('^' + CUR + '\\s?', 'i'), '')
      .match(/^(\d(?:[\d,]*\d)?(?:\.\d+)?)\s?(k|m|lakhs?|lacs?|crores?)?/);
    if (!m) return NaN;
    return parseFloat(m[1].replace(/,/g, '')) * (MULT[m[2]] || 1);
  }
  const curOf = s => { const m = String(s).match(new RegExp('^' + CUR + '\\s?', 'i')); return m ? m[0] : 'Rs '; };

  /* every number in the text that could be a money amount (skips times, dates, "3 people", percents) */
  function moneyNums(s) {
    const out = [], re = new RegExp(AMT, 'ig');
    let m;
    while ((m = re.exec(s))) {
      const after = s.slice(m.index + m[0].length), before = s.slice(0, m.index);
      if (EXCL_AFTER.test(after)) continue;
      if (/\d[:/.-]$/.test(before)) continue;
      if (/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*$/i.test(before)) continue;
      out.push(m);
    }
    return out;
  }
  const tidy = s => s.replace(/\s{2,}/g, ' ').replace(/\s+([,.;])/g, '$1').replace(/[,\s]+$/, '').replace(/^[,\s]+/, '');

  /* ───────── 1. quantity x price ───────── */
  const UNITS = 'kgs?|kilos?|grams?|gms?|g|litres?|liters?|ltrs?|l|ml|lbs?|pcs?|pieces?|packs?|packets?|bottles?|dozen|plates?|cups?|glasses?|tickets?|nights?|days?|hours?|hrs?|kms?|km';
  const P_X = new RegExp(`\\b(\\d+(?:\\.\\d+)?)\\s*[x×*]\\s*(${AMT})`, 'i');
  const P_X_REV = new RegExp(`(${AMT})\\s*[x×*]\\s*(\\d+(?:\\.\\d+)?)\\b`, 'i');
  const P_EACH = new RegExp(`\\b(\\d+(?:\\.\\d+)?)\\s*(${UNITS})?\\s+([a-z][a-z' -]{0,30}?)?\\s*(?:at|@|for)\\s*(${AMT})\\s*(?:each|apiece|ea\\b|a\\s+piece|per\\s+\\w+|\\/\\s*\\w+)`, 'i');
  const P_EACH2 = new RegExp(`(${AMT})\\s*(?:each|apiece|per\\s+\\w+)\\s*(?:on|for|x)?\\s*(\\d+(?:\\.\\d+)?)\\s*(${UNITS})?\\s*([a-z][a-z' -]*)?`, 'i');
  const PEOPLE = /^(?:people|persons?|guys|friends|heads)$/i;

  function qty(s, notes) {
    let m;
    const done = (n, price, label, replacement, m0) => {
      const total = round2(n * price);
      notes.push({ text: `${label ? label + ': ' : ''}${plain(n)} × ${money(price)} = ${money(total)}`, final: total });
      return s.replace(m0, replacement(total));
    };
    if ((m = s.match(P_X))) {
      return done(num(m[1]), parseAmt(m[2]), '', t => curOf(m[2]) + plain(t), m[0]);
    }
    if ((m = s.match(P_X_REV)) && num(m[2]) <= 1000) {
      return done(num(m[2]), parseAmt(m[1]), '', t => curOf(m[1]) + plain(t), m[0]);
    }
    if ((m = s.match(P_EACH))) {
      const item = tidy(m[3] || ''), unit = (m[2] || '').replace(/s$/i, '');
      const label = PEOPLE.test(item) ? '' : (item || unit);
      return done(num(m[1]), parseAmt(m[4]), label, t => (label ? label + ' for ' : '') + curOf(m[4]) + plain(t), m[0]);
    }
    if ((m = s.match(P_EACH2)) && (m[4] || m[3])) {
      const item = tidy(m[4] || m[3] || '');
      return done(num(m[2]), parseAmt(m[1]), item, t => (item ? item + ' for ' : '') + curOf(m[1]) + plain(t), m[0]);
    }
    return s;
  }

  /* ───────── 2. tip / tax / fees / discounts ───────── */
  const ADJ = 'tip|gratuity|tax|vat|gst|service(?:\\s+charge)?|delivery(?:\\s+(?:fee|charge))?|discount|cashback|coupon|off';
  const CONN = '(?:\\b(with|plus|incl\\w*\\.?|and|after|before|less|minus|without|excl\\w*\\.?)\\s+)?';
  const R_PCT_A = new RegExp(`${CONN}(?:an?\\s+)?(\\d+(?:\\.\\d+)?)\\s*%\\s*(${ADJ})\\b`, 'ig');
  const R_PCT_B = new RegExp(`${CONN}(?:an?\\s+)?(${ADJ})\\s*(?:of|at|is|=|:)?\\s*(\\d+(?:\\.\\d+)?)\\s*%`, 'ig');
  const R_FLAT = new RegExp(`\\b(with|plus|incl\\w*\\.?|after|less|minus|and)\\s+(?:an?\\s+)?(${ADJ})\\s*(?:of|:)?\\s*(${AMT})(?!\\s?%)`, 'ig');
  const NEG = /^(?:discount|cashback|coupon|off)$/i;
  const isIncomeText = s => typeof INCOME_RE !== 'undefined' && INCOME_RE.test(s);

  function adjust(s, notes) {
    const adj = [];
    let t = s;
    const grab = (conn, word, pct, amt) => adj.push({ conn: (conn || '').toLowerCase(), word: word.toLowerCase().replace(/\s+/g, ' '), pct, amt });
    t = t.replace(R_PCT_A, (m, c, p, w) => { grab(c, w, parseFloat(p), null); return ' '; });
    t = t.replace(R_PCT_B, (m, c, w, p) => { grab(c, w, parseFloat(p), null); return ' '; });
    t = t.replace(R_FLAT, (m, c, w, a) => { grab(c, w, null, parseAmt(a)); return ' '; });
    if (!adj.length) return s;

    const nums = moneyNums(t);
    if (nums.length !== 1) {
      if (nums.length > 1) notes.push({ text: `I wasn't sure which amount the ${adj[0].word} applies to, so I left it out. Add it as its own entry or give the final price.` });
      return s;
    }
    const m = nums[0], base = parseAmt(m[0]);
    let final = base;
    const parts = [money(base)];
    let changed = false;
    adj.forEach(a => {
      const neg = NEG.test(a.word) || /^(?:less|minus|without)$/.test(a.conn);
      const delta = a.pct != null ? base * a.pct / 100 : a.amt;
      const label = a.pct != null ? `${a.pct}% ${a.word}` : a.word;
      if (/^incl/.test(a.conn) || (a.conn === 'after')) {
        // already included in the price the user typed: just explain it
        if (neg && a.conn === 'after' && a.pct != null && a.pct < 100) {
          const orig = base / (1 - a.pct / 100);
          notes.push({ text: `After ${label}: original price about ${money(orig)}, you saved about ${money(orig - base)}.` });
        }
        return;
      }
      changed = true;
      final += neg ? -delta : delta;
      parts.push(`${neg ? '−' : '+'} ${label} (${money(delta)})`);
    });
    if (!changed || !(final > 0)) return s;
    final = round2(final);
    notes.push({ text: `${parts.join(' ')} = ${money(final)}`, final });
    return tidy(t.slice(0, m.index) + curOf(m[0]) + plain(final) + t.slice(m.index + m[0].length));
  }

  /* ───────── 3. splitting a bill ───────── */
  const R_SPLIT = [
    [new RegExp(`\\b(?:split|splitting|divided|shared|sharing)\\s+(?:it\\s+|this\\s+|the\\s+(?:bill|cost|total)\\s+)?(?:equally\\s+|evenly\\s+)?(?:between|among|amongst|by|into)\\s+(${WN})\\b(?:\\s+(?:ways|people|persons|friends|of us|guys))?`, 'i'), 0],
    [new RegExp(`\\b(?:split|splitting|shared|sharing)\\s+(?:it\\s+|this\\s+)?(?:equally\\s+|evenly\\s+)?with\\s+(${WN})\\s*(?:other\\s+)?(?:friends|people|persons|others|colleagues|roommates|guys)?`, 'i'), 1],
    [new RegExp(`\\b(?:split|splitting)\\s+(?:it\\s+)?(${WN})\\s+ways?\\b`, 'i'), 0],
    [new RegExp(`\\b(${WN})\\s+(?:of\\s+us|people|persons|friends|guys)\\s+(?:split|shared)\\b(?:\\s+(?:it|the\\s+bill))?`, 'i'), 0]
  ];

  function split(s, notes) {
    for (const [re, extra] of R_SPLIT) {
      const m = s.match(re);
      if (!m) continue;
      const n = num(m[1]) + extra;
      if (!(n >= 2 && n <= 50)) return s;
      const t = tidy(s.replace(m[0], ' '));
      const nums = moneyNums(t);
      if (nums.length !== 1) return s;
      const base = parseAmt(nums[0][0]), share = round2(base / n);
      notes.push({ text: `${money(base)} split ${n} ways: your share is ${money(share)}.`, final: share });
      return tidy(t.slice(0, nums[0].index) + curOf(nums[0][0]) + plain(share) + t.slice(nums[0].index + nums[0][0].length));
    }
    return s;
  }

  /* ───────── preprocess ───────── */
  // sentences: split on . ; ! ? and new lines ("Rs. 500" and "12.50" are not sentence ends)
  const SENT = /((?<!\brs)(?<!\bno)\.(?=\s|$)|[;\n!?]+)/gi;
  // clauses inside a sentence: only before a new "spent / paid / bought..." so ", split 3 ways" stays with its amount
  const SEG = /(,\s+(?:and\s+)?(?=(?:i\s+)?(?:spent|paid|bought|ordered|got|had|received|earned)\b)|\s+and\s+(?=(?:i\s+)?(?:spent|paid|bought|ordered|got|had|received|earned)\b))/gi;
  const R_TOTAL = new RegExp(`(?:,\\s*|\\s+)(?:total(?:\\s+(?:of|was|is|came\\s+to|=))?|in\\s+total|altogether|all\\s+together)\\s*:?\\s*(${AMT})\\s*$`, 'i');
  const R_WITHDRAW = new RegExp(`\\b(?:withdrew|withdrawn|withdraw|took\\s+out|drew)\\s+(${AMT})(?:\\s+cash)?\\s+(?:from|at)\\s+(?:the\\s+|my\\s+)?(?:atm|bank|account)\\b`, 'ig');

  function preprocess(text) {
    const notes = [];
    let statedTotal = null, totals = 0;
    try {
      let t = String(text).replace(R_WITHDRAW, (m, a) => {
        notes.push({ text: `Cash withdrawal: ${money(parseAmt(a))} moved from bank to cash.` });
        return `transferred ${a} from bank to cash`;
      });
      const sents = t.split(SENT);
      for (let si = 0; si < sents.length; si += 2) {
        let sentence = sents[si];
        if (!sentence || !sentence.trim()) continue;

        // "... total 1150": drop it from the sentence, compare it with the real sum afterwards
        const tm = sentence.match(R_TOTAL);
        if (tm) {
          const rest = sentence.slice(0, tm.index);
          if (moneyNums(rest).length >= 2) { statedTotal = parseAmt(tm[1]); totals++; sentence = rest; }
        }

        const parts = sentence.split(SEG);
        for (let i = 0; i < parts.length; i += 2) {
          let seg = parts[i];
          if (!seg || !seg.trim()) continue;
          seg = qty(seg, notes);
          if (!isIncomeText(seg)) seg = adjust(seg, notes);
          seg = split(seg, notes);
          parts[i] = seg;
        }
        sents[si] = parts.join('');
      }
      t = sents.join('');
      return { text: t, notes, statedTotal: totals === 1 ? statedTotal : null };
    } catch (err) {
      console.warn('Calc.preprocess failed:', err);
      return { text, notes: [], statedTotal: null };
    }
  }

  /* ───────── afterAdd: summary computed from the whole ledger ───────── */
  const parseDMY = s => { const m = String(s).match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/); return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null; };
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  function afterAdd(rows, pre) {
    try {
      const S = DC.getSettings(), now = new Date(), notes = (pre && pre.notes) || [];
      const isInc = r => r[3] === 'Income', isTr = r => r[3] === 'Transfer';
      const isExp = r => !isInc(r) && !isTr(r) && (S.countSavings || !['Savings', 'Investment'].includes(r[3]));
      const amt = r => parseFloat(r[1]) || 0;
      const exp = rows.filter(isExp), inc = rows.filter(isInc);
      const saved = rows.filter(r => !isInc(r) && !isTr(r) && !isExp(r));
      const lines = [];

      // remember the maths on the saved entries (shown under "Latest entries")
      const used = new Set();
      notes.filter(n => n.final != null).forEach(n => {
        const r = rows.find(x => !used.has(x) && amt(x) === n.final);
        if (!r) return;
        used.add(r);
        const tx = DC.Store.all().find(x => x.id === r.txId);
        if (tx) tx.note = n.text;
      });
      DC.Store.save();

      notes.forEach(n => lines.push('• ' + n.text));

      const sum = a => a.reduce((s, r) => s + amt(r), 0);
      if (rows.length > 1) {
        const bits = [];
        if (exp.length) bits.push(`spent ${money(sum(exp))}`);
        if (saved.length) bits.push(`saved/invested ${money(sum(saved))}`);
        if (inc.length) bits.push(`received ${money(sum(inc))}`);
        if (bits.length) lines.push('• This message: ' + bits.join(', ') + '.');
      }
      if (pre && pre.statedTotal != null && exp.length) {
        const real = round2(sum(exp)), said = round2(pre.statedTotal);
        lines.push(Math.abs(real - said) < 0.01
          ? `• Your total of ${money(said)} matches the entries.`
          : `• You said the total is ${money(said)}, but the entries add up to ${money(real)} (difference ${money(Math.abs(said - real))}).`);
      }

      // day total vs usual (for the day the first expense was filed on)
      if (exp.length) {
        const day = parseDMY(exp[0][0]);
        if (day) {
          const tx = DC.Store.onDay(day).filter(t => t.category !== 'Income' && t.category !== 'Transfer' && (S.countSavings || !['Savings', 'Investment'].includes(t.category)));
          const dayTotal = tx.reduce((s, t) => s + t.amount, 0);
          const a = DC.agg(day.getFullYear(), day.getMonth());
          const elapsed = (day.getFullYear() === now.getFullYear() && day.getMonth() === now.getMonth()) ? now.getDate() : new Date(day.getFullYear(), day.getMonth() + 1, 0).getDate();
          const others = elapsed - 1, otherSpend = a.expenses - dayTotal;
          const label = sameDay(day, now) ? 'Today' : 'That day';
          let line = `• ${label}: ${money(dayTotal)} spent`;
          if (others >= 1 && otherSpend > 0) {
            const usual = otherSpend / others, diff = (dayTotal - usual) / usual * 100;
            line += Math.abs(diff) >= 10 ? ` (${Math.abs(Math.round(diff))}% ${diff > 0 ? 'above' : 'below'} your usual ${money(usual)} a day)` : ` (about your usual ${money(usual)} a day)`;
          }
          lines.push(line + '.');

          // category share of the month
          const byCat = {};
          exp.forEach(r => { byCat[r[3]] = (byCat[r[3]] || 0) + amt(r); });
          Object.entries(byCat).sort((x, y) => y[1] - x[1]).slice(0, 2).forEach(([c]) => {
            const mo = parseDMY(exp.find(r => r[3] === c)[0]) || day, am = DC.agg(mo.getFullYear(), mo.getMonth());
            if (am.byCat[c] && am.expenses > 0 && am.byCat[c] < am.expenses - 0.005) lines.push(`• ${c} so far in ${mo.toLocaleString('en-US', { month: 'long' })}: ${money(am.byCat[c])} (${Math.round(am.byCat[c] / am.expenses * 100)}% of spending).`);
          });

          // budget (current month only)
          if (S.budget > 0 && day.getFullYear() === now.getFullYear() && day.getMonth() === now.getMonth()) {
            const left = S.budget - a.expenses, pct = Math.round(a.expenses / S.budget * 100);
            const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(), daysLeft = dim - now.getDate() + 1;
            lines.push(left < 0
              ? `• ⚠ Over budget: ${money(-left)} above your ${money(S.budget)} budget (${pct}% used).`
              : `• Budget: ${pct}% used, ${money(left)} left, about ${money(left / daysLeft)} a day for the ${daysLeft} days left${pct >= 80 ? ' — getting close' : ''}.`);
          }
        }
      }

      // month result after income
      if (inc.length) {
        const mo = parseDMY(inc[0][0]) || now, a = DC.agg(mo.getFullYear(), mo.getMonth());
        const rate = a.income > 0 ? Math.round((a.income - a.expenses) / a.income * 100) : null;
        lines.push(`• This month: income ${money(a.income)}, spent ${money(a.expenses)}, net ${money(a.net)}${rate !== null ? `, savings rate ${rate}%` : ''}.`);
      }

      // cash / bank now
      if (typeof DC.balances === 'function') {
        const b = DC.balances();
        lines.push(`• Balance now: cash ${money(b.cash)}, bank ${money(b.bank)} (total ${money(b.cash + b.bank)}).`);
        if (b.cash < 0 && rows.some(r => r[4] === 'Cash')) lines.push('• ⚠ Cash in hand is negative. If you took money from the bank, say e.g. “withdrew 2000 from ATM”.');
      }

      if (lines.length) addBotText(lines.slice(0, 9).join('\n'));
    } catch (err) {
      console.warn('Calc.afterAdd failed:', err);
    }
  }

  window.DC_Calc = { preprocess, afterAdd };
})();
