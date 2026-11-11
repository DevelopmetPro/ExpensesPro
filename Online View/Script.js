// Global 2D array storing extracted customer requests
let customerRequested = [];

/**
 * Fallback called when no amount is stated in the text.
 */
async function getAmountFromCx(sentence, detail) {
  console.log(`Missing amount detected. Querying experience lookup for "${detail}" in: "${sentence}"`);
  return "0";
}

/* ───────────────────────── Payment method labels ───────────────────────── */

// "Bank" and "Card" are the same thing → one label. Change this one constant to rename it everywhere.
const NON_CASH_METHOD = "Card";
// Categories that are never paid in cash unless the text explicitly says "cash"
const NON_CASH_CATEGORIES = new Set(["Investment"]);
const defaultMethod = category => NON_CASH_CATEGORIES.has(category) ? NON_CASH_METHOD : "Cash";

/* ───────────────────────── Number words ("hundred thousand and one" → 100001) ───────────────────────── */

const UNIT_VALUES = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19
};
const TENS_VALUES = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90
};
const SCALE_VALUES = {
  thousand: 1e3, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, million: 1e6, crore: 1e7, crores: 1e7, billion: 1e9
};

const PLAIN_NUM_WORDS = [...Object.keys(UNIT_VALUES), ...Object.keys(TENS_VALUES)].sort((a, b) => b.length - a.length).join('|');
const SCALE_SRC = 'hundred|thousand|lakhs?|lacs?|million|crores?|billion';
const NUM_WORD_SRC = `${PLAIN_NUM_WORDS}|${SCALE_SRC}`;

// A run of number words. "and" is only allowed right after hundred / a scale word.
const NUMWORD_RE = new RegExp(
  `\\b(?:an?\\s+(?=(?:${SCALE_SRC})\\b))?(?:${NUM_WORD_SRC})\\b` +
  `(?:[\\s-]+(?:(?<=\\b(?:${SCALE_SRC})[\\s-]+)and[\\s-]+)?(?:${NUM_WORD_SRC})\\b)*`,
  'gi'
);

function wordsToNumber(phrase) {
  const toks = phrase.toLowerCase().split(/[\s-]+/).filter(Boolean);
  let total = 0, current = 0, last = null;

  for (const t of toks) {
    if (t === 'a' || t === 'an') continue;

    if (t === 'and') {
      if (last !== 'scale' && last !== 'hundred') return null;
      last = 'and';
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(UNIT_VALUES, t)) {
      const v = UNIT_VALUES[t];
      if (v < 10) {
        if (last === 'unit' || last === 'teen') return null;
        last = 'unit';
      } else {
        if (last === 'unit' || last === 'teen' || last === 'tens') return null;
        last = 'teen';
      }
      current += v;
    } else if (Object.prototype.hasOwnProperty.call(TENS_VALUES, t)) {
      if (last === 'unit' || last === 'teen' || last === 'tens') return null;
      current += TENS_VALUES[t];
      last = 'tens';
    } else if (t === 'hundred') {
      if (current >= 100 || last === 'tens') return null;
      current = (current || 1) * 100;
      last = 'hundred';
    } else if (Object.prototype.hasOwnProperty.call(SCALE_VALUES, t)) {
      total += (current || 1) * SCALE_VALUES[t];
      current = 0;
      last = 'scale';
    } else {
      return null;
    }
  }
  if (last === 'and') return null;
  return total + current;
}

// Replaces every number-word run with digits. A lone "one" is only converted when a currency
// follows ("one dollar"), so "one of them" / "no one" stay untouched.
function replaceNumberWords(text) {
  return text.replace(NUMWORD_RE, (m, offset, str) => {
    const val = wordsToNumber(m);
    if (val === null) return m;
    if (/^(?:hundred|thousand|lakhs?|lacs?|million|crores?|billion)\b/i.test(m) && /\d\s*$/.test(str.slice(0, offset))) return m;
    if (/^one$/i.test(m.trim())) {
      const nxt = str.slice(offset + m.length).match(/^\s*(\p{Sc}|\p{L}+)/u);
      if (!(nxt && isTrailingCurrency(nxt[1]))) return m;
    }
    return String(val);
  });
}

/* ───────────────────────── Dates ───────────────────────── */

const pad2 = n => String(n).padStart(2, '0');
const fmtDate = d => `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()}`;
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

/* The day whose chat is currently open. null = today.
   New entries that don't name a date are filed under this day. */
let activeDay = null;
function setActiveDay(d) { activeDay = d ? new Date(d.getFullYear(), d.getMonth(), d.getDate()) : null; }
function defaultDateStr() { return activeDay ? fmtDate(activeDay) : getFormattedDate('today'); }
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const MONTH_INDEX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

const FUTURE_DATE_CUE = /\b(?:book(?:ed|ing|ings)?|reserv(?:e|ed|es|ation|ations)|upcoming|scheduled|pre-?paid|advance|deposit|flights?)\b/i;
const FUTURE_WORDS = /\b(?:tomorrow|day after tomorrow|next (?:week|month|year|(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday))|in \d+ (?:days?|weeks?|months?))\b/i;

const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const WEEKDAY_SRC = WEEKDAYS.join('|');
const DATE_SRC = [
  `\\b\\d{4}[/.-]\\d{1,2}[/.-]\\d{1,2}\\b`,
  `\\b\\d{1,2}[/.-]\\d{1,2}[/.-](?:\\d{4}|\\d{2})\\b`,
  `\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?:,?\\s+(?:19|20)\\d{2}\\b)?`,
  `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTHS})\\b\\.?(?:,?\\s+(?:19|20)\\d{2}\\b)?`,
  `\\bday before yesterday\\b`,
  `\\b(?:yesterday|today|tonight|last night|this (?:morning|afternoon|evening)|last (?:week|month))\\b`,
  `\\b(?:\\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten)\\s+(?:day|week|month)s?\\s+ago\\b`,
  `\\b(?:last|on)\\s+(?:${WEEKDAY_SRC})\\b`
].join('|');
const DATE_RE = new RegExp(DATE_SRC, 'i');
const stripDates = str => str.replace(new RegExp(DATE_SRC, 'gi'), ' ');

function buildValidDate(y, m, d) {
  const dt = new Date(y, m, d);
  return dt.getFullYear() === y && dt.getMonth() === m && dt.getDate() === d ? dt : null;
}

function subtractMonths(date, n) {
  const d = new Date(date.getFullYear(), date.getMonth() - n, 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(date.getDate(), last));
  return d;
}

function fromMonthName(name, day, year, keepThisYear) {
  const mi = MONTH_INDEX[name.slice(0, 3)];
  if (mi === undefined) return null;
  const today = startOfToday();
  const d = parseInt(day, 10);
  if (year) return buildValidDate(parseInt(year, 10), mi, d);

  const thisYear = buildValidDate(today.getFullYear(), mi, d);
  if (thisYear && thisYear > today && !keepThisYear) {
    return buildValidDate(today.getFullYear() - 1, mi, d) || thisYear;
  }
  return thisYear;
}

function parseDate(input, keepThisYear = false) {
  const today = startOfToday();
  const s = String(input || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s || s === 'not specified') return today;

  const daysAgo = n => { const d = new Date(today); d.setDate(d.getDate() - n); return d; };

  if (s === 'day before yesterday') return daysAgo(2);
  if (s === 'yesterday' || s === 'last night') return daysAgo(1);
  if (/^(today|tonight|this (morning|afternoon|evening))$/.test(s)) return today;
  if (s === 'last week') return daysAgo(7);
  if (s === 'last month') return subtractMonths(today, 1);

  let m = s.match(/^(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten) (day|week|month)s? ago$/);
  if (m) {
    const n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : NUM_WORDS[m[1]];
    if (m[2] === 'day') return daysAgo(n);
    if (m[2] === 'week') return daysAgo(n * 7);
    return subtractMonths(today, n);
  }

  m = s.match(new RegExp(`^(last|on) (${WEEKDAY_SRC})$`));
  if (m) {
    let diff = (today.getDay() - WEEKDAYS.indexOf(m[2]) + 7) % 7;
    if (diff === 0 && m[1] === 'last') diff = 7;
    return daysAgo(diff);
  }

  m = s.match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})$/);
  if (m) return buildValidDate(+m[1], +m[2] - 1, +m[3]) || today;

  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4}|\d{2})$/);
  if (m) {
    let day = +m[1], month = +m[2], year = +m[3];
    if (m[3].length === 2) year += 2000;
    if (month > 12 && day <= 12) [day, month] = [month, day];
    return buildValidDate(year, month - 1, day) || today;
  }

  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?(?: of)? ([a-z]+)\.?(?:,? (\d{4}))?$/);
  if (m) return fromMonthName(m[2], m[1], m[3], keepThisYear) || today;

  m = s.match(/^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/);
  if (m) return fromMonthName(m[1], m[2], m[3], keepThisYear) || today;

  return today;
}

function getFormattedDate(dateString, keepThisYear = false) {
  return fmtDate(parseDate(dateString, keepThisYear));
}

function isFutureDate(dateStr, cued) {
  return parseDate(dateStr, cued) > startOfToday();
}

/* ───────────────────────── Currency detection ───────────────────────── */

const FALLBACK_ISO = ('USD EUR GBP JPY CNY INR LKR AUD CAD NZD CHF SGD HKD AED SAR QAR KWD OMR BHD MYR THB IDR PHP VND KRW TWD ' +
  'PKR BDT NPR MVR ZAR EGP KES NGN GHS TZS UGX MAD BRL MXN ARS CLP COP PEN RUB UAH TRY ILS SEK NOK DKK PLN CZK HUF RON BGN ISK').split(' ');
const ISO_CODES = new Set(FALLBACK_ISO);
try {
  if (typeof Intl !== 'undefined' && typeof Intl.supportedValuesOf === 'function') {
    Intl.supportedValuesOf('currency').forEach(c => ISO_CODES.add(c));
  }
} catch (e) { /* older browsers */ }

const COMMON_LOWER_CODES = new Set(('usd eur gbp jpy cny inr lkr aud cad nzd chf sgd hkd aed sar qar kwd omr bhd myr thb idr php ' +
  'vnd krw twd pkr bdt npr mvr zar egp kes ngn sek nok dkk pln czk huf').split(' '));
const CURRENCY_ABBR = new Set(['rs', 'nrs', 'rm', 'tk', 'kr', 'zl', 'kc', 'ksh', 're']);
const CURRENCY_WORDS = new Set([
  'dollar', 'dollars', 'buck', 'bucks', 'euro', 'euros', 'pound', 'pounds', 'quid', 'yen', 'yuan', 'rmb',
  'rupee', 'rupees', 'baht', 'peso', 'pesos', 'dirham', 'dirhams', 'riyal', 'riyals', 'ringgit', 'rand',
  'franc', 'francs', 'krona', 'kronor', 'krone', 'kroner', 'shekel', 'shekels', 'lira', 'ruble', 'rubles',
  'rouble', 'roubles', 'taka', 'rupiah', 'dong', 'kyat', 'dinar', 'dinars', 'forint', 'zloty'
]);

function isLeadingCurrency(tok) {
  if (!tok) return false;
  const low = tok.toLowerCase().replace(/\.+$/, '');
  if (CURRENCY_ABBR.has(low)) return true;
  const cleanUpper = tok.replace(/\.+$/, '').toUpperCase();
  if (ISO_CODES.has(cleanUpper)) return true;
  return COMMON_LOWER_CODES.has(low);
}
function isTrailingCurrency(tok) {
  if (!tok) return false;
  if (/^\p{Sc}$/u.test(tok)) return true;
  return isLeadingCurrency(tok) || CURRENCY_WORDS.has(tok.toLowerCase().replace(/\.+$/, ''));
}

/* ───────────────────────── Preprocessing helper ───────────────────────── */

function normalizeTextInput(rawText) {
  return replaceNumberWords(String(rawText || '')
    .replace(/[\u2018\u2019]/g, "'"))
    .replace(/\ban\s+then\b/gi, 'and then')
    // Remove periods attached to currency abbreviations (e.g. Rs. 50,000 -> Rs 50,000)
    .replace(/(?<!\d\s)\b([A-Za-z]{1,5})\.\s*(?=\d)/g, (full, tok) => isLeadingCurrency(tok) ? tok + ' ' : full)
    .replace(/(\d)[ \t]+\.(\d{1,2})(?!\d)/g, '$1.$2')
    .replace(/(\d)[ \t]+a(?=[ \t]*(?:[.,;!?]|$))/gim, '$1')
    .trim();
}

/* ───────────────────────── Amounts ───────────────────────── */

const NUM_SRC = String.raw`(?<![\d.])(?<!\d:)(?<!#)(?<!\d,)(\d{1,3}(?:,\d{2})*(?:,\d{3})+|\d+)(?!\d)(\.\d+)?((?:\s?(?:hundred|thousand|lakhs?|lacs?|million|crores?|billion)s?|k|mn|bn|m|b)(?![\p{L}\d]))?`;
const SUFFIX_MULT = {
  hundred: 1e2, thousand: 1e3, k: 1e3, lakh: 1e5, lac: 1e5,
  million: 1e6, m: 1e6, mn: 1e6, crore: 1e7, billion: 1e9, bn: 1e9, b: 1e9
};
const suffixMultiplier = s => SUFFIX_MULT[s.trim().toLowerCase().replace(/s$/, '')] || 1;

const KW_BEFORE = /\b(?:spent|spend|spending|paid|pay|paying|cost|costs|costing|for|price|priced|worth|total|charged|fare|fee|fees|only|just|about|around|bill|invested|invest|investing|deposited|deposit|saved|save|withdrew|withdrawn|received|earned|won|put|transferred)\s+$/;
const FOLLOW_OK = /^\s*(?:$|[.,!?;)]|\d+(?:st|nd|rd|th)\b|(?:on|for|at|with|using|by|in|into|onto|from|to|via|as|and|but|so|because|since|cash|card|only|total|just|after|before|when|while|then|yesterday|today)\b)/;
const NOT_MONEY_AFTER = /^\s?(?::\d|am\b|pm\b|%)/;

function isOrdinalOf(intStr, suffix) {
  const n = parseInt(intStr.replace(/,/g, ''), 10);
  const last2 = n % 100;
  const expected = (last2 >= 11 && last2 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return suffix.toLowerCase() === expected;
}

function findAmount(str) {
  const re = new RegExp(NUM_SRC, 'giu');
  let best = null;

  for (const m of str.matchAll(re)) {
    const [full, intPart, decPart, suffix] = m;
    let before = str.slice(0, m.index);
    let after = str.slice(m.index + full.length);
    if (NOT_MONEY_AFTER.test(after.toLowerCase())) continue;

    const ord = after.match(/^(st|nd|rd|th)(?![\p{L}\d])/iu);
    if (ord && !decPart && !suffix && isOrdinalOf(intPart, ord[1])) continue;

    let currency = false;
    let mm;

    if ((mm = before.match(/\p{Sc}\s?$/u))) {
      currency = true;
      before = before.slice(0, before.length - mm[0].length);
    } else if ((mm = before.match(/(?<!\p{L})([\p{L}.]{1,6})\s*$/u)) && isLeadingCurrency(mm[1])) {
      currency = true;
      before = before.slice(0, before.length - mm[0].length);
    }

    if (!currency && (mm = after.match(/^\s?(\p{Sc}|[\p{L}.]+)/u)) && isTrailingCurrency(mm[1])) {
      currency = true;
      after = after.slice(mm[0].length);
    }

    let score;
    if (currency) {
      score = 3;
    } else {
      const kw = KW_BEFORE.test(before.toLowerCase());
      const follow = FOLLOW_OK.test(after.toLowerCase());
      if (suffix) {
        if (kw || follow) score = 2; else continue;
      } else if (kw && follow) {
        score = 2;
      } else if (follow && intPart.replace(/,/g, '').length >= 2) {
        score = 1;
      } else {
        continue;
      }
    }

    let value = parseFloat(intPart.replace(/,/g, '') + (decPart || ''));
    if (suffix) value *= suffixMultiplier(suffix);
    if (!isFinite(value) || value <= 0) continue;

    if (!best || score > best.score) best = { value, score, index: m.index };
  }
  return best;
}

const formatAmount = v => String(+v.toFixed(2));

/* ───────────────────────── Categories ───────────────────────── */

const wordRe = (alts, flags = 'iu', plural = true) =>
  new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alts})${plural ? '(?:s|es)?' : ''}(?![\\p{L}\\p{N}_])`, flags);

const CATEGORY_DEFS = {
  "Bills & Utilities": {
    items: '(?:electricity|electric|water|gas|phone|mobile|internet|power)\\s+bill|electricity|elecricity|internet|wifi|wi-fi|rent|utility|utilities|housing|insurance',
    verbs: 'paid bill|recharged'
  },
  "Medical": {
    items: 'coffin|casket|funeral|cemetery|burial|hospital|medical|doctor|ambulance|medicine|medication|pharmacy|clinic|dentist|surgery|prescription',
    verbs: 'passed away|died|buried'
  },
  "Food": {
    items: 'burger|cheeseburger|pizza|food|lunch|dinner|coffee|restaurant|meal|breakfast|snack|bakery|café|cafe|groceries|grocery|supermarket|mcdonalds|starbucks|takeout|eats|donut|doughnut|cake|chocolate|pastry|sandwich|ice cream|tea|drink|juice|beer|wine|soup|noodle|rice|meat|chicken|beef|pork|fish|salad|durian|fruit|bun|cheese|apple|banana|orange|bread|egg|milk|dessert|biryani|curry|kottu|water|beans|popcorn|fries|chips|sushi|biscuit|cookie|candy|sweets|roti|dosa|hopper|hoppers|kiribath|pasta|shawarma|smoothie|milkshake|soda',
    verbs: 'ate|eaten|eating|drank|drinking|drunk|dined|dining|cooked|baking|baked|ordered|hungry|tasted|chewed|swallowed|had lunch|had dinner|had breakfast|had food|had coffee|grabbed a drink'
  },
  "Travel": {
    items: 'flight|airline|uber|lyft|pickme|taxi|cab|train|bus|tuk tuk|tuktuk|subway|metro|hotel|airbnb|vacation|trip|tour|petrol|diesel|gas|fuel|toll|parking|fare|transport|highway',
    verbs: 'flew|flying|drove|driving|stayed|staying|traveled|travelled|traveling|travelling|visited|visiting|boarded|boarding|landed|commuted'
  },
  "Clothing": {
    items: 'clothes|clothing|t-shirt|shirt|pants|trousers|shoe|dress|jacket|coat|socks|hat|boots|apparel|jeans|hoodie|sweater|suit|skirt|sneakers|garment|saree|sarong|slippers|sandals',
    verbs: 'wore|wearing|tried on|fitted|tailored|dressed'
  },
  "Personal Care": {
    items: 'salon|haircut|barber|makeup|skincare|spa|gym|fitness|hygiene|toiletries|shampoo|soap|facial|massage|cologne|perfume|dumbbell|weight|toothpaste|deodorant|lotion|manicure|pedicure',
    verbs: 'shaved|shaving|trimmed|showered|groomed|worked out|exercised'
  },
  "Entertainment": {
    items: 'movie|cinema|concert|ticket|game|streaming|netflix|spotify|hbo|hulu|steam|playstation|xbox|event|show|theater|theatre|music|album|festival|swim|swimming|bowling|zoo|museum|amusement park',
    verbs: 'watched|watching|listened|listening|played|playing|streamed|attended|swam|swimming'
  },
  "Investment": {
    items: 'investment|investments|stock|stocks|shares|mutual fund|index fund|crypto|cryptocurrency|bitcoin|ethereum|etf|bond|bonds|fixed deposit|treasury bill|t-bill|forex|bullion|dividend|gold|silver|real estate|s&p|nasdaq|dow jones|nifty|sensex',
    verbs: 'invested|investing'
  },
  "Savings": {
    items: 'savings|piggy bank',
    verbs: 'saved|saving|put aside'
  },
  "Donation": {
    items: 'donation|charity|tithe',
    verbs: 'donated|donating'
  },
  "Purchase": {
    items: 'bought|brought|purchase|purchased|store|shop|electronics|amazon|retail|mall|laptop|phone|item|gadget|device|hardware|tool|charger|headphones|furniture|book|gift|maker|machine|grinder|blender|kettle|cooker|oven|fridge|refrigerator|stove|toaster|mixer',
    verbs: 'bought|brought|purchased|acquired|got'
  }
};

const CATEGORIES = Object.entries(CATEGORY_DEFS).map(([name, d]) => ({
  name,
  items: wordRe(d.items),
  itemsG: wordRe(d.items, 'giu'),
  verbs: wordRe(d.verbs, 'iu', false)
}));

const GENERIC_WORDS = /^(?:bought|brought|purchase[sd]?|store|shop|mall|retail|item)(?:s|es)?$/i;
const GOODS_RE = wordRe('maker|machine|grinder|blender|kettle|cooker|oven|fridge|refrigerator|stove|toaster|mixer|mug|flask|pan|pot|bowl|bottle|knife');

const WEAK_HEADS = new Set(['ticket', 'event', 'show', 'tour', 'trip', 'game', 'fare']);
const isWeakHead = w => WEAK_HEADS.has(w.toLowerCase().replace(/s$/, ''));

/* ───────────────────────── Phrase / detail helpers ───────────────────────── */

const BOUNDARY = new Set([
  'a', 'an', 'the', 'some', 'my', 'our', 'his', 'her', 'their', 'your', 'its', 'this', 'that', 'these', 'those',
  'it', 'them', 'him', 'me', 'us', 'i', 'we', 'he', 'she', 'they', 'you',
  'and', 'or', 'but', 'so', 'because', 'since', 'if', 'as', 'for', 'on', 'at', 'with', 'using', 'by', 'in',
  'into', 'from', 'to', 'via', 'of', 'off', 'over', 'under', 'than', 'then', 'after', 'before', 'when', 'while',
  'during', 'until', 'about', 'around', 'per', 'plus', 'through',
  'is', 'are', 'was', 'were', 'be', 'been', 'am', 'do', 'did', 'does', 'done', 'has', 'have', 'had', 'get', 'got',
  'will', 'would', 'can', 'could', 'should',
  'cost', 'costs', 'paid', 'pay', 'paying', 'spent', 'spend', 'spending', 'bought', 'buy', 'ordered', 'cash', 'card',
  'ate', 'eat', 'eaten', 'drank', 'drink', 'took', 'take', 'went', 'go', 'going', 'came', 'gave', 'sold', 'left',
  'order', 'rent', 'rented', 'hire', 'hired', 'book', 'booked',
  'too', 'again', 'also', 'later', 'earlier', 'now', 'just', 'only', 'yet', 'still', 'there', 'here', 'out', 'ago',
  'which', 'who', 'where', 'what', 'how', 'not', 'no', 'all', 'each', 'every',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'another', 'few', 'couple'
]);

const PARTICIPLE_BOUNDARY = new Set([
  'delivered', 'arrived', 'shipped', 'charged', 'cancelled', 'canceled', 'refunded', 'returned', 'received',
  'purchased', 'needed', 'wanted', 'used', 'finished', 'happened', 'grabbed', 'picked', 'enjoyed', 'tried',
  'renewed', 'tipped', 'donated', 'recharged', 'bounced', 'declined', 'approved', 'processed', 'billed',
  'invested', 'saved', 'deposited'
]);
const ADVERB_BOUNDARY = new Set([
  'quickly', 'finally', 'usually', 'already', 'recently', 'really', 'actually', 'totally', 'nearly', 'mostly',
  'probably', 'basically', 'eventually', 'immediately', 'luckily', 'sadly', 'unfortunately', 'honestly', 'apparently'
]);

function isBoundaryWord(w) {
  const l = w.toLowerCase();
  return BOUNDARY.has(l) || PARTICIPLE_BOUNDARY.has(l) || ADVERB_BOUNDARY.has(l) || isTrailingCurrency(w);
}

const VAGUE_WORDS = new Set([
  'something', 'anything', 'nothing', 'everything', 'stuff', 'thing', 'things', 'much', 'more', 'lot', 'lots',
  'way', 'time', 'times', 'day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years', 'home', 'work',
  'money', 'today', 'yesterday', 'tonight', 'morning', 'night', 'evening', 'afternoon', 'total', 'new',
  'one', 'ones', 'some', 'any', 'that', 'this', 'it', 'them', 'those', 'these', 'cash', 'card', 'paid', 'pay', 'spent',
  'rupees', 'rupee', 'dollars', 'dollar'
]);

function expandForward(str, idx, head) {
  let phrase = head;
  let rest = str.slice(idx + head.length);
  for (let i = 0; i < 2; i++) {
    const m = rest.match(/^\s+(\p{L}[\p{L}'’-]*)(?![\p{L}\d])/u);
    if (!m || isBoundaryWord(m[1])) break;
    phrase += ' ' + m[1];
    rest = rest.slice(m[0].length);
  }
  return phrase;
}

function expandBackward(str, idx) {
  let prefix = '';
  let before = str.slice(0, idx);
  for (let i = 0; i < 2; i++) {
    const m = before.match(/(\p{L}[\p{L}'’-]*)\s+$/u);
    if (!m || isBoundaryWord(m[1])) break;
    prefix = m[1] + ' ' + prefix;
    before = before.slice(0, before.length - m[0].length);
  }
  return prefix;
}

function categorize(sentence, amountIdx = -1) {
  let category = "Misc", detail = null, byItem = false;

  for (const c of CATEGORIES) {
    if (c.items.test(sentence)) {
      category = c.name;
      byItem = true;

      const hits = [...sentence.matchAll(c.itemsG)].filter(m => !GENERIC_WORDS.test(m[0]));
      if (hits.length) {
        let chosen = hits[0];
        if (amountIdx >= 0) {
          const dist = m => (m.index < amountIdx ? amountIdx - (m.index + m[0].length) : m.index - amountIdx);
          chosen = hits.reduce((b, m) => (dist(m) < dist(b) ? m : b), hits[0]);
        }

        const forward = expandForward(sentence, chosen.index, chosen[0]);
        const extra = forward.slice(chosen[0].length);
        detail = expandBackward(sentence, chosen.index) + forward;
        if (extra && GOODS_RE.test(extra)) category = "Purchase";

        if (detail.trim().toLowerCase() === chosen[0].toLowerCase() && isWeakHead(chosen[0])) {
          const mod = hits.find(m => m.index < chosen.index && !isWeakHead(m[0]) &&
            m[0].toLowerCase() !== chosen[0].toLowerCase());
          if (mod) detail = mod[0] + ' ' + detail;
        }
      }
      break;
    }
  }
  if (!byItem) {
    for (const c of CATEGORIES) {
      if (c.verbs.test(sentence)) { category = c.name; break; }
    }
  }
  const verbHit = CATEGORIES.some(c => c.verbs.test(sentence));
  return { category, detail, byItem, verbHit };
}

function detailFromText(str) {
  const patterns = [
    /\b(?:as|on|for|spend|spent|buy|bought|pay|paid|ordered)\s+(?:(?:a|an|the|some|my|our|his|her|their|your|new)\s+)*(\p{L}[\p{L}'’-]{2,24})/giu,
    /\b(?:a|an|the|some)\s+(?:new\s+)?(\p{L}[\p{L}'’-]{2,24})/giu
  ];
  for (const rx of patterns) {
    for (const m of str.matchAll(rx)) {
      const head = m[1];
      if (isBoundaryWord(head)) continue;
      const phrase = expandForward(str, m.index + m[0].length - head.length, head);
      if (phrase.split(/\s+/).every(w => VAGUE_WORDS.has(w.toLowerCase()))) continue;
      return phrase;
    }
  }
  return null;
}

/* ───────────────────────── Investment details ───────────────────────── */

const isIndexLike = w =>
  /&/.test(w) || /^[A-Z]{2,6}$/.test(w) ||
  /^(?:nasdaq|nifty|sensex|russell|dow|sp|ftse|dax|nikkei|hang|cac|aspi|msci)$/i.test(w);

function readInvestName(str, pos, amountIdx) {
  let dm;
  while ((dm = /^(?:a|an|the|my|our|some)\s+/i.exec(str.slice(pos)))) pos += dm[0].length;

  const words = [];
  while (words.length < 4) {
    const t = str.slice(pos).match(/^([\p{L}\p{N}][\p{L}\p{N}&'’.-]*)/u);
    if (!t) break;
    const word = t[1].replace(/[.'’-]+$/, '');
    const isNum = /^\d+$/.test(word);

    if (!words.length) {
      if (isNum || isBoundaryWord(word) || VAGUE_WORDS.has(word.toLowerCase())) return null;
    } else if (isNum) {
      if (pos === amountIdx || !isIndexLike(words[words.length - 1])) break;
    } else if (isBoundaryWord(word) || VAGUE_WORDS.has(word.toLowerCase())) {
      break;
    }

    words.push(word);
    pos += t[0].length;
    const sp = str.slice(pos).match(/^\s+/);
    if (!sp) break;
    pos += sp[0].length;
  }
  return words.length ? words.join(' ') : null;
}

function investTarget(str, amountIdx = -1) {
  const patterns = [
    /\binvest(?:ed|ing|s|ment|ments)?\b.*?\b(?:in|into|on|at|towards?)\s+/iu,
    /\b(?:shares?|stocks?|units?|bonds?|etfs?)\s+(?:of|in)\s+/iu,
    /\b(?:put|placed|parked)\b.*?\b(?:in|into|on)\s+/iu
  ];
  for (const rx of patterns) {
    const m = rx.exec(str);
    if (!m) continue;
    const name = readInvestName(str, m.index + m[0].length, amountIdx);
    if (name) return name + ' Investment';
  }
  return null;
}

function addIndexNumber(str, detail, amountIdx) {
  const last = detail.trim().split(/\s+/).pop();
  if (!isIndexLike(last)) return detail;
  const esc = last.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${esc}\\s+(\\d{2,5})(?![\\d,.])`, 'i').exec(str);
  if (!m) return detail;
  const numIdx = m.index + m[0].length - m[1].length;
  return numIdx === amountIdx ? detail : detail.trim() + ' ' + m[1];
}

function withInvestmentSuffix(detail) {
  if (!detail || detail === "Not specified") return "Investment";
  return /\binvestments?\b/i.test(detail) ? detail : detail + ' Investment';
}

const toTitleCase = s => s
  .replace(/(^|[\s-])(\p{L})/gu, (_, p, c) => p + c.toUpperCase())
  .replace(/\b([A-Za-z])&([A-Za-z])\b/g, (_, a, b) => a.toUpperCase() + '&' + b.toUpperCase())
  .replace(/\b(?:etf|ipo|sip|fd|usd|lkr)\b/gi, m => m.toUpperCase());

/* ───────────────────────── Sentence filters ───────────────────────── */

const EXPENSE_KEYWORDS = /\b(?:spent|spend|spending|paid|pay|paying|cost|costs|costing|buy|bought|brought|purchase|purchased|ordered|charged|rent|ate|drank|booked|tipped|donated|recharged|invested)\b/i;
const PRONOUN_RE = /\b(?:that|it|this|them|those|these)\b/i;
const CARD_RE = /\b(?:credit|debit|visa|mastercard|amex|apple pay|google pay|paypal|venmo|zelle|upi|bank transfer|online transfer|online payment|net banking|card payment|bank payment|(?:by|with|using|via|through|from|on)\s+(?:(?:my|the|a)\s+)?(?:card|bank(?:\s+(?:account|card))?))\b/i;
const CASH_RE = /\bcash\b/i;

const DANGLING_METHOD_RE = /\b(?:using|with|by|via|through)\s*$/i;

const CASH_IN_RES = [
  /\bwi?th?dr[a-z]*\b/i,
  /\b(?:drew|drawn|dron|drawed|draw)\b[^.]*?\b(?:bank|atm|account|savings)\b/i,
  /\b(?:took|taken|got|collected|picked up|pulled|grabbed)\b[^.]*?\b(?:from|form|frm|fro)\s+(?:the\s+|my\s+|a\s+)?(?:bank|atm|account|savings)\b/i,
  /\badded\s+(?:it\s+|them\s+|that\s+)?to\s+(?:my\s+)?(?:cash|wallet|pocket)\b/i
];
const isCashIn = s => CASH_IN_RES.some(r => r.test(s));

const ACCT = '(?:bank|card|cash|wallet|savings|account|atm)';
const TRANSFER_RE = new RegExp(
  `\\b(?:transfer(?:r?ed|ring|s)?|moved?|sent|shifted|switched)\\b[^.]*?\\bfrom\\s+(?:my\\s+|the\\s+|a\\s+)?(${ACCT})(?:\\s+account)?\\s+(?:in)?to\\s+(?:my\\s+|the\\s+|a\\s+)?(${ACCT})\\b`, 'i');
const isCashLike = w => /^(?:cash|wallet)$/i.test(w);
const methodLabel = w => isCashLike(w) ? "Cash" : NON_CASH_METHOD;

function inferMethodFromText(t) {
  if (!t) return null;
  const tr = t.match(TRANSFER_RE);
  if (tr) return isCashLike(tr[2]) ? "Cash" : NON_CASH_METHOD;
  const card = CARD_RE.test(t), cash = CASH_RE.test(t);
  if (card && !cash) return NON_CASH_METHOD;
  if (cash && !card) return "Cash";
  return null;
}

const BANK_DEPOSIT_RE = /\b(?:deposit(?:ed|ing)?|put|transfer(?:r?ed|ring|s)?|moved|added|paid in)\b[^.]*?\b(?:in|into|to)\s+(?:my\s+|the\s+|a\s+)?(?:bank|savings|savings account|account|fixed deposit)\b/i;

const INCOME_RE = /\b(?:(?:got|get|received|receive)\b[^.]*?\bfrom\s+(?:my\s+|his\s+|her\s+|our\s+|the\s+|a\s+)?(?:dad|father|mom|mum|mother|parents?|brother|sister|friend|uncle|aunt|grand(?:ma|pa|mother|father)|boss|company|employer|wife|husband|client|work|job)\b|gifts?\s+of\b|(?:gave|gives|give|gifted|sent|sends|lent|lends|handed|paid|pays|pay|owes?|transferred)\s+me|got paid|earned|earning|received|won|sold|salary|wages?|refund(?:ed)?|allowance|pocket money)\b/i;

const REST_RE = /\b(invested|saved|deposited|donated|spent|kept)\s+(?:(?:all|the|of|whatever|what)\s+)*(?:(?:was|is)\s+)?(?:rest|remaining|remainder|balance|leftovers?|left\s?over|change|excess|surplus|left)\b/i;
const REST_MAP = {
  invested:  { category: "Investment", detail: "Investment (Remaining Balance)" },
  saved:     { category: "Savings",    detail: "Savings (Remaining Balance)" },
  deposited: { category: "Savings",    detail: "Deposit (Remaining Balance)" },
  donated:   { category: "Donation",   detail: "Donation (Remaining Balance)" },
  spent:     { category: "Misc",       detail: "Remaining Balance" },
  kept:      { category: "Savings",    detail: "Savings (Remaining Balance)" }
};

const VERBS_ALL = 'buy|bought|pay|paid|spend|spent|eat|ate|eaten|order|ordered|purchase|purchased|book|booked|reserve|reserved|rent|rented|hire|hired|recharge|recharged|invest|invested|save|saved';
const NEGATED = new RegExp(`\\b(?:didn'?t|did not|never|haven'?t|have not|hadn'?t|had not|don'?t|do not|won'?t|will not|couldn'?t|could not)\\s+(?:\\w+\\s+){0,2}(?:${VERBS_ALL})\\b`, 'i');
const FUTURE = new RegExp(`\\b(?:will|going to|gonna|plan to|planning to|want to|wanna|need to|should|might|may|have to|has to)\\s+(?:\\w+\\s+){0,2}(?:${VERBS_ALL})\\b`, 'i');

/* ───────────────────────── Clause splitting ───────────────────────── */

const SPLIT_VERBS = 'spent|spend|paid|pay|bought|buy|ordered|order|purchased|purchase|had|ate|eat|drank|drink|got|booked|tipped|donated|recharged|rented|renewed|invested|saved|deposited|withdrew|withdrawn|drew';
const VERB_START = new RegExp(`^(?:(?:i|we|he|she|they|then|also)\\s+)*(?:${SPLIT_VERBS})\\b`, 'i');

const PREDICATE_RE = new RegExp(
  String.raw`^(?!(?:i|we|he|she|they|you|it)\b)(?:(?:the|my|our|a|an)\s+)?[\p{L}'’-]+(?:\s+[\p{L}'’-]+){0,3}?\s+` +
  String.raw`(?:(?:was|were|is|are)\s+(?:(?:about|around|only|just|roughly)\s+)?(?:\p{Sc}\s?|[A-Za-z]{2,3}\s?)?\d` +
  String.raw`|(?:cost|costs|came to|comes to|totaled|totalled|set me back)\b)`,
  'iu'
);
const SPLIT_RE = /\s*,\s+(?:(?:and|then|also)\s+)?|\s+(?:and then|and also|after that|and|then|also|plus)\s+/gi;

function splitClauses(sentence) {
  const single = { parts: [sentence], multi: false, dateSplit: false };
  if (/\?\s*$/.test(sentence)) return single;

  const masked = sentence.replace(new RegExp(DATE_SRC, 'gi'), m => '\u0000'.repeat(m.length));
  const spans = [];
  let last = 0;
  for (const m of masked.matchAll(SPLIT_RE)) {
    spans.push([last, m.index]);
    last = m.index + m[0].length;
  }
  spans.push([last, sentence.length]);

  const clean = t => t.trim().replace(/^(?:and|then|also|plus)\s+/i, '');
  const items = spans
    .map(([s, e]) => ({ s, e, text: clean(sentence.slice(s, e)) }))
    .filter(x => x.text);
  const cleaned = items.map(x => x.text);
  if (cleaned.length < 2) return single;

  const hasAmount = p => !!findAmount(stripDates(p));
  const hasVerb = p => EXPENSE_KEYWORDS.test(p) || VERB_START.test(p) || CATEGORIES.some(c => c.verbs.test(p));
  const isIndependent = p => VERB_START.test(p) || (PREDICATE_RE.test(p) && hasAmount(p));

  const allAmounts = cleaned.every(hasAmount);
  const allClauses = cleaned.every((p, i) => i === 0 ? (hasAmount(p) || hasVerb(p)) : isIndependent(p));

  if (allAmounts || allClauses) return { parts: cleaned, multi: true, dateSplit: false };

  const dateOnly = p => DATE_RE.test(p) && !hasAmount(p) && !hasVerb(p);
  if (items.some((x, i) => i > 0 && dateOnly(x.text))) {
    const groups = [];
    items.forEach((x, i) => {
      const lastGroup = groups[groups.length - 1];
      if (i > 0 && dateOnly(x.text)) groups.push([x]);
      else if (lastGroup && !dateOnly(lastGroup[0].text)) lastGroup.push(x);
      else groups.push([x]);
    });
    if (groups.length > 1) {
      const parts = groups
        .map(g => clean(sentence.slice(g[0].s, g[g.length - 1].e)))
        .filter(Boolean);
      return { parts, multi: false, dateSplit: true };
    }
  }

  return single;
}

/* ───────────────────────── Main extraction ───────────────────────── */

const CONTEXT_MAX_GAP = 1;

async function extractExpenseDetailsUltimate(text) {
  const cleanText = normalizeTextInput(text);

  const sentences = cleanText
    .split(/(?<=[.!?])\s+|\n+|;\s*/)
    .map(s => s.trim())
    .filter(Boolean);

  const clauses = [];
  sentences.forEach((s, si) => {
    const { parts, multi, dateSplit } = splitClauses(s);
    const sd = s.match(DATE_RE);
    parts.forEach(p => clauses.push({
      text: p, multi, si,
      sentenceText: s,
      sentenceDate: (sd && !dateSplit) ? sd[0] : null
    }));
  });

  const results = [];
  const missingFlags = [];
  const rowSentence = [];
  let currentDate = null;
  let ctx = null;

  let balance = null;
  const addToBalance = v => { balance = (balance || 0) + v; };
  const spendFromBalance = v => { if (balance !== null) balance = Math.max(0, balance - v); };

  for (const { text: raw, multi, si, sentenceText, sentenceDate } of clauses) {
    if (/\?\s*$/.test(raw)) continue;
    const sentence = raw.replace(/[.!]+$/, '').trim();
    if (!sentence) continue;

    const allowFuture = FUTURE_DATE_CUE.test(sentenceText);
    const ownDate = sentence.match(DATE_RE);
    const dateStr = ownDate ? ownDate[0] : sentenceDate;

    if (FUTURE_WORDS.test(sentence)) {
      currentDate = null;
      continue;
    }

    if (dateStr && isFutureDate(dateStr, allowFuture)) {
      currentDate = null;
      continue;
    }

    if (dateStr) currentDate = getFormattedDate(dateStr);
    const formattedDate = currentDate || defaultDateStr();
    const noDate = stripDates(sentence);

    if (NEGATED.test(noDate) || FUTURE.test(noDate)) continue;

    const tr = noDate.match(TRANSFER_RE);
    if (tr) {
      const trAmt = findAmount(noDate);
      if (trAmt) {
        const from = tr[1], to = tr[2];
        const fromLabel = methodLabel(from), toLabel = methodLabel(to);
        if (fromLabel !== toLabel) {
          const amt = formatAmount(trAmt.value);
          results.push([formattedDate, amt, "Transfer", "Transfer", fromLabel]);
          results.push([formattedDate, amt, "Transfer", "Transfer", toLabel]);
          missingFlags.push(false, false);
          rowSentence.push(si, si);
          if (isCashLike(to) && !isCashLike(from)) addToBalance(trAmt.value);
          else if (isCashLike(from) && !isCashLike(to)) spendFromBalance(trAmt.value);
        }
        continue;
      }
    }

    const isInvestSentence = /\binvest(?:ed|ing|s|ment|ments)?\b/i.test(noDate);

    if (isCashIn(noDate)) {
      const inc = findAmount(noDate);
      if (inc) addToBalance(inc.value);
      continue;
    }

    if (!isInvestSentence && BANK_DEPOSIT_RE.test(noDate)) {
      const dep = findAmount(noDate);
      if (dep) {
        results.push([formattedDate, formatAmount(dep.value), "Bank Deposit", "Savings", "Cash"]);
        missingFlags.push(false);
        rowSentence.push(si);
        spendFromBalance(dep.value);
        continue;
      }
    }

    if (INCOME_RE.test(noDate)) {
      const inc = findAmount(noDate);
      if (inc) addToBalance(inc.value);
      continue;
    }

    const restMatch = noDate.match(REST_RE);
    if (restMatch && !findAmount(noDate.slice(0, restMatch.index + restMatch[0].length))) {
      const info = REST_MAP[restMatch[1].toLowerCase()] || REST_MAP.spent;
      let payRest;
      if (CARD_RE.test(sentence) && !CASH_RE.test(sentence)) payRest = NON_CASH_METHOD;
      else if (CASH_RE.test(sentence)) payRest = "Cash";
      else payRest = defaultMethod(info.category);

      let restDetail = info.detail;
      if (info.category === "Investment") {
        const tgt = investTarget(noDate);
        if (tgt) restDetail = toTitleCase(tgt);
      }

      if (balance !== null && balance > 0) {
        results.push([formattedDate, formatAmount(balance), restDetail, info.category, payRest]);
        missingFlags.push(false);
        rowSentence.push(si);
        balance = 0;
      } else if (balance === null) {
        let fallbackAmount = "0";
        try {
          fallbackAmount = String(await getAmountFromCx(sentence, restDetail));
        } catch (err) {
          console.error("getAmountFromCx failed:", err);
        }
        results.push([formattedDate, fallbackAmount, restDetail, info.category, payRest]);
        missingFlags.push(true);
        rowSentence.push(si);
      }
      continue;
    }

    const amountInfo = findAmount(noDate);
    const amountIdx = amountInfo ? amountInfo.index : -1;
    const cat = categorize(noDate, amountIdx);
    const hasKeyword = EXPENSE_KEYWORDS.test(noDate) || cat.verbHit;

    if (!amountInfo && !hasKeyword && !cat.byItem) continue;
    if (amountInfo && amountInfo.score < 3 && !hasKeyword && !cat.byItem && !multi) continue;

    let explicitMethod = null;
    if (CARD_RE.test(sentence) && !CASH_RE.test(sentence)) {
      explicitMethod = NON_CASH_METHOD;
    } else if (CASH_RE.test(sentence)) {
      explicitMethod = "Cash";
    } else if (DANGLING_METHOD_RE.test(sentence)) {
      explicitMethod = inferMethodFromText(sentences[si + 1]);
    }
    const pick = c => explicitMethod || defaultMethod(c);

    const ctxValid = ctx && (si - ctx.si) <= CONTEXT_MAX_GAP;
    let detail = "Not specified";
    let category = cat.category;
    let fromContext = false;

    if (isInvestSentence) category = "Investment";

    const invDetail = category === "Investment" ? investTarget(noDate, amountIdx) : null;

    if (invDetail) {
      detail = invDetail;
    } else if (cat.detail) {
      detail = category === "Investment" ? addIndexNumber(noDate, cat.detail, amountIdx) : cat.detail;
    } else if (PRONOUN_RE.test(noDate) && ctxValid) {
      detail = ctx.item;
      fromContext = true;
      if (category === "Misc" && ctx.category) category = ctx.category;
    } else {
      const guess = detailFromText(noDate);
      if (guess) detail = guess;
    }

    if (detail !== "Not specified" && !fromContext) detail = toTitleCase(detail.trim());
    if (category === "Investment" && !fromContext) {
      detail = detail === "Not specified" ? "Investment" : withInvestmentSuffix(detail);
    }
    if (detail !== "Not specified") ctx = { item: detail, category, si };

    const amount = amountInfo ? formatAmount(amountInfo.value) : null;

    if (amount !== null) {
      let idx = -1;
      if (detail === "Not specified") {
        const lastRow = results.length - 1;
        if (lastRow >= 0 && missingFlags[lastRow] && (si - rowSentence[lastRow]) <= CONTEXT_MAX_GAP) idx = lastRow;
      } else {
        for (let i = results.length - 1; i >= 0; i--) {
          if (missingFlags[i] && results[i][2].toLowerCase() === detail.toLowerCase()) { idx = i; break; }
        }
      }
      if (idx !== -1) {
        const prev = results[idx];
        const finalDetail = detail === "Not specified" ? prev[2] : detail;
        const finalCategory = category === "Misc" ? prev[3] : category;
        results[idx] = [formattedDate, amount, finalDetail, finalCategory, pick(finalCategory)];
        missingFlags[idx] = false;
        rowSentence[idx] = si;
        spendFromBalance(amountInfo.value);
        if (finalDetail !== "Not specified") ctx = { item: finalDetail, category: finalCategory, si };
        continue;
      }

      if (detail === "Not specified" && category !== "Misc") detail = category;

      results.push([formattedDate, amount, detail, category, pick(category)]);
      missingFlags.push(false);
      rowSentence.push(si);
      spendFromBalance(amountInfo.value);
      continue;
    }

    if (detail !== "Not specified") {
      let fallbackAmount = "0";
      try {
        fallbackAmount = String(await getAmountFromCx(sentence, detail));
      } catch (err) {
        console.error("getAmountFromCx failed:", err);
      }
      results.push([formattedDate, fallbackAmount, detail, category, pick(category)]);
      missingFlags.push(true);
      rowSentence.push(si);
    }
  }

  return results.filter(r => parseFloat(r[1]) > 0);
}


/* ═════════════════════════════════════════════════════════════════════
   VOICE INPUT  (Whisper tiny, runs fully in the browser)
   - Whisper runs in a Web Worker (UI never freezes)
   - Audio captured with an AudioWorklet (off the main thread)
   - Only finished speech segments are transcribed (split on silence)
   - Model starts loading in the background so the mic is ready quickly
   ═════════════════════════════════════════════════════════════════════ */

const VoiceInput = (() => {
  const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

  const TARGET_RATE = 16000;                  // Whisper expects 16 kHz
  const VAD_RMS = 0.012;                      // loudness above this counts as speech
  const SILENCE_END = 0.7 * TARGET_RATE;      // 0.7 s of silence ends a segment
  const MAX_SEGMENT = 10 * TARGET_RATE;       // force a cut after 10 s of continuous speech
  const MIN_VOICED = 0.3 * TARGET_RATE;       // ignore blips shorter than 0.3 s
  const PRE_ROLL_CHUNKS = 3;                  // keep a little audio before speech

  const hooks = {
    canvas: null,
    onUpdate: () => {},
    onProgress: () => {},
    onReady: () => {},
    onError: () => {},
    onFinish: () => {}
  };

  const WORKER_SRC = `
import { pipeline, env } from '${TRANSFORMERS_URL}';
env.allowLocalModels = false;

let loading = null;
let chain = Promise.resolve();

function load() {
  if (!loading) {
    loading = pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
      quantized: true,
      progress_callback: p => {
        if (p.status === 'progress') self.postMessage({ type: 'progress', progress: p.progress });
      }
    }).then(t => {
      self.postMessage({ type: 'ready' });
      return t;
    }).catch(err => {
      loading = null;
      self.postMessage({ type: 'error', message: err.message });
      throw err;
    });
  }
  return loading;
}

self.onmessage = e => {
  const msg = e.data;
  if (msg.type === 'load') {
    load().catch(() => {});
  } else if (msg.type === 'transcribe') {
    chain = chain.then(async () => {
      try {
        const t = await load();
        const out = await t(msg.audio, { return_timestamps: false });
        self.postMessage({ type: 'result', id: msg.id, text: (out.text || '').trim() });
      } catch (err) {
        self.postMessage({ type: 'result', id: msg.id, text: '', error: err.message });
      }
    });
  }
};
`;

  const WORKLET_SRC = `
class PCMCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          const out = this.buf.slice(0);
          this.port.postMessage(out, [out.buffer]);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PCMCapture);
`;

  const blobUrl = src => URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));

  let state = 'idle';
  let modelReady = false;
  let worker = null;
  let workletUrl = null;
  let startToken = 0;

  let mediaStream = null;
  let audioContext = null;
  let workletNode = null;
  let silentGain = null;
  let audioSource = null;
  let analyser = null;
  let dataArray = null;
  let rafId = null;

  let preRoll = [];
  let segment = [];
  let segSamples = 0;
  let silenceSamples = 0;
  let speaking = false;

  let finalParts = [];
  let nextId = 0;
  let sessionStartId = 0;
  let pending = 0;

  const currentText = () => finalParts.join(' ').trim();
  const emitUpdate = () => hooks.onUpdate({ state, text: currentText(), busy: speaking || pending > 0 });

  function getWorker() {
    if (worker) return worker;

    worker = new Worker(blobUrl(WORKER_SRC), { type: 'module' });

    worker.onmessage = e => {
      const msg = e.data;

      if (msg.type === 'progress') {
        hooks.onProgress(msg.progress);
      } else if (msg.type === 'ready') {
        modelReady = true;
        hooks.onReady();
      } else if (msg.type === 'result') {
        if (msg.id < sessionStartId) return;
        pending = Math.max(0, pending - 1);
        const clean = (msg.text || '').replace(/\[[^\]]*\]|\([^)]*\)/g, '').trim();
        if (clean) finalParts.push(clean);
        emitUpdate();
        maybeFinish();
      } else if (msg.type === 'error') {
        pending = 0;
        if (state === 'finishing') state = 'idle';
        hooks.onError('Failed to load the speech engine: ' + msg.message);
      }
    };

    worker.onerror = e => {
      pending = 0;
      if (state === 'finishing') state = 'idle';
      hooks.onError('Speech engine error: ' + (e.message || 'could not start worker'));
    };

    worker.postMessage({ type: 'load' });
    return worker;
  }

  function resizeCanvas() {
    const c = hooks.canvas;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const r = c.getBoundingClientRect();
    c.width = Math.max(1, Math.round(r.width * dpr));
    c.height = Math.max(1, Math.round(r.height * dpr));
  }

  function clearCanvas() {
    const c = hooks.canvas;
    if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height);
  }

  function draw() {
    const c = hooks.canvas;
    if (!analyser || !c) return;
    rafId = requestAnimationFrame(draw);
    analyser.getByteTimeDomainData(dataArray);

    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, w, h);

    ctx.shadowBlur = 0;
    ctx.lineWidth = dpr;
    ctx.strokeStyle = 'rgba(74, 222, 128, 0.14)';
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, 'rgba(74, 222, 128, 0)');
    grad.addColorStop(0.18, '#4ade80');
    grad.addColorStop(0.82, '#6f8fae');
    grad.addColorStop(1, 'rgba(111, 143, 174, 0)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2.5 * dpr;
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(74, 222, 128, 0.45)';
    ctx.shadowBlur = 8 * dpr;
    ctx.beginPath();

    const slice = w / dataArray.length;
    for (let i = 0; i < dataArray.length; i++) {
      const v = (dataArray[i] - 128) / 128;
      const y = Math.max(2, Math.min(h - 2, h / 2 + v * (h / 2) * 1.8));
      if (i === 0) ctx.moveTo(0, y);
      else ctx.lineTo(i * slice, y);
    }
    ctx.stroke();
  }

  function stopVisualizer() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    analyser = null;
    clearCanvas();
  }

  function resampleTo16k(input, inRate) {
    if (inRate === TARGET_RATE) return input;
    const ratio = inRate / TARGET_RATE;
    const len = Math.floor(input.length / ratio);
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, input.length - 1);
      const f = pos - i0;
      out[i] = input[i0] * (1 - f) + input[i1] * f;
    }
    return out;
  }

  function createContext() {
    const AC = window.AudioContext || window.webkitAudioContext;
    try { return new AC({ sampleRate: TARGET_RATE }); } catch (e) { return new AC(); }
  }

  function rmsOf(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  function resetSegmenter() {
    preRoll = [];
    segment = [];
    segSamples = 0;
    silenceSamples = 0;
    speaking = false;
  }

  function flushSegment() {
    const voiced = segSamples - silenceSamples;
    if (segment.length && voiced >= MIN_VOICED) {
      const audio = new Float32Array(segSamples);
      let offset = 0;
      for (const c of segment) { audio.set(c, offset); offset += c.length; }

      pending++;
      getWorker().postMessage({ type: 'transcribe', id: nextId++, audio }, [audio.buffer]);
    }
    segment = [];
    segSamples = 0;
    silenceSamples = 0;
    speaking = false;
    emitUpdate();
  }

  function onAudioChunk(chunk) {
    if (state !== 'listening') return;
    const voiced = rmsOf(chunk) > VAD_RMS;

    if (!speaking) {
      if (voiced) {
        speaking = true;
        segment = [...preRoll, chunk];
        segSamples = segment.reduce((n, c) => n + c.length, 0);
        silenceSamples = 0;
        preRoll = [];
        emitUpdate();
      } else {
        preRoll.push(chunk);
        if (preRoll.length > PRE_ROLL_CHUNKS) preRoll.shift();
      }
      return;
    }

    segment.push(chunk);
    segSamples += chunk.length;
    silenceSamples = voiced ? 0 : silenceSamples + chunk.length;

    if (silenceSamples >= SILENCE_END || segSamples >= MAX_SEGMENT) flushSegment();
  }

  function cleanupAudio() {
    if (workletNode) { if (workletNode.port) workletNode.port.onmessage = null; workletNode.onaudioprocess = null; workletNode.disconnect(); workletNode = null; }
    if (silentGain) { silentGain.disconnect(); silentGain = null; }
    if (audioSource) { audioSource.disconnect(); audioSource = null; }
    if (audioContext && audioContext.state !== 'closed') audioContext.close();
    audioContext = null;
    if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
    stopVisualizer();
  }

  async function start() {
    if (state !== 'idle') return;
    state = 'starting';
    const token = ++startToken;

    finalParts = [];
    pending = 0;
    sessionStartId = nextId;
    resetSegmenter();
    getWorker();
    emitUpdate();

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
      });
      if (token !== startToken) { cleanupAudio(); return; }

      audioContext = createContext();
      if (audioContext.state === 'suspended') await audioContext.resume();

      // AudioWorklet is the preferred capture path, but it cannot load its blob script when the page is opened
      // straight from disk (file://). In that case fall back to a ScriptProcessorNode so the mic still works.
      let useWorklet = true;
      try {
        if (!audioContext.audioWorklet) throw new Error('no audioWorklet');
        if (!workletUrl) workletUrl = blobUrl(WORKLET_SRC);
        await audioContext.audioWorklet.addModule(workletUrl);
      } catch (e) {
        useWorklet = false;
      }
      if (token !== startToken) { cleanupAudio(); return; }

      audioSource = audioContext.createMediaStreamSource(mediaStream);

      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      dataArray = new Uint8Array(analyser.frequencyBinCount);
      audioSource.connect(analyser);
      resizeCanvas();
      draw();

      const inRate = audioContext.sampleRate;
      if (useWorklet) {
        workletNode = new AudioWorkletNode(audioContext, 'pcm-capture');
        workletNode.port.onmessage = e => onAudioChunk(resampleTo16k(e.data, inRate));
      } else {
        workletNode = audioContext.createScriptProcessor(2048, 1, 1);
        workletNode.port = {};   // keeps cleanupAudio() working for both node types
        workletNode.onaudioprocess = e => onAudioChunk(resampleTo16k(new Float32Array(e.inputBuffer.getChannelData(0)), inRate));
      }

      silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      audioSource.connect(workletNode);
      workletNode.connect(silentGain);
      silentGain.connect(audioContext.destination);

      state = 'listening';
      emitUpdate();
    } catch (err) {
      cleanupAudio();
      state = 'idle';
      hooks.onError('Microphone access failed: ' + err.message);
    }
  }

  function maybeFinish() {
    if (state === 'finishing' && pending === 0) {
      state = 'idle';
      hooks.onFinish(currentText());
    }
  }

  function stop() {
    if (state !== 'listening') return;
    flushSegment();
    cleanupAudio();
    state = 'finishing';
    emitUpdate();
    maybeFinish();
  }

  function cancel() {
    startToken++;
    cleanupAudio();
    resetSegmenter();
    finalParts = [];
    pending = 0;
    sessionStartId = nextId;
    state = 'idle';
    emitUpdate();
  }

  return {
    hooks,
    start,
    stop,
    cancel,
    resizeCanvas,
    getState: () => state,
    isModelReady: () => modelReady,
    preload: () => { getWorker(); }
  };
})();

/* ═════════════════════════════════════════════════════════════════════
   DAILY CAL CORE  (data store, settings, summary, forecast, charts)
   ═════════════════════════════════════════════════════════════════════ */

const DC = (() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const mk = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
  const stdev = a => {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1));
  };

  const lsGet = (k, fb) => {
    try { const v = window.localStorage.getItem(k); return v === null ? fb : JSON.parse(v); } catch (e) { return fb; }
  };
  const lsSet = (k, v) => {
    try { window.localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ }
  };
  const NS = window.DC_NS || '';   // per-account storage prefix (set by Auth.js)
  const LS_SETTINGS = NS + 'dailycal.settings.v1';
  const LS_TX = NS + 'dailycal.tx.v1';

  function hexToRgb(h) {
    h = String(h).replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    return isNaN(n) ? [0, 0, 0] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgbStr = h => hexToRgb(h).join(',');
  const rgba = (h, a) => `rgba(${rgbStr(h)},${a})`;
  function luminance(h) {
    const [r, g, b] = hexToRgb(h).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const onColor = h => luminance(h) > 0.4 ? '#04130a' : '#ffffff';

  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const pad = n => String(n).padStart(2, '0');
  const fmtDMY = d => `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
  function parseDMY(s) {
    const m = String(s).match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null;
  }
  const monthKey = d => d.getFullYear() * 12 + d.getMonth();
  const keyLabel = k => `${MON[k % 12]} ${String(Math.floor(k / 12)).slice(2)}`;

  /* ───────────────────────── settings ───────────────────────── */

  const FONTS = {
    system: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif',
    rounded: 'ui-rounded, "SF Pro Rounded", Nunito, "Segoe UI", system-ui, sans-serif',
    humanist: '"Trebuchet MS", "Gill Sans", Candara, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
  };

  const PALETTES = {
    Emerald: ['#4ade80', '#6f8fae', '#fbbf24', '#f87171', '#a78bfa', '#22d3ee', '#fb923c', '#f472b6'],
    Vibrant: ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#eab308'],
    Pastel:  ['#a7f3d0', '#bfdbfe', '#fde68a', '#fecaca', '#ddd6fe', '#a5f3fc', '#fed7aa', '#fbcfe8'],
    Ocean:   ['#38bdf8', '#818cf8', '#22d3ee', '#60a5fa', '#2dd4bf', '#a78bfa', '#67e8f9', '#93c5fd'],
    Sunset:  ['#fb923c', '#f43f5e', '#fbbf24', '#f472b6', '#a78bfa', '#fb7185', '#facc15', '#e879f9'],
    Mono:    ['#f5f5f5', '#d4d4d4', '#a3a3a3', '#737373', '#525252', '#e5e5e5', '#8a8a8a', '#404040']
  };

  const DEFAULTS = {
    bg: '#0f1110', panel: '#151817', card: '#1a1e1c', border: '#27332c',
    text: '#f3f4f6', muted: '#9ca3af',
    accent: '#4ade80', negative: '#f87171', secondary: '#6f8fae',
    titleGradient: true, gradStart: '#f3f4f6', gradEnd: '#4ade80', gradAngle: 90,
    bubbleStart: '#4ade80', bubbleEnd: '#3fbf72',
    cardGradient: true, sidebarGradient: true,
    glow1: '#4ade80', glow2: '#6f8fae', glowIntensity: 50,
    font: 'system', fontScale: 100, radius: 20, compact: false, animations: true,
    chartColors: PALETTES.Emerald.slice(),
    lineWidth: 3, tension: 0.35, pointRadius: 3, cutout: 62, showGrid: true, showLegend: true, chartAnim: true,
    currency: 'Rs.', decimals: 2, openingCash: 0, openingBank: 0, budget: 0, countSavings: false,
    forecastMethod: 'trend', forecastMonths: 6, historyMonths: 6, growth: 0, band: true,
    appName: window.DC_APP_NAME || 'Expenses Pro', heroTitle: 'Any Expenses or Gains Today?',
    tagline: 'Type it or just say it. ' + (window.DC_APP_NAME || 'Expenses Pro') + ' turns it into a tidy table.',
    placeholder: 'Type away or ask a question...', initials: 'DC', avatar: '',
    watermark: true, watermarkOpacity: 8, sidebarWidth: 320, historyDays: 14,
    cShowBal: true, cShowMonth: true, cShowCats: true, cShowToday: true,
    cRowCashBank: true, cRowIncome: true, cRowNet: true, cRowAvg: true, cRowBudget: true,
    cRowEntries: true, cRowPace: true, cRowSafe: true, cCatCount: 4, cExpand: true, cRecent: 5
  };

  const PRESETS = [
    { name: 'Emerald Night', v: { bg: '#0f1110', panel: '#151817', card: '#1a1e1c', border: '#27332c', text: '#f3f4f6', muted: '#9ca3af', accent: '#4ade80', negative: '#f87171', secondary: '#6f8fae', gradStart: '#f3f4f6', gradEnd: '#4ade80', bubbleStart: '#4ade80', bubbleEnd: '#3fbf72', glow1: '#4ade80', glow2: '#6f8fae', chartColors: PALETTES.Emerald } },
    { name: 'Ocean', v: { bg: '#0b1118', panel: '#0f1722', card: '#142030', border: '#223349', text: '#e6eef8', muted: '#8aa0b8', accent: '#38bdf8', negative: '#fb7185', secondary: '#818cf8', gradStart: '#e6eef8', gradEnd: '#38bdf8', bubbleStart: '#38bdf8', bubbleEnd: '#6366f1', glow1: '#38bdf8', glow2: '#818cf8', chartColors: PALETTES.Ocean } },
    { name: 'Sunset', v: { bg: '#14100f', panel: '#1b1514', card: '#231a18', border: '#3a2a26', text: '#f8efe9', muted: '#b39a90', accent: '#fb923c', negative: '#f43f5e', secondary: '#f472b6', gradStart: '#fde68a', gradEnd: '#f43f5e', bubbleStart: '#fb923c', bubbleEnd: '#f43f5e', glow1: '#fb923c', glow2: '#f472b6', chartColors: PALETTES.Sunset } },
    { name: 'Violet', v: { bg: '#100e17', panel: '#16131f', card: '#1d1928', border: '#2f2945', text: '#f1eefb', muted: '#a69fc0', accent: '#a78bfa', negative: '#fb7185', secondary: '#22d3ee', gradStart: '#f1eefb', gradEnd: '#a78bfa', bubbleStart: '#a78bfa', bubbleEnd: '#7c3aed', glow1: '#a78bfa', glow2: '#22d3ee', chartColors: PALETTES.Vibrant } },
    { name: 'Daylight', v: { bg: '#f4f7f5', panel: '#ffffff', card: '#ffffff', border: '#dfe7e2', text: '#14211a', muted: '#64736b', accent: '#16a34a', negative: '#dc2626', secondary: '#3b6a9b', gradStart: '#14211a', gradEnd: '#16a34a', bubbleStart: '#16a34a', bubbleEnd: '#15803d', glow1: '#16a34a', glow2: '#3b6a9b', chartColors: PALETTES.Vibrant } },
    { name: 'Midnight Mono', v: { bg: '#0a0a0a', panel: '#111111', card: '#171717', border: '#262626', text: '#fafafa', muted: '#a3a3a3', accent: '#e5e5e5', negative: '#f87171', secondary: '#737373', gradStart: '#fafafa', gradEnd: '#a3a3a3', bubbleStart: '#e5e5e5', bubbleEnd: '#a3a3a3', glow1: '#e5e5e5', glow2: '#737373', chartColors: PALETTES.Mono } }
  ];

  let S = Object.assign({}, DEFAULTS, lsGet(LS_SETTINGS, {}));
  // older versions had a single opening balance: keep it, as bank money
  function migrateOpening() {
    if (S.openingBalance && !S.openingCash && !S.openingBank) S.openingBank = S.openingBalance;
    delete S.openingBalance;
  }
  migrateOpening();
  // accounts made under the old name: switch their saved name/tagline over
  if (S.appName === 'Daily Cal') S.appName = DEFAULTS.appName;
  if (typeof S.tagline === 'string') S.tagline = S.tagline.replace('Daily Cal', DEFAULTS.appName);
  S.chartColors = (Array.isArray(S.chartColors) && S.chartColors.length === 8) ? S.chartColors.slice() : DEFAULTS.chartColors.slice();

  const handlers = { dayClick: null };

  function money(n) {
    const v = Number(n) || 0;
    const body = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: S.decimals, maximumFractionDigits: S.decimals });
    return `${v < 0 && Math.abs(v) >= Math.pow(10, -S.decimals) / 2 ? '- ' : ''}${S.currency} ${body}`;
  }
  function signedMoney(n) {
    const v = Number(n) || 0;
    if (Math.abs(v) < Math.pow(10, -S.decimals) / 2) return money(0);
    return (v > 0 ? '+ ' : '') + money(v);
  }
  function short(n) {
    const a = Math.abs(n), s = n < 0 ? '-' : '';
    if (a >= 1e6) return s + (a / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
    if (a >= 1e3) return s + (a / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
    return s + Math.round(a);
  }

  let txs = [];
  let idCounter = 1;
  const uid = () => 't' + Date.now().toString(36) + (idCounter++).toString(36);

  const isIncome = t => t.category === 'Income';
  const isTransfer = t => t.category === 'Transfer';
  const isSaving = t => t.category === 'Savings' || t.category === 'Investment';
  const isExpense = t => !isIncome(t) && !isTransfer(t) && (S.countSavings || !isSaving(t));

  function generateSample() {
    let seed = 20261029;
    const rnd = () => {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
    const pick = a => a[Math.floor(rnd() * a.length)];
    const r50 = v => Math.max(50, Math.round(v / 50) * 50);
    const between = (a, b) => a + rnd() * (b - a);

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const start = new Date(today.getFullYear(), today.getMonth() - 5, 1);
    const startKey = monthKey(start);
    const out = [];
    const add = (d, amount, detail, category, method) =>
      out.push({ id: uid(), date: fmtDMY(d), ts: d.getTime(), amount: r50(amount), detail, category, method, sample: true });

    for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
      const dt = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const day = dt.getDate();
      const g = 1 + (monthKey(dt) - startKey) * 0.03;

      if (day === 1) add(dt, 185000, 'Salary', 'Income', 'Card');
      if (day === 12 && rnd() < 0.75) add(dt, between(15000, 42000), 'Freelance', 'Income', 'Card');
      if (day === 20 && rnd() < 0.35) add(dt, between(3000, 9000), 'Gift', 'Income', 'Cash');
      if (day === 3) add(dt, 45000, 'House Rent', 'Bills & Utilities', 'Card');
      if (day === 6) add(dt, between(5200, 8200) * g, 'Electricity Bill', 'Bills & Utilities', 'Card');
      if (day === 8) add(dt, 4500, 'Internet Bill', 'Bills & Utilities', 'Card');
      if (day === 10) add(dt, 20000, 'Index Fund Investment', 'Investment', 'Card');
      if (day === 15) add(dt, 15000, 'Bank Deposit', 'Savings', 'Cash');

      if (rnd() < 0.75) add(dt, between(300, 1800) * g, pick(['Lunch', 'Dinner', 'Coffee', 'Groceries', 'Breakfast']), 'Food', rnd() < 0.4 ? 'Card' : 'Cash');
      if (rnd() < 0.40) add(dt, between(200, 1500) * g, pick(['Taxi', 'Fuel', 'Bus Fare', 'PickMe Ride']), 'Travel', 'Cash');
      if (dt.getDay() === 6 && rnd() < 0.6) add(dt, between(1500, 5000) * g, pick(['Movie', 'Concert Ticket', 'Streaming']), 'Entertainment', 'Card');
      if (rnd() < 0.05) add(dt, between(3000, 12000) * g, pick(['T-Shirt', 'Shoes', 'Jacket']), 'Clothing', 'Card');
      if (rnd() < 0.06) add(dt, between(1200, 4500) * g, pick(['Haircut', 'Gym Fee', 'Skincare']), 'Personal Care', 'Cash');
      if (rnd() < 0.03) add(dt, between(2000, 9000), pick(['Doctor Visit', 'Pharmacy']), 'Medical', 'Cash');
      if (rnd() < 0.03) add(dt, between(2500, 15000) * g, pick(['Headphones', 'Charger', 'Book Order']), 'Purchase', 'Card');
    }
    return out;
  }

  const Store = {
    all: () => txs,
    save() { lsSet(LS_TX, txs); },
    makeTx(row) {
      const d = parseDMY(row[0]);
      return {
        id: uid(), date: row[0], ts: d ? d.getTime() : Date.now(),
        amount: parseFloat(String(row[1]).replace(/,/g, '')) || 0,
        detail: String(row[2]), category: String(row[3]), method: String(row[4])
      };
    },
    addRows(rows) {
      rows.forEach(r => { const t = this.makeTx(r); r.txId = t.id; txs.push(t); });
      this.save();
    },
    updateFromRow(row) {
      const t = txs.find(x => x.id === row.txId);
      if (!t) return;
      const f = this.makeTx(row);
      if (t.category === 'Transfer') {
        // a transfer is two rows (from / to): editing the amount or date of one must move the other too
        const i = txs.indexOf(t);
        const mate = [txs[i + 1], txs[i - 1]].find(n => n && n.category === 'Transfer' && n.amount === t.amount && n.ts === t.ts && n.method !== t.method);
        if (mate) { mate.amount = f.amount; mate.date = f.date; mate.ts = f.ts; }
      }
      t.date = f.date; t.ts = f.ts; t.amount = f.amount; t.detail = f.detail; t.category = f.category; t.method = f.method;
      this.save();
    },
    toRow(t) {
      const r = [t.date, formatAmount(t.amount), t.detail, t.category, t.method];
      r.txId = t.id;
      return r;
    },
    onDay(d) {
      const ts = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      return txs.filter(t => t.ts === ts);
    },
    inMonth(y, m) {
      return txs.filter(t => { const d = new Date(t.ts); return d.getFullYear() === y && d.getMonth() === m; });
    },
    loadSample() { txs = txs.filter(t => !t.sample).concat(generateSample()); this.save(); },
    removeSample() { txs = txs.filter(t => !t.sample); this.save(); },
    clear() { txs = []; this.save(); }
  };

  const stored = lsGet(LS_TX, null);
  if (Array.isArray(stored)) txs = stored.filter(t => t && typeof t.amount === 'number' && t.date);
  else { txs = []; Store.save(); }   // new accounts start empty (sample data is in Settings)

  function agg(y, m) {
    const dim = new Date(y, m + 1, 0).getDate();
    const res = { y, m, income: 0, expenses: 0, saved: 0, count: 0, byCat: {}, incSrc: {}, daily: new Array(dim).fill(0), txs: [] };
    Store.inMonth(y, m).forEach(t => {
      const d = new Date(t.ts);
      res.txs.push(t);
      if (isIncome(t)) {
        res.income += t.amount;
        res.incSrc[t.detail] = (res.incSrc[t.detail] || 0) + t.amount;
        res.count++;
      } else if (!isTransfer(t)) {
        if (isSaving(t)) res.saved += t.amount;
        if (isExpense(t)) {
          res.expenses += t.amount;
          res.byCat[t.category] = (res.byCat[t.category] || 0) + t.amount;
          res.daily[d.getDate() - 1] += t.amount;
        }
        res.count++;
      }
    });
    res.net = res.income - res.expenses;
    return res;
  }

  function linreg(ys) {
    const n = ys.length;
    if (n < 2) return { slope: 0, intercept: ys[0] || 0 };
    const mx = (n - 1) / 2, my = mean(ys);
    let num = 0, den = 0;
    ys.forEach((y, i) => { num += (i - mx) * (y - my); den += (i - mx) * (i - mx); });
    const slope = den ? num / den : 0;
    return { slope, intercept: my - slope * mx };
  }

  function forecastSeries(history, steps) {
    const n = history.length, out = [];
    if (!n) return new Array(steps).fill(0);
    const method = S.forecastMethod;
    const lr = linreg(history);
    const wts = history.map((_, i) => i + 1);
    const wsum = wts.reduce((a, b) => a + b, 0);
    const weighted = history.reduce((s, v, i) => s + v * wts[i], 0) / wsum;
    const avg = mean(history);
    for (let k = 1; k <= steps; k++) {
      let v;
      if (method === 'trend' && n >= 3) v = lr.intercept + lr.slope * (n - 1 + k);
      else if (method === 'weighted') v = weighted;
      else v = avg;
      v *= Math.pow(1 + S.growth / 100, k);
      out.push(Math.max(0, v));
    }
    return out;
  }

  function computeForecast() {
    const now = new Date();
    const cy = now.getFullYear(), cm = now.getMonth(), dom = now.getDate();
    const dim = new Date(cy, cm + 1, 0).getDate();
    const curKey = cy * 12 + cm;

    const keys = [...new Set(txs.map(t => monthKey(new Date(t.ts))))].sort((a, b) => a - b);
    const prevKeys = keys.filter(k => k < curKey);
    const histKeys = prevKeys.slice(-S.historyMonths);
    const hist = histKeys.map(k => agg(Math.floor(k / 12), k % 12));
    const cur = agg(cy, cm);
    const pace = cur.expenses / dom * dim;

    const M = S.forecastMonths, steps = M + 1;
    let expS = hist.map(h => h.expenses), incS = hist.map(h => h.income), surrogate = false;
    if (!expS.length) {
      if (cur.count > 0) { expS = [pace]; incS = [cur.income]; surrogate = true; }
      else return { empty: true };
    }
    const fe = forecastSeries(expS, steps), fi = forecastSeries(incS, steps);
    const sdE = stdev(expS);

    const cats = new Set();
    (hist.length ? hist : [cur]).forEach(h => Object.keys(h.byCat).forEach(c => cats.add(c)));
    const catRows = [...cats].map(c => {
      const series = hist.length ? hist.map(h => h.byCat[c] || 0) : [(cur.byCat[c] || 0) / dom * dim];
      return { cat: c, avg: mean(series), next: forecastSeries(series, 2)[1] };
    }).sort((a, b) => b.next - a.next);

    let run = (S.openingCash || 0) + (S.openingBank || 0);
    const cumByKey = {};
    prevKeys.forEach(k => { run += agg(Math.floor(k / 12), k % 12).net; cumByKey[k] = run; });
    const balBefore = run;
    const balHist = histKeys.map(k => cumByKey[k]);
    const proj = [balBefore];
    for (let k = 1; k <= steps; k++) proj.push(proj[k - 1] + (fi[k - 1] - fe[k - 1]));

    const labels = histKeys.map(keyLabel);
    labels.push(keyLabel(curKey) + ' (now)');
    for (let k = 1; k <= M; k++) labels.push(keyLabel(curKey + k));

    return {
      empty: false, now, dom, dim, curKey, cur, hist, histKeys, surrogate, pace, M, steps,
      expS, incS, fe, fi, sdE, catRows, balBefore, balHist, proj, labels, linreg: linreg(expS)
    };
  }

  const charts = {};
  const pal = i => S.chartColors[i % S.chartColors.length];

  function setEmpty(boxId, empty, msg) {
    const box = $(boxId);
    if (!box) return;
    box.classList.toggle('empty', !!empty);
    if (msg) box.dataset.msg = msg;
  }

  function drawChart(id, config) {
    const canvas = $(id);
    if (!canvas) return;
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
    if (typeof Chart === 'undefined') {
      const box = canvas.parentElement;
      box.classList.add('empty');
      box.dataset.msg = 'Chart.js could not be loaded. Check your internet connection and reload.';
      return;
    }
    Chart.defaults.color = S.muted;
    Chart.defaults.borderColor = S.border;
    Chart.defaults.font.family = FONTS[S.font] || FONTS.system;
    charts[id] = new Chart(canvas, config);
  }

  function destroyChart(id) {
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
  }

  function axisOpts(extra) {
    return Object.assign({
      grid: { display: S.showGrid, color: rgba(S.muted, 0.16) },
      ticks: { color: S.muted },
      border: { display: false }
    }, extra || {});
  }

  function lineOpts(yExtra) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: S.chartAnim ? { duration: 600 } : false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: S.showLegend,
          labels: { color: S.muted, usePointStyle: true, boxWidth: 8, filter: i => !String(i.text).startsWith('_') }
        },
        tooltip: {
          filter: i => !String(i.dataset.label).startsWith('_'),
          callbacks: { label: c => ` ${c.dataset.label}: ${money(c.parsed.y)}` }
        }
      },
      scales: {
        x: axisOpts({ grid: { display: false } }),
        y: axisOpts(Object.assign({ ticks: { color: S.muted, callback: v => short(v) } }, yExtra || {}))
      }
    };
  }

  function donutConfig(labels, values, colors) {
    return {
      type: 'doughnut',
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderColor: S.card, borderWidth: 3, hoverOffset: 6 }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: S.cutout + '%',
        animation: S.chartAnim ? { duration: 700 } : false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: c => {
                const total = c.dataset.data.reduce((a, b) => a + b, 0) || 1;
                return ` ${c.label}: ${money(c.parsed)} (${(c.parsed / total * 100).toFixed(1)}%)`;
              }
            }
          }
        }
      }
    };
  }

  const todayNow = new Date();
  let sumY = todayNow.getFullYear(), sumM = todayNow.getMonth();

  function renderSummary() {
    const a = agg(sumY, sumM);
    const now = new Date();
    const isCur = sumY === now.getFullYear() && sumM === now.getMonth();
    const dim = a.daily.length;
    const elapsed = isCur ? now.getDate() : dim;

    $('summaryTitle').textContent = `Monthly Detailed Overview - ${MON[sumM].toUpperCase()} ${sumY}`;

    const keys = txs.map(t => monthKey(new Date(t.ts)));
    const minKey = keys.length ? Math.min(...keys) : sumY * 12 + sumM;
    $('sumPrev').disabled = (sumY * 12 + sumM) <= minKey;
    $('sumNext').disabled = (sumY * 12 + sumM) >= now.getFullYear() * 12 + now.getMonth();

    const setMetric = (id, value, sub, tone) => {
      const v = $(id);
      v.textContent = value;
      v.classList.remove('pos', 'neg');
      if (tone) v.classList.add(tone);
      const s = $(id + '-sub');
      if (s) s.textContent = sub || '';
    };

    const rate = a.income > 0 ? a.net / a.income * 100 : null;
    const topCat = Object.entries(a.byCat).sort((x, y) => y[1] - x[1])[0];

    setMetric('metric-total-inflow', money(a.income), `${Object.keys(a.incSrc).length} source${Object.keys(a.incSrc).length === 1 ? '' : 's'}`, 'pos');
    setMetric('metric-total-expenses', money(a.expenses), `${a.txs.filter(isExpense).length} transactions`, 'neg');
    setMetric('metric-savings-rate', rate === null ? '—' : rate.toFixed(1) + '%', rate === null ? 'No income recorded' : (rate >= 20 ? 'Healthy' : rate >= 0 ? 'Could be better' : 'Overspending'), rate === null ? '' : (rate >= 0 ? 'pos' : 'neg'));
    setMetric('metric-net', signedMoney(a.net), 'Income minus expenses', a.net >= 0 ? 'pos' : 'neg');
    setMetric('metric-daily-avg', money(a.expenses / Math.max(1, elapsed)), `Over ${elapsed} day${elapsed === 1 ? '' : 's'}`);
    setMetric('metric-top-cat', topCat ? topCat[0] : '—', topCat ? `${money(topCat[1])} · ${(topCat[1] / a.expenses * 100).toFixed(0)}%` : 'No expenses yet');

    const bp = $('budget-panel');
    if (S.budget > 0) {
      bp.hidden = false;
      const pct = a.expenses / S.budget * 100;
      const bar = $('budget-bar');
      bar.style.width = Math.min(100, pct) + '%';
      bar.classList.toggle('over', pct > 100);
      bar.classList.toggle('warn', pct > 80 && pct <= 100);
      $('budget-text').textContent = pct > 100
        ? `${money(a.expenses)} of ${money(S.budget)} used · over by ${money(a.expenses - S.budget)}`
        : `${money(a.expenses)} of ${money(S.budget)} used · ${money(S.budget - a.expenses)} left`;
    } else {
      bp.hidden = true;
    }

    const src = $('income-sources-list');
    src.innerHTML = '';
    const srcs = Object.entries(a.incSrc).sort((x, y) => y[1] - x[1]);
    if (!srcs.length) src.appendChild(mk('div', 'empty-note', 'No income recorded this month. Try typing "I got paid Rs. 150000 salary" in the chat.'));
    srcs.forEach(([name, amt], i) => {
      const row = mk('div', 'src-row');
      const head = mk('div', 'src-head');
      head.appendChild(mk('span', 'src-name', name));
      head.appendChild(mk('span', 'src-amt', money(amt)));
      const track = mk('div', 'src-track');
      const fill = mk('div', 'src-fill');
      fill.style.width = (amt / a.income * 100) + '%';
      fill.style.background = pal(i);
      track.appendChild(fill);
      row.appendChild(head);
      row.appendChild(track);
      src.appendChild(row);
    });

    const cats = Object.entries(a.byCat).sort((x, y) => y[1] - x[1]);
    const legend = $('expense-legend');
    legend.innerHTML = '';
    if (!cats.length) {
      setEmpty('expense-pie-box', true, 'No expenses recorded for this month');
      destroyChart('expense-pie-chart');
    } else {
      setEmpty('expense-pie-box', false);
      const colors = cats.map((_, i) => pal(i));
      drawChart('expense-pie-chart', donutConfig(cats.map(c => c[0]), cats.map(c => c[1]), colors));
      cats.forEach(([name, amt], i) => {
        const li = mk('div', 'legend-row');
        const dot = mk('span', 'legend-dot');
        dot.style.background = colors[i];
        li.appendChild(dot);
        li.appendChild(mk('span', 'legend-name', name));
        li.appendChild(mk('span', 'legend-pct', (amt / a.expenses * 100).toFixed(1) + '%'));
        li.appendChild(mk('span', 'legend-amt', money(amt)));
        legend.appendChild(li);
      });
    }

    if (a.expenses <= 0) {
      setEmpty('daily-bar-box', true, 'No daily spending to show');
      destroyChart('daily-bar-chart');
    } else {
      setEmpty('daily-bar-box', false);
      drawChart('daily-bar-chart', {
        type: 'bar',
        data: {
          labels: a.daily.map((_, i) => String(i + 1)),
          datasets: [{ label: 'Spent', data: a.daily, backgroundColor: rgba(S.accent, 0.75), hoverBackgroundColor: S.accent, borderRadius: Math.max(0, S.radius / 5), maxBarThickness: 18 }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: S.chartAnim ? { duration: 600 } : false,
          plugins: { legend: { display: false }, tooltip: { callbacks: { title: c => `${MON[sumM]} ${c[0].label}`, label: c => ` ${money(c.parsed.y)}` } } },
          scales: { x: axisOpts({ grid: { display: false } }), y: axisOpts({ beginAtZero: true, ticks: { color: S.muted, callback: v => short(v) } }) }
        }
      });
    }

    const list = $('month-transactions');
    list.innerHTML = '';
    const sorted = a.txs.slice().sort((x, y) => y.ts - x.ts);
    if (!sorted.length) list.appendChild(mk('div', 'empty-note', 'No transactions in this month.'));
    sorted.slice(0, 20).forEach(t => {
      const row = mk('div', 'tx-row');
      const left = mk('div', 'tx-left');
      left.appendChild(mk('span', 'tx-detail', t.detail));
      left.appendChild(mk('span', 'tx-meta', `${t.date.slice(0, 5)} · ${t.category} · ${t.method}`));
      const amt = mk('span', 'tx-amt ' + (isIncome(t) ? 'pos' : isTransfer(t) ? '' : 'neg'), isIncome(t) ? '+ ' + money(t.amount) : isTransfer(t) ? money(t.amount) : '- ' + money(t.amount));
      row.appendChild(left);
      row.appendChild(amt);
      list.appendChild(row);
    });
    $('tx-count').textContent = sorted.length > 20 ? `Showing latest 20 of ${sorted.length}` : (sorted.length ? `${sorted.length} transaction${sorted.length === 1 ? '' : 's'}` : '');
  }

  const METHOD_LABEL = { trend: 'Linear trend', average: 'Average', weighted: 'Weighted average' };

  function renderAnalysis() {
    const F = computeForecast();
    const note = $('analysisNote');
    $('anMethod').value = S.forecastMethod;
    $('anMonths').value = String(S.forecastMonths);

    const ids = ['fc-pace', 'fc-next-exp', 'fc-next-inc', 'fc-next-net', 'fc-balance', 'fc-avg'];
    if (F.empty) {
      note.textContent = 'There is no data to forecast yet. Add some expenses in the chat, or load sample data from Settings → Data & backup.';
      ids.forEach(id => { $(id).textContent = '—'; $(id + '-sub').textContent = ''; });
      ['cashflow-box', 'balance-box', 'pace-box'].forEach(b => setEmpty(b, true, 'Not enough data yet'));
      ['cashflow-line-chart', 'balance-chart', 'pace-chart'].forEach(destroyChart);
      $('category-forecast').innerHTML = '';
      $('category-forecast').appendChild(mk('div', 'empty-note', 'Nothing to forecast yet.'));
      $('insights').innerHTML = '';
      return;
    }

    const n = F.hist.length;
    note.textContent = F.surrogate
      ? 'No completed months yet, so this forecast uses your current spending pace. It will sharpen as more months of data come in.'
      : `Forecast: ${METHOD_LABEL[S.forecastMethod]} · based on ${n} completed month${n === 1 ? '' : 's'}` +
        (S.forecastMethod === 'trend' && n < 3 ? ' (needs 3+ months for a trend, so the average is used)' : '') +
        (S.growth ? ` · ${S.growth > 0 ? '+' : ''}${S.growth}% monthly growth applied` : '') + '.';

    const nextLabel = keyLabel(F.curKey + 1);
    const avgE = mean(F.expS);
    const nextExp = F.fe[1], nextInc = F.fi[1], nextNet = nextInc - nextExp;
    const setCard = (id, value, sub, tone) => {
      const v = $(id);
      v.textContent = value;
      v.classList.remove('pos', 'neg');
      if (tone) v.classList.add(tone);
      $(id + '-sub').textContent = sub;
    };

    const vsBudget = S.budget > 0 ? (F.pace > S.budget ? ` · ${money(F.pace - S.budget)} over budget` : ` · within budget`) : '';
    setCard('fc-pace', money(F.pace), `This month at current pace · ${money(F.cur.expenses)} so far${vsBudget}`, S.budget > 0 && F.pace > S.budget ? 'neg' : '');
    const chg = avgE > 0 ? (nextExp - avgE) / avgE * 100 : 0;
    setCard('fc-next-exp', money(nextExp), `${nextLabel} · ${chg >= 0 ? '▲' : '▼'} ${Math.abs(chg).toFixed(1)}% vs average`, 'neg');
    setCard('fc-next-inc', money(nextInc), `${nextLabel} expected income`, 'pos');
    const nrate = nextInc > 0 ? nextNet / nextInc * 100 : null;
    setCard('fc-next-net', signedMoney(nextNet), `${nextLabel} · savings rate ${nrate === null ? '—' : nrate.toFixed(1) + '%'}`, nextNet >= 0 ? 'pos' : 'neg');
    setCard('fc-balance', money(F.proj[F.steps]), `By ${keyLabel(F.curKey + F.M)} (net savings)`, F.proj[F.steps] >= F.balBefore ? 'pos' : 'neg');
    setCard('fc-avg', money(avgE), `Average over ${F.expS.length} month${F.expS.length === 1 ? '' : 's'}`);

    const L = F.labels.length;
    const blank = () => new Array(L).fill(null);
    const expA = blank(), incA = blank(), expF = blank(), incF = blank(), soFar = blank(), lo = blank(), hi = blank();
    F.hist.forEach((h, i) => { expA[i] = h.expenses; incA[i] = h.income; });
    const startIdx = n;
    if (n > 0) { expF[n - 1] = F.hist[n - 1].expenses; incF[n - 1] = F.hist[n - 1].income; }
    for (let k = 0; k <= F.M; k++) {
      expF[startIdx + k] = F.fe[k];
      incF[startIdx + k] = F.fi[k];
      const spread = F.sdE * (0.8 + 0.12 * (k + 1));
      lo[startIdx + k] = Math.max(0, F.fe[k] - spread);
      hi[startIdx + k] = F.fe[k] + spread;
    }
    soFar[startIdx] = F.cur.expenses;

    const dsBase = { tension: S.tension, borderWidth: S.lineWidth, pointRadius: S.pointRadius, pointHoverRadius: S.pointRadius + 2 };
    const datasets = [];
    if (S.band) {
      datasets.push({ label: '_low', data: lo, borderWidth: 0, pointRadius: 0, backgroundColor: 'transparent', fill: false });
      datasets.push({ label: '_high', data: hi, borderWidth: 0, pointRadius: 0, backgroundColor: rgba(S.negative, 0.14), fill: '-1', tension: S.tension });
    }
    datasets.push(
      Object.assign({ label: 'Expenses', data: expA, borderColor: S.negative, backgroundColor: S.negative, pointBackgroundColor: S.negative }, dsBase),
      Object.assign({ label: 'Expenses (forecast)', data: expF, borderColor: S.negative, borderDash: [7, 5], backgroundColor: S.card, pointBackgroundColor: S.card, pointBorderColor: S.negative, pointBorderWidth: 2 }, dsBase),
      Object.assign({ label: 'Income', data: incA, borderColor: S.accent, backgroundColor: S.accent, pointBackgroundColor: S.accent }, dsBase),
      Object.assign({ label: 'Income (forecast)', data: incF, borderColor: S.accent, borderDash: [7, 5], backgroundColor: S.card, pointBackgroundColor: S.card, pointBorderColor: S.accent, pointBorderWidth: 2 }, dsBase),
      { label: 'Spent so far this month', data: soFar, showLine: false, pointStyle: 'rectRot', pointRadius: 7, pointHoverRadius: 9, backgroundColor: S.secondary, borderColor: S.secondary }
    );
    setEmpty('cashflow-box', false);
    drawChart('cashflow-line-chart', { type: 'line', data: { labels: F.labels, datasets }, options: lineOpts({ beginAtZero: true }) });

    const balA = blank(), balF = blank(), balNow = blank();
    F.balHist.forEach((v, i) => { balA[i] = v; });
    balF[n > 0 ? n - 1 : n] = F.proj[0];
    if (n === 0) balF[0] = F.proj[0];
    for (let k = 1; k <= F.steps; k++) balF[n + k - 1] = F.proj[k];
    balNow[n] = F.proj[0] + F.cur.net;
    setEmpty('balance-box', false);
    drawChart('balance-chart', {
      type: 'line',
      data: {
        labels: F.labels,
        datasets: [
          Object.assign({ label: 'Net savings', data: balA, borderColor: S.accent, backgroundColor: rgba(S.accent, 0.14), fill: true, pointBackgroundColor: S.accent }, dsBase),
          Object.assign({ label: 'Net savings (forecast)', data: balF, borderColor: S.secondary, borderDash: [7, 5], backgroundColor: S.card, pointBackgroundColor: S.card, pointBorderColor: S.secondary, pointBorderWidth: 2 }, dsBase),
          { label: 'Now (incl. this month so far)', data: balNow, showLine: false, pointStyle: 'rectRot', pointRadius: 7, pointHoverRadius: 9, backgroundColor: S.accent, borderColor: S.accent }
        ]
      },
      options: lineOpts({ beginAtZero: false })
    });

    const days = Array.from({ length: F.dim }, (_, i) => String(i + 1));
    const actual = new Array(F.dim).fill(null), paceLine = new Array(F.dim).fill(null), typical = new Array(F.dim).fill(null);
    let cum = 0;
    for (let d = 0; d < F.dom; d++) { cum += F.cur.daily[d] || 0; actual[d] = cum; }
    const rate = F.cur.expenses / F.dom;
    for (let d = F.dom - 1; d < F.dim; d++) paceLine[d] = F.cur.expenses + rate * (d - (F.dom - 1));
    for (let d = 0; d < F.dim; d++) typical[d] = F.fe[0] * (d + 1) / F.dim;
    const paceSets = [
      Object.assign({ label: 'Spent so far', data: actual, borderColor: S.negative, backgroundColor: rgba(S.negative, 0.14), fill: true }, dsBase, { pointRadius: 0, pointHoverRadius: 4 }),
      Object.assign({ label: 'Current pace', data: paceLine, borderColor: S.negative, borderDash: [7, 5] }, dsBase, { pointRadius: 0, pointHoverRadius: 4 }),
      Object.assign({ label: 'Typical month (forecast)', data: typical, borderColor: S.secondary, borderDash: [2, 4] }, dsBase, { pointRadius: 0, pointHoverRadius: 4 })
    ];
    if (S.budget > 0) paceSets.push(Object.assign({ label: 'Budget', data: new Array(F.dim).fill(S.budget), borderColor: pal(2) }, dsBase, { borderDash: [10, 4], pointRadius: 0, borderWidth: 2 }));
    setEmpty('pace-box', false);
    const paceOpts = lineOpts({ beginAtZero: true });
    paceOpts.plugins.tooltip.callbacks.title = c => `${MON[F.now.getMonth()]} ${c[0].label}`;
    drawChart('pace-chart', { type: 'line', data: { labels: days, datasets: paceSets }, options: paceOpts });

    const cf = $('category-forecast');
    cf.innerHTML = '';
    if (!F.catRows.length) cf.appendChild(mk('div', 'empty-note', 'No category data yet.'));
    else {
      const table = mk('table', 'result-table cat-table');
      const head = mk('tr');
      ['Category', 'Monthly avg', `Next month (${nextLabel})`, 'Change'].forEach(h => head.appendChild(mk('th', '', h)));
      const thead = mk('thead'); thead.appendChild(head); table.appendChild(thead);
      const tb = mk('tbody');
      F.catRows.slice(0, 8).forEach((r, i) => {
        const tr = mk('tr');
        const c0 = mk('td'); const dot = mk('span', 'legend-dot'); dot.style.background = pal(i);
        c0.appendChild(dot); c0.appendChild(document.createTextNode(' ' + r.cat));
        tr.appendChild(c0);
        tr.appendChild(mk('td', '', money(r.avg)));
        tr.appendChild(mk('td', '', money(r.next)));
        const d = r.avg > 0 ? (r.next - r.avg) / r.avg * 100 : 0;
        tr.appendChild(mk('td', d > 0.5 ? 'neg' : d < -0.5 ? 'pos' : '', Math.abs(d) < 0.05 ? '—' : `${d > 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)}%`));
        tb.appendChild(tr);
      });
      table.appendChild(tb);
      const wrap = mk('div', 'table-scroll');
      wrap.appendChild(table);
      cf.appendChild(wrap);
    }

    const ins = [];
    ins.push(`At your current pace you will spend about ${money(F.pace)} in ${MON[F.now.getMonth()]}` +
      (S.budget > 0 ? (F.pace > S.budget ? `, which is ${money(F.pace - S.budget)} over your ${money(S.budget)} budget.` : `, which is ${money(S.budget - F.pace)} under your ${money(S.budget)} budget.`) : '.'));
    ins.push(`${nextLabel} is forecast at ${money(nextExp)} of spending, ${chg >= 0 ? 'up' : 'down'} ${Math.abs(chg).toFixed(1)}% compared with your ${n || 1}-month average.`);
    if (n >= 3 && Math.abs(F.linreg.slope) > 1) ins.push(`Your monthly spending is ${F.linreg.slope > 0 ? 'rising' : 'falling'} by roughly ${money(Math.abs(F.linreg.slope))} per month.`);
    const topNow = Object.entries(F.cur.byCat).sort((x, y) => y[1] - x[1])[0];
    if (topNow && F.cur.expenses > 0) ins.push(`${topNow[0]} is your biggest expense this month at ${(topNow[1] / F.cur.expenses * 100).toFixed(0)}% of spending (${money(topNow[1])}).`);
    const sumNet = F.proj[F.steps] - F.proj[1 - 1];
    ins.push(`If this continues, your net savings would ${sumNet >= 0 ? 'grow' : 'shrink'} by ${money(Math.abs(sumNet))} over ${F.steps} months, reaching ${money(F.proj[F.steps])} by ${keyLabel(F.curKey + F.M)}.`);
    const ul = $('insights');
    ul.innerHTML = '';
    ins.forEach(t => ul.appendChild(mk('li', '', t)));
  }

  function renderHistory() {
    const list = document.querySelector('.history-list');
    if (!list) return;
    list.innerHTML = '';
    const now = new Date();
    const dayTotals = new Map();
    txs.forEach(t => {
      if (isTransfer(t)) return;
      dayTotals.set(t.ts, (dayTotals.get(t.ts) || 0) + (isIncome(t) ? t.amount : -t.amount));
    });
    for (let i = 0; i < S.historyDays; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const v = dayTotals.get(d.getTime()) || 0;
      const item = mk('div', 'history-item ' + (v > 0.004 ? 'positive' : v < -0.004 ? 'negative' : 'neutral'));
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      item.title = "Open this day's chat";
      if (sameDay(d, activeDay || now)) item.classList.add('selected');
      item.appendChild(mk('span', 'date', i === 0 ? 'Today' : i === 1 ? 'Yesterday' : `${DOW[d.getDay()]} ${d.getDate()}`));
      item.appendChild(mk('span', 'amount', Math.abs(v) < 0.004 ? '–' : (v > 0 ? '+' : '−') + short(Math.abs(v))));
      const go = () => { if (handlers.dayClick) handlers.dayClick(d); };
      item.addEventListener('click', go);
      item.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      list.appendChild(item);
    }
    document.dispatchEvent(new Event('dc:change'));
  }

  function applyTheme() {
    const r = document.documentElement.style;
    const set = (k, v) => r.setProperty(k, v);
    set('--bg-dark', S.bg); set('--panel-bg', S.panel); set('--card-bg', S.card); set('--border-color', S.border);
    set('--text-main', S.text); set('--text-muted', S.muted);
    set('--accent-green', S.accent); set('--accent-red', S.negative); set('--accent-blue', S.secondary);
    set('--accent-rgb', rgbStr(S.accent)); set('--red-rgb', rgbStr(S.negative)); set('--blue-rgb', rgbStr(S.secondary));
    set('--on-accent', onColor(S.accent));
    set('--card-hover', `color-mix(in srgb, ${S.card} 88%, ${S.text} 12%)`);
    set('--border-active', `color-mix(in srgb, ${S.border} 55%, ${S.accent} 45%)`);
    const s = S.glowIntensity / 100;
    set('--glow-green', rgba(S.accent, 0.08 + 0.16 * s));
    set('--page-glow-1', rgba(S.glow1, 0.20 * s));
    set('--page-glow-2', rgba(S.glow2, 0.18 * s));
    set('--grad-start', S.gradStart); set('--grad-end', S.gradEnd); set('--grad-angle', S.gradAngle + 'deg');
    set('--bubble-start', S.bubbleStart); set('--bubble-end', S.bubbleEnd); set('--on-bubble', onColor(S.bubbleStart));
    set('--radius', S.radius + 'px'); set('--sidebar-w', S.sidebarWidth + 'px');
    set('--font', FONTS[S.font] || FONTS.system);
    set('--wm-opacity', S.watermarkOpacity / 100);
    r.fontSize = (16 * S.fontScale / 100) + 'px';
    r.colorScheme = luminance(S.bg) > 0.5 ? 'light' : 'dark';

    const b = document.body.classList;
    b.toggle('no-title-gradient', !S.titleGradient);
    b.toggle('flat-cards', !S.cardGradient);
    b.toggle('flat-sidebar', !S.sidebarGradient);
    b.toggle('compact', !!S.compact);
    b.toggle('no-anim', !S.animations);
  }

  function applyBranding() {
    const setText = (id, v) => { const n = $(id); if (n) n.textContent = v; };
    setText('brandName', S.appName);
    setText('heroTitle', S.heroTitle);
    setText('heroTagline', S.tagline);
    const photo = typeof S.avatar === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,/.test(S.avatar) ? S.avatar : '';
    document.querySelectorAll('[data-avatar]').forEach(el => {
      el.classList.toggle('has-photo', !!photo);
      el.style.backgroundImage = photo ? 'url("' + photo + '")' : '';
      el.textContent = photo ? '' : (S.initials || '').slice(0, 3);
    });
    const wm = $('watermark');
    if (wm) wm.style.display = S.watermark ? '' : 'none';
    const inp = $('chatInput');
    if (inp) inp.placeholder = S.placeholder;
    document.title = S.appName;
  }

  const SCHEMA = [
    { title: 'Finance', controls: [
      ['currency', 'Currency symbol', 'text', { max: 6 }],
      ['decimals', 'Decimal places', 'select', { num: true, options: [['0', '0'], ['1', '1'], ['2', '2']] }],
      ['openingCash', 'Opening cash balance', 'number', { step: 100 }],
      ['openingBank', 'Opening bank balance', 'number', { step: 100 }],
      ['budget', 'Monthly budget (0 = off)', 'number', { step: 500, min: 0 }],
      ['countSavings', 'Count savings & investments as expenses', 'toggle']
    ] },
    { title: 'Profile', type: 'profile', controls: [['initials', 'Initials (shown when no photo)', 'text', { max: 3 }]] },
    { title: 'Theme presets', type: 'presets' },
    { title: 'Colors', controls: [
      ['bg', 'Background', 'color'], ['panel', 'Panels', 'color'], ['card', 'Cards', 'color'], ['border', 'Borders', 'color'],
      ['text', 'Main text', 'color'], ['muted', 'Muted text', 'color'],
      ['accent', 'Accent / income', 'color'], ['negative', 'Negative / expenses', 'color'], ['secondary', 'Secondary accent', 'color']
    ] },
    { title: 'Gradients & glow', controls: [
      ['titleGradient', 'Gradient headings', 'toggle'],
      ['gradStart', 'Heading gradient: start', 'color'], ['gradEnd', 'Heading gradient: end', 'color'],
      ['gradAngle', 'Heading gradient angle', 'range', { min: 0, max: 360, step: 5, unit: '°' }],
      ['bubbleStart', 'Your message bubble: start', 'color'], ['bubbleEnd', 'Your message bubble: end', 'color'],
      ['cardGradient', 'Gradient cards', 'toggle'],
      ['glow1', 'Page glow color 1', 'color'], ['glow2', 'Page glow color 2', 'color'],
      ['glowIntensity', 'Glow strength', 'range', { min: 0, max: 100, step: 1, unit: '%' }]
    ] },
    { title: 'Typography & shape', controls: [
      ['font', 'Font', 'select', { options: [['system', 'System'], ['rounded', 'Rounded'], ['humanist', 'Humanist'], ['serif', 'Serif'], ['mono', 'Monospace']] }],
      ['fontScale', 'Text size', 'range', { min: 80, max: 130, step: 1, unit: '%' }],
      ['radius', 'Corner roundness', 'range', { min: 0, max: 32, step: 1, unit: 'px' }],
      ['compact', 'Compact spacing', 'toggle'],
      ['animations', 'Animations & transitions', 'toggle']
    ] },
    { title: 'Charts', type: 'charts', controls: [
      ['lineWidth', 'Line thickness', 'range', { min: 1, max: 6, step: 0.5, unit: 'px' }],
      ['tension', 'Line smoothness', 'range', { min: 0, max: 0.6, step: 0.05, unit: '' }],
      ['pointRadius', 'Point size', 'range', { min: 0, max: 8, step: 1, unit: 'px' }],
      ['cutout', 'Donut hole size', 'range', { min: 30, max: 90, step: 1, unit: '%' }],
      ['showGrid', 'Show grid lines', 'toggle'], ['showLegend', 'Show legends', 'toggle'], ['chartAnim', 'Animate charts', 'toggle']
    ] },
    { title: 'Forecast', controls: [
      ['forecastMethod', 'Method', 'select', { options: [['trend', 'Linear trend'], ['average', 'Average'], ['weighted', 'Weighted average (recent months count more)']] }],
      ['forecastMonths', 'Months ahead', 'range', { min: 1, max: 12, step: 1, unit: '' }],
      ['historyMonths', 'History used', 'range', { min: 2, max: 12, step: 1, unit: ' mo' }],
      ['growth', 'Expected monthly growth', 'range', { min: -10, max: 20, step: 0.5, unit: '%' }],
      ['band', 'Show forecast range band', 'toggle']
    ] },
    { title: 'Home cards', controls: [
      ['cShowBal', 'Card: Balance', 'toggle'],
      ['cRowCashBank', '   Cash / bank split', 'toggle'],
      ['cRowIncome', '   Income this month', 'toggle'],
      ['cShowMonth', 'Card: This month', 'toggle'],
      ['cRowNet', '   Net', 'toggle'],
      ['cRowAvg', '   Daily average', 'toggle'],
      ['cRowBudget', '   Budget bar', 'toggle'],
      ['cShowCats', 'Card: Where it went', 'toggle'],
      ['cCatCount', '   Categories shown', 'range', { min: 2, max: 8, step: 1, unit: '' }],
      ['cShowToday', 'Card: Today', 'toggle'],
      ['cRowEntries', '   Entries today', 'toggle'],
      ['cRowPace', '   Month-end pace', 'toggle'],
      ['cRowSafe', '   Safe to spend per day', 'toggle'],
      ['cExpand', 'Tap a card to see more details', 'toggle'],
      ['cRecent', 'Latest entries in the Balance card', 'range', { min: 0, max: 10, step: 1, unit: '' }]
    ] },
    { title: 'Branding & layout', controls: [
      ['appName', 'App name', 'text', { max: 24 }],
      ['heroTitle', 'Home title', 'text', { max: 60 }],
      ['tagline', 'Home tagline', 'text', { max: 100 }],
      ['placeholder', 'Input placeholder', 'text', { max: 60 }],
      ['watermark', 'Show logo watermark', 'toggle'],
      ['watermarkOpacity', 'Watermark strength', 'range', { min: 0, max: 30, step: 1, unit: '%' }],
      ['historyDays', 'Days shown in the day strip', 'range', { min: 5, max: 30, step: 1, unit: '' }]
    ] },
    { title: 'Data & backup', type: 'data' }
  ];

  const controlRefs = [];
  let rafPending = 0;

  function commit() {
    lsSet(LS_SETTINGS, S);
    applyTheme();
    applyBranding();
    if (!rafPending) rafPending = requestAnimationFrame(() => { rafPending = 0; refresh(); });
  }

  function syncControls() {
    controlRefs.forEach(fn => fn());
  }

  function addControl(parent, def) {
    const [key, label, type, opts] = def;
    const o = opts || {};
    const row = mk('div', 'set-row');
    row.appendChild(mk('span', 'set-label', label));
    const right = mk('div', 'set-ctl');
    let input, sync;

    if (type === 'color') {
      input = mk('input'); input.type = 'color';
      const hex = mk('code', 'set-hex');
      input.addEventListener('input', () => { S[key] = input.value; hex.textContent = input.value; commit(); });
      sync = () => { input.value = S[key]; hex.textContent = S[key]; };
      right.appendChild(hex);
    } else if (type === 'range') {
      input = mk('input'); input.type = 'range';
      input.min = o.min; input.max = o.max; input.step = o.step || 1;
      const out = mk('output', 'set-out');
      input.addEventListener('input', () => { S[key] = parseFloat(input.value); out.textContent = S[key] + (o.unit || ''); commit(); });
      sync = () => { input.value = S[key]; out.textContent = S[key] + (o.unit || ''); };
      right.appendChild(out);
    } else if (type === 'toggle') {
      const sw = mk('label', 'switch');
      input = mk('input'); input.type = 'checkbox';
      input.addEventListener('change', () => { S[key] = input.checked; commit(); });
      sync = () => { input.checked = !!S[key]; };
      sw.appendChild(input);
      sw.appendChild(mk('span', 'knob'));
      right.appendChild(sw);
      controlRefs.push(sync);
      row.appendChild(right);
      parent.appendChild(row);
      return;
    } else if (type === 'select') {
      input = mk('select');
      o.options.forEach(([v, l]) => { const op = mk('option', '', l); op.value = v; input.appendChild(op); });
      input.addEventListener('change', () => { S[key] = o.num ? parseFloat(input.value) : input.value; commit(); });
      sync = () => { input.value = String(S[key]); };
    } else if (type === 'number') {
      input = mk('input'); input.type = 'number';
      if (o.step) input.step = o.step;
      if (o.min !== undefined) input.min = o.min;
      input.addEventListener('input', () => { S[key] = parseFloat(input.value) || 0; commit(); });
      sync = () => { input.value = S[key]; };
    } else {
      input = mk('input'); input.type = 'text';
      if (o.max) input.maxLength = o.max;
      input.addEventListener('input', () => { S[key] = input.value; commit(); });
      sync = () => { input.value = S[key]; };
    }
    right.appendChild(input);
    row.appendChild(right);
    parent.appendChild(row);
    controlRefs.push(sync);
  }

  function renderPresets(body) {
    const grid = mk('div', 'preset-grid');
    PRESETS.forEach(p => {
      const b = mk('button', 'preset-btn');
      b.type = 'button';
      const sw = mk('span', 'preset-swatch');
      sw.style.background = `linear-gradient(135deg, ${p.v.bg} 0 38%, ${p.v.accent} 38% 70%, ${p.v.secondary} 70% 100%)`;
      b.appendChild(sw);
      b.appendChild(mk('span', '', p.name));
      b.addEventListener('click', () => {
        Object.keys(p.v).forEach(k => { S[k] = Array.isArray(p.v[k]) ? p.v[k].slice() : p.v[k]; });
        syncControls();
        commit();
      });
      grid.appendChild(b);
    });
    body.appendChild(grid);
  }

  function renderChartColors(body) {
    const row = mk('div', 'palette-row');
    PALETTES_NAMES().forEach(name => {
      const b = mk('button', 'preset-btn small');
      b.type = 'button';
      const sw = mk('span', 'palette-strip');
      PALETTES[name].slice(0, 5).forEach(c => { const i = mk('i'); i.style.background = c; sw.appendChild(i); });
      b.appendChild(sw);
      b.appendChild(mk('span', '', name));
      b.addEventListener('click', () => { S.chartColors = PALETTES[name].slice(); syncControls(); commit(); });
      row.appendChild(b);
    });
    body.appendChild(mk('div', 'set-sub', 'Chart palette'));
    body.appendChild(row);

    const grid = mk('div', 'chart-color-grid');
    for (let i = 0; i < 8; i++) {
      const input = mk('input'); input.type = 'color'; input.title = 'Chart color ' + (i + 1);
      input.addEventListener('input', () => { S.chartColors[i] = input.value; commit(); });
      controlRefs.push(() => { input.value = S.chartColors[i]; });
      grid.appendChild(input);
    }
    body.appendChild(grid);
  }
  const PALETTES_NAMES = () => Object.keys(PALETTES);

  let statsEl = null;
  function updateDataStats() {
    if (!statsEl) return;
    const samples = txs.filter(t => t.sample).length;
    statsEl.textContent = `${txs.length} transaction${txs.length === 1 ? '' : 's'} stored on this device` + (samples ? ` (${samples} sample)` : '') + '.';
  }

  function renderDataSection(body) {
    statsEl = mk('p', 'set-sub');
    body.appendChild(statsEl);
    const grid = mk('div', 'btn-grid');
    const btn = (text, cls, fn) => { const b = mk('button', 'set-btn ' + (cls || ''), text); b.type = 'button'; b.addEventListener('click', fn); grid.appendChild(b); return b; };

    btn('Load sample data', '', () => { Store.loadSample(); afterDataChange(); });
    btn('Remove sample data', '', () => { Store.removeSample(); afterDataChange(); });
    btn('Clear ALL data', 'danger', () => { if (confirm('Delete every stored transaction? This cannot be undone.')) { Store.clear(); afterDataChange(); } });
    btn('Export backup', '', () => {
      const blob = new Blob([JSON.stringify({ version: 1, settings: S, transactions: txs }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (DEFAULTS.appName || 'backup').toLowerCase().replace(/\s+/g, '-') + '-backup.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1500);
    });
    const file = mk('input'); file.type = 'file'; file.accept = 'application/json,.json'; file.hidden = true;
    file.addEventListener('change', () => {
      const f = file.files && file.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          if (data.settings) {
            S = Object.assign({}, DEFAULTS, data.settings);
            if (!Array.isArray(S.chartColors) || S.chartColors.length !== 8) S.chartColors = DEFAULTS.chartColors.slice();
            migrateOpening();
          }
          if (Array.isArray(data.transactions)) txs = data.transactions.filter(t => t && typeof t.amount === 'number' && t.date);
          Store.save();
          syncControls();
          commit();
          afterDataChange();
          alert('Backup imported.');
        } catch (e) {
          alert('That file is not a valid backup.');
        }
        file.value = '';
      };
      reader.readAsText(f);
    });
    btn('Import backup', '', () => file.click());
    btn('Reset all settings', 'danger', () => {
      if (!confirm('Reset every setting to the defaults? Your transactions are kept.')) return;
      S = Object.assign({}, DEFAULTS);
      S.chartColors = DEFAULTS.chartColors.slice();
      syncControls();
      commit();
    });
    body.appendChild(grid);
    body.appendChild(file);
    updateDataStats();
  }

  /* Profile picture: pick an image, centre-crop to a small square, store it with the account's settings. */
  function fileToAvatar(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const size = 192, c = document.createElement('canvas');
          c.width = c.height = size;
          const ctx = c.getContext('2d');
          const side = Math.min(img.naturalWidth, img.naturalHeight);
          const sx = (img.naturalWidth - side) / 2, sy = (img.naturalHeight - side) / 2;
          const keepAlpha = /png|webp|gif|svg/.test(file.type);
          if (!keepAlpha) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, size, size); }
          ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
          resolve(c.toDataURL(keepAlpha ? 'image/png' : 'image/jpeg', 0.88));
        } catch (e) { reject(e); }
        URL.revokeObjectURL(url);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
      img.src = url;
    });
  }

  function renderProfile(body) {
    const row = mk('div', 'profile-row');
    const prev = mk('div', 'avatar-fallback lg', 'DC');
    prev.setAttribute('data-avatar', '');
    prev.setAttribute('aria-hidden', 'true');
    row.appendChild(prev);
    const grid = mk('div', 'btn-grid');
    const file = mk('input'); file.type = 'file'; file.accept = 'image/*'; file.hidden = true;
    const up = mk('button', 'set-btn', 'Upload photo'); up.type = 'button';
    const rm = mk('button', 'set-btn', 'Remove photo'); rm.type = 'button';
    up.addEventListener('click', () => file.click());
    rm.addEventListener('click', () => { S.avatar = ''; commit(); });
    file.addEventListener('change', async () => {
      const f = file.files && file.files[0];
      file.value = '';
      if (!f) return;
      if (!/^image\//.test(f.type)) { alert('Please choose an image file.'); return; }
      if (f.size > 10 * 1024 * 1024) { alert('That image is too large (10 MB max).'); return; }
      try { S.avatar = await fileToAvatar(f); commit(); }
      catch (e) { alert('Could not read that image. Try a PNG or JPG.'); }
    });
    grid.appendChild(up); grid.appendChild(rm);
    row.appendChild(grid);
    body.appendChild(row);
    body.appendChild(file);
  }

  function renderSettings() {
    const root = $('settingsRoot');
    root.innerHTML = '';
    SCHEMA.forEach((sec, idx) => {
      const det = mk('details', 'set-section');
      if (idx === 0) det.open = true;
      det.appendChild(mk('summary', '', sec.title));
      const body = mk('div', 'set-body');
      if (sec.type === 'profile') renderProfile(body);
      if (sec.type === 'presets') renderPresets(body);
      if (sec.type === 'charts') {
        const prev = mk('div', 'preview-row');
        const a = mk('div', 'chart-box mini'); a.id = 'previewLineBox'; a.appendChild(mk('canvas')); a.firstChild.id = 'previewLine';
        const b = mk('div', 'chart-box mini'); b.id = 'previewDonutBox'; b.appendChild(mk('canvas')); b.firstChild.id = 'previewDonut';
        prev.appendChild(a); prev.appendChild(b);
        body.appendChild(prev);
        renderChartColors(body);
      }
      (sec.controls || []).forEach(def => addControl(body, def));
      if (sec.type === 'data') renderDataSection(body);
      det.appendChild(body);
      root.appendChild(det);
    });
    syncControls();
  }

  function renderPreview() {
    if (!$('previewLine')) return;
    const labels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
    const dsBase = { tension: S.tension, borderWidth: S.lineWidth, pointRadius: S.pointRadius };
    drawChart('previewLine', {
      type: 'line',
      data: {
        labels,
        datasets: [
          Object.assign({ label: 'Income', data: [60, 64, 62, 70, 74, 78], borderColor: S.accent, backgroundColor: S.accent }, dsBase),
          Object.assign({ label: 'Expenses', data: [42, 48, 45, 52, 50, 56], borderColor: S.negative, backgroundColor: S.negative }, dsBase),
          Object.assign({ label: 'Forecast', data: [null, null, null, null, 50, 58], borderColor: S.secondary, borderDash: [6, 4], backgroundColor: S.secondary }, dsBase)
        ]
      },
      options: Object.assign(lineOpts({ beginAtZero: true }), { plugins: { legend: { display: S.showLegend, labels: { color: S.muted, usePointStyle: true, boxWidth: 8 } }, tooltip: { enabled: false } } })
    });
    drawChart('previewDonut', donutConfig(['Food', 'Bills', 'Travel', 'Fun'], [38, 30, 20, 12], [0, 1, 2, 3].map(pal)));
  }

  function afterDataChange() {
    updateDataStats();
    renderHistory();
    refresh();
  }

  function activeViewId() {
    const a = document.querySelector('.view-panel.active');
    return a ? a.id : '';
  }

  function onTabShown(name) {
    if (name === 'summary') renderSummary();
    else if (name === 'analysis') renderAnalysis();
    else if (name === 'settings') { renderPreview(); updateDataStats(); }
  }

  function refresh() {
    renderHistory();
    const id = activeViewId();
    if (id === 'summary-view') renderSummary();
    else if (id === 'analysis-view') renderAnalysis();
    else if (id === 'settings-view') renderPreview();
  }

  function incomeLabel(t) {
    if (/\bsalary|wages?\b|got paid|\bpaid me\b/i.test(t)) return 'Salary';
    if (/refund/i.test(t)) return 'Refund';
    if (/\bgift|gifted\b/i.test(t)) return 'Gift';
    if (/allowance|pocket money/i.test(t)) return 'Allowance';
    if (/\bsold\b/i.test(t)) return 'Sale';
    if (/\bwon\b/i.test(t)) return 'Winnings';
    if (/freelance|client|project/i.test(t)) return 'Freelance';
    if (/\b(?:dad|father|mom|mum|mother|parents?|brother|sister|friend|uncle|aunt|grand\w+)\b/i.test(t)) return 'Family & Friends';
    return 'Other Income';
  }

  function looseAmount(str) {
    const m = String(str).match(/(?:^|[^\w.])(\d[\d,]*(?:\.\d+)?)\s*([km])?\b/i);
    if (!m) return null;
    const v = parseFloat(m[1].replace(/,/g, '')) * (m[2] ? (m[2].toLowerCase() === 'k' ? 1e3 : 1e6) : 1);
    return v > 0 ? { value: v } : null;
  }

  const INCOME_SPLIT = /\s*(?:,|;|\band\b|\bthen\b|\balso\b)\s+(?=(?:i\s+)?(?:got|get|received|receive|earned|sold|won|was\s+paid|gifted)\b)/i;

  function extractIncomeRows(text) {
    const rows = [];
    try {
      const clean = normalizeTextInput(text);
      let carriedDate = null;
      clean.split(/(?<=[.!?])\s+|\n+|;\s*/).map(s => s.trim()).filter(Boolean).forEach(sentence => {
        const sd = sentence.match(DATE_RE);
        splitClauses(sentence).parts.forEach(part => {
          if (/\?\s*$/.test(part)) return;
          part.split(INCOME_SPLIT).forEach(piece => {
            const c = piece.replace(/[.!]+$/, '').trim();
            if (!c) return;
            const own = c.match(DATE_RE);
            const ds = own ? own[0] : (sd ? sd[0] : null);
            if (ds) carriedDate = ds;

            const noDate = stripDates(c);
            if (NEGATED.test(noDate) || FUTURE.test(noDate)) return;
            if (isCashIn(noDate) || BANK_DEPOSIT_RE.test(noDate) || TRANSFER_RE.test(noDate)) return;
            if (!INCOME_RE.test(noDate)) return;
            const amt = findAmount(noDate) || looseAmount(noDate);
            if (!amt) return;
            if (ds && isFutureDate(ds, false)) return;

            const label = incomeLabel(noDate);
            const method = (CARD_RE.test(c) && !CASH_RE.test(c)) || (label === 'Salary' && !CASH_RE.test(c)) ? NON_CASH_METHOD : 'Cash';
            rows.push([carriedDate ? getFormattedDate(carriedDate) : defaultDateStr(), formatAmount(amt.value), label, 'Income', method]);
          });
        });
      });
    } catch (err) {
      console.warn('Income detection failed:', err);
    }
    return rows;
  }

  function init() {
    const anMonths = $('anMonths');
    for (let i = 1; i <= 12; i++) { const o = mk('option', '', i + (i === 1 ? ' month' : ' months')); o.value = String(i); anMonths.appendChild(o); }
    $('anMethod').addEventListener('change', e => { S.forecastMethod = e.target.value; syncControls(); commit(); });
    anMonths.addEventListener('change', e => { S.forecastMonths = parseInt(e.target.value, 10) || 6; syncControls(); commit(); });

    $('sumPrev').addEventListener('click', () => { sumM--; if (sumM < 0) { sumM = 11; sumY--; } renderSummary(); });
    $('sumNext').addEventListener('click', () => { sumM++; if (sumM > 11) { sumM = 0; sumY++; } renderSummary(); });

    applyTheme();
    applyBranding();
    renderSettings();
    renderHistory();
  }

  init();

  return {
    Store, handlers, onTabShown, refresh, renderHistory, extractIncomeRows, computeForecast,
    getSettings: () => S,
    renderSummary, renderAnalysis, money, agg
  };
})();

/* ═════════════════════════════════════════════════════════════════════
   APP UI  (sidebar, tabs, chat, editable result table)
   ═════════════════════════════════════════════════════════════════════ */

/* ───────────────────────── Tab switching ───────────────────────── */

const navButtons = document.querySelectorAll('.bottom-nav .nav-btn');
const viewPanels = document.querySelectorAll('.view-panel');

function switchTab(targetTab) {
  navButtons.forEach(b => b.classList.toggle('active', b.getAttribute('data-tab') === targetTab));
  viewPanels.forEach(p => p.classList.remove('active'));
  document.getElementById(`${targetTab}-view`).classList.add('active');

  scrollContainer.scrollTop = 0;
  DC.onTabShown(targetTab);
}

navButtons.forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab')));
});

/* ───────────────────────── Chat elements ───────────────────────── */

const homeView = document.getElementById('home-view');
const scrollContainer = document.querySelector('.scroll-container');
const chatLog = document.getElementById('chatLog');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const hero = document.getElementById('hero');
const quickActions = document.getElementById('quickActions');

const editOverlay = document.getElementById('editOverlay');
const editTitle = document.getElementById('editTitle');
const editLabel = document.getElementById('editLabel');
const editFieldHolder = document.getElementById('editFieldHolder');
const editError = document.getElementById('editError');
const editSaveBtn = document.getElementById('editSave');
const editCancelBtn = document.getElementById('editCancel');

const TABLE_COLUMNS = [
  { label: 'Date',           idx: 0, type: 'date' },
  { label: 'Amount',         idx: 1, type: 'number' },
  { label: 'Detail',         idx: 2, type: 'text' },
  { label: 'Category',       idx: 3, type: 'select', options: () => [...Object.keys(CATEGORY_DEFS), 'Misc', 'Transfer', 'Income'] },
  { label: 'Payment Method', idx: 4, type: 'select', options: () => ['Cash', NON_CASH_METHOD] }
];

let isBusy = false;

/* ───────────────────────── Small helpers ───────────────────────── */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const scrollToBottom = () => {
  scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: 'smooth' });
};

const toInputDate = s => {
  const m = String(s).match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
};
const fromInputDate = s => {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
};

function enterChatMode() {
  if (homeView.classList.contains('chat-mode')) return;
  quickActions.classList.add('vanish');
  hero.classList.add('vanish');
  homeView.classList.add('chat-mode');
}

/* ───────────────────────── Chat bubbles ───────────────────────── */

function addUserMessage(text) {
  const row = el('div', 'msg-row user');
  row.appendChild(el('div', 'bubble user-bubble', text));
  chatLog.appendChild(row);
  scrollToBottom();
}

function addBotText(text) {
  const row = el('div', 'msg-row bot');
  row.appendChild(el('div', 'bubble bot-bubble', text));
  chatLog.appendChild(row);
  scrollToBottom();
}

function addTypingIndicator() {
  const row = el('div', 'msg-row bot');
  const bubble = el('div', 'bubble bot-bubble typing');
  for (let i = 0; i < 3; i++) bubble.appendChild(el('span', 'dot'));
  row.appendChild(bubble);
  chatLog.appendChild(row);
  scrollToBottom();
  return row;
}

function addBotTable(rows) {
  const row = el('div', 'msg-row bot');
  const bubble = el('div', 'bubble bot-bubble table-bubble');

  const scroll = el('div', 'table-scroll');
  const table = el('table', 'result-table');

  const thead = el('thead');
  const headRow = el('tr');
  TABLE_COLUMNS.forEach(c => headRow.appendChild(el('th', '', c.label)));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const notes = el('div', 'change-notes');

  const tbody = el('tbody');
  rows.forEach(rowData => {
    const tr = el('tr');
    TABLE_COLUMNS.forEach(col => {
      const td = el('td');
      const link = el('button', 'cell-link', rowData[col.idx]);
      link.type = 'button';
      link.title = `Edit ${col.label}`;
      link.addEventListener('click', () => openEditor(rowData, col, link, notes));
      td.appendChild(link);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  scroll.appendChild(table);
  bubble.appendChild(scroll);
  bubble.appendChild(notes);
  row.appendChild(bubble);
  chatLog.appendChild(row);
  scrollToBottom();
}

/* ───────────────────────── Edit panel ───────────────────────── */

let activeEdit = null;

function openEditor(rowData, col, linkEl, notesEl) {
  activeEdit = { rowData, col, linkEl, notesEl, oldValue: rowData[col.idx], field: null };

  editTitle.textContent = `Edit ${col.label}`;
  editLabel.textContent = col.label;
  editError.textContent = '';
  editFieldHolder.innerHTML = '';

  let field;
  if (col.type === 'select') {
    field = el('select');
    const opts = col.options();
    if (!opts.includes(activeEdit.oldValue)) opts.push(activeEdit.oldValue);
    opts.forEach(o => {
      const opt = el('option', '', o);
      opt.value = o;
      field.appendChild(opt);
    });
    field.value = activeEdit.oldValue;
  } else if (col.type === 'date') {
    field = el('input');
    field.type = 'date';
    field.max = toInputDate(fmtDate(new Date()));
    field.value = toInputDate(activeEdit.oldValue);
  } else if (col.type === 'number') {
    field = el('input');
    field.type = 'number';
    field.min = '0';
    field.step = 'any';
    field.value = activeEdit.oldValue;
  } else {
    field = el('input');
    field.type = 'text';
    field.value = activeEdit.oldValue;
  }
  field.id = 'editField';
  editLabel.htmlFor = 'editField';
  editFieldHolder.appendChild(field);
  activeEdit.field = field;

  editOverlay.hidden = false;
  field.focus();
  if (field.select && col.type !== 'date') field.select();
}

function closeEditor() {
  editOverlay.hidden = true;
  activeEdit = null;
}

function saveEdit() {
  if (!activeEdit) return;
  const { rowData, col, linkEl, notesEl, oldValue, field } = activeEdit;

  let newValue;
  if (col.type === 'date') {
    newValue = fromInputDate(field.value);
    if (!newValue) { editError.textContent = 'Please pick a valid date.'; return; }
  } else if (col.type === 'number') {
    const n = parseFloat(field.value);
    if (!isFinite(n) || n <= 0) { editError.textContent = 'Please enter an amount greater than 0.'; return; }
    newValue = formatAmount(n);
  } else if (col.type === 'text') {
    newValue = field.value.trim();
    if (!newValue) { editError.textContent = 'This value cannot be empty.'; return; }
  } else {
    newValue = field.value;
  }

  if (newValue === oldValue) { closeEditor(); return; }

  rowData[col.idx] = newValue;
  DC.Store.updateFromRow(rowData);
  DC.refresh();
  linkEl.textContent = newValue;
  linkEl.classList.add('just-edited');
  setTimeout(() => linkEl.classList.remove('just-edited'), 1200);

  notesEl.appendChild(el('p', 'change-note', `"${col.label}" changed from "${oldValue}" to "${newValue}"`));

  closeEditor();
  scrollToBottom();
}

editSaveBtn.addEventListener('click', saveEdit);
editCancelBtn.addEventListener('click', closeEditor);
editOverlay.addEventListener('click', e => { if (e.target === editOverlay) closeEditor(); });
document.addEventListener('keydown', e => {
  if (editOverlay.hidden) return;
  if (e.key === 'Escape') closeEditor();
  if (e.key === 'Enter' && e.target.tagName !== 'SELECT') { e.preventDefault(); saveEdit(); }
});

/* ───────────────────────── Sending messages ───────────────────────── */

const CAT_ALIASES = {
  food: 'Food', foods: 'Food', groceries: 'Food', travel: 'Travel', transport: 'Travel', clothing: 'Clothing', clothes: 'Clothing',
  medical: 'Medical', bills: 'Bills & Utilities', utilities: 'Bills & Utilities', entertainment: 'Entertainment',
  investment: 'Investment', investments: 'Investment', savings: 'Savings', donation: 'Donation', donations: 'Donation',
  shopping: 'Purchase', purchases: 'Purchase', purchase: 'Purchase', 'personal care': 'Personal Care',
  income: 'Income', gains: 'Income', salary: 'Income'
};

function showRecords(list, intro) {
  if (!list.length) {
    addBotText(intro.empty);
    return;
  }
  list = list.slice().sort((a, b) => a.ts - b.ts);
  const inc = list.reduce((s, x) => s + (x.category === 'Income' ? x.amount : 0), 0);
  const out = list.reduce((s, x) => s + (x.category === 'Income' || x.category === 'Transfer' ? 0 : x.amount), 0);
  const parts = [];
  if (inc) parts.push(`income ${DC.money(inc)}`);
  if (out || !inc) parts.push(`spent ${DC.money(out)}`);
  addBotText(`${intro.found} (${list.length} record${list.length === 1 ? '' : 's'}, ${parts.join(', ')}). Tap any value to edit it.`);
  addBotTable(list.map(t => DC.Store.toRow(t)));
}

function tryQuery(text) {
  const t = text.toLowerCase().trim();
  const asks = /^(show|list|give|view|display|what|how much|how many|edit|open|see|go to|take me)\b/.test(t) || /\?\s*$/.test(t);
  if (!asks) return false;

  const now = new Date();
  if (/\b(settings?|theme|colou?rs?|customi[sz]e|preferences?)\b/.test(t)) {
    switchTab('settings');
    addBotText('Opened Settings. Everything there is customizable and saves automatically.');
    return true;
  }
  if (/\b(analysis|forecast|predict\w*|projection|future)\b/.test(t)) {
    switchTab('analysis');
    addBotText('Opened your spending forecast.');
    return true;
  }
  if (/\b(summary|overview|report)\b/.test(t)) {
    const a = DC.agg(now.getFullYear(), now.getMonth());
    switchTab('summary');
    addBotText(`This month so far: income ${DC.money(a.income)}, expenses ${DC.money(a.expenses)}, net ${DC.money(a.net)}. The full summary is in the Monthly summary tab.`);
    return true;
  }

  let day = null;
  if (/\byesterday/.test(t)) day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  else if (/\btoday/.test(t)) day = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  let cat = null;
  for (const [k, v] of Object.entries(CAT_ALIASES)) {
    if (new RegExp('\\b' + k + '\\b').test(t)) { cat = v; break; }
  }
  if (!day && !cat) return false;

  let list = day ? DC.Store.onDay(day) : DC.Store.inMonth(now.getFullYear(), now.getMonth());
  if (cat) list = list.filter(x => x.category === cat);

  const when = day ? (/\byesterday/.test(t) ? 'yesterday' : 'today') : 'this month';
  showRecords(list, {
    found: `Here are your ${cat ? cat.toLowerCase() + ' ' : ''}records for ${when}`,
    empty: `I couldn't find any ${cat ? cat.toLowerCase() + ' ' : ''}records for ${when}.`
  });
  return true;
}

DC.handlers.dayClick = d => {
  switchTab('home');
  enterChatMode();
  const label = `${d.getDate()}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
  addUserMessage(`Show records for ${label}`);
  showRecords(DC.Store.onDay(d), { found: `Here is ${label}`, empty: `No records found for ${label}.` });
};

async function handleSend(presetText) {
  const text = (typeof presetText === 'string' ? presetText : chatInput.value).trim();
  if (!text || isBusy) return;

  isBusy = true;
  sendBtn.disabled = true;

  switchTab('home');
  enterChatMode();
  addUserMessage(text);
  chatInput.value = '';

  try {
    if (tryQuery(text)) return;

    const typing = addTypingIndicator();
    try {
      const pre = window.DC_Calc ? DC_Calc.preprocess(text) : { text, notes: [], statedTotal: null };
      const expenseRows = await extractExpenseDetailsUltimate(pre.text);
      const incomeRows = DC.extractIncomeRows(pre.text);
      const rows = [...expenseRows, ...incomeRows];
      typing.remove();

      if (rows.length) {
        customerRequested = rows;
        console.log('Customer Requested 2D Array:', customerRequested);
        DC.Store.addRows(rows);
        DC.refresh();
        addBotTable(rows);
        if (window.DC_Calc) DC_Calc.afterAdd(rows, pre);
      } else {
        addBotText("I couldn't find any expense or gain in that message. Try something like \"Spent Rs. 500 on chocolate\" or \"I got paid Rs. 150000 salary\".");
      }
    } catch (err) {
      console.error(err);
      typing.remove();
      addBotText('Something went wrong while processing that. Please try again.');
    }
  } finally {
    isBusy = false;
    sendBtn.disabled = false;
    chatInput.focus();
  }
}

sendBtn.addEventListener('click', () => handleSend());
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});

document.querySelectorAll('.action-card').forEach(card => {
  card.addEventListener('click', () => handleSend(card.dataset.prompt || card.textContent.trim()));
});

/* ───────────────────────── Voice input (mic button) ───────────────────────── */

const micBtn = document.getElementById('micBtn');
const voicePanel = document.getElementById('voicePanel');
const voiceCanvas = document.getElementById('voiceCanvas');
const voiceStatus = document.getElementById('voiceStatus');
const voiceDot = document.getElementById('voiceDot');
const voiceHint = document.getElementById('voiceHint');
const voiceTranscript = document.getElementById('voiceTranscript');
const voiceDoneBtn = document.getElementById('voiceDone');
const voiceCancelBtn = document.getElementById('voiceCancel');

const VOICE_PLACEHOLDER = 'Say something like "I spent 500 on chocolate"...';

VoiceInput.hooks.canvas = voiceCanvas;

function openVoicePanel() {
  voicePanel.hidden = false;
  micBtn.classList.add('listening');
  voiceTranscript.classList.remove('error');
  voiceTranscript.classList.add('placeholder');
  voiceTranscript.textContent = VOICE_PLACEHOLDER;
  VoiceInput.resizeCanvas();
  scrollToBottom();
}

function closeVoicePanel() {
  voiceWanted = false;
  voicePanel.hidden = true;
  micBtn.classList.remove('listening');
}

function updateVoiceHint(percent) {
  if (VoiceInput.isModelReady()) { voiceHint.textContent = ''; return; }
  voiceHint.textContent = typeof percent === 'number'
    ? `Loading speech model… ${Math.round(percent)}% (first time only)`
    : 'Loading speech model… (first time only)';
}

VoiceInput.hooks.onProgress = updateVoiceHint;
VoiceInput.hooks.onReady = () => { voiceHint.textContent = ''; };

VoiceInput.hooks.onUpdate = ({ state, text, busy }) => {
  if (voicePanel.hidden) return;

  const live = state === 'listening';
  voiceDot.classList.toggle('idle', !live);
  voiceStatus.textContent =
    state === 'finishing' ? 'Transcribing…' :
    state === 'starting'  ? 'Starting mic…' : 'Listening';
  voiceDoneBtn.disabled = state !== 'listening';

  if (voiceTranscript.classList.contains('error')) return;
  if (text) {
    voiceTranscript.classList.remove('placeholder');
    voiceTranscript.textContent = busy ? text + ' …' : text;
  } else {
    voiceTranscript.classList.add('placeholder');
    voiceTranscript.textContent = busy ? 'Working on it…' : VOICE_PLACEHOLDER;
  }
  if (!VoiceInput.isModelReady()) updateVoiceHint();
};

let voiceWanted = false;   // true only while the person has opened the voice panel themselves
VoiceInput.hooks.onError = msg => {
  if (!voiceWanted) { console.warn('Speech engine:', msg); return; }   // background preload failed: stay quiet
  if (voicePanel.hidden) openVoicePanel();
  voiceDot.classList.add('idle');
  voiceStatus.textContent = 'Voice unavailable';
  voiceDoneBtn.disabled = true;
  voiceTranscript.classList.remove('placeholder');
  voiceTranscript.classList.add('error');
  voiceTranscript.textContent = msg;
};

VoiceInput.hooks.onFinish = text => {
  closeVoicePanel();
  if (text) {
    chatInput.value = (chatInput.value.trim() + ' ' + text).trim();
    chatInput.focus();
  } else {
    chatInput.placeholder = "Didn't catch that, try again";
    setTimeout(() => { chatInput.placeholder = DC.getSettings().placeholder; }, 2500);
  }
};

micBtn.addEventListener('click', () => {
  const s = VoiceInput.getState();
  if (s === 'idle') {
    voiceWanted = true;
    openVoicePanel();
    updateVoiceHint();
    VoiceInput.start();
  } else if (s === 'listening') {
    VoiceInput.stop();
  }
});

voiceDoneBtn.addEventListener('click', () => {
  if (VoiceInput.getState() === 'listening') VoiceInput.stop();
});

voiceCancelBtn.addEventListener('click', () => {
  VoiceInput.cancel();
  closeVoicePanel();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && editOverlay.hidden && !voicePanel.hidden) {
    VoiceInput.cancel();
    closeVoicePanel();
  }
});

window.addEventListener('resize', () => { if (!voicePanel.hidden) VoiceInput.resizeCanvas(); });

setTimeout(() => VoiceInput.preload(), 1500);