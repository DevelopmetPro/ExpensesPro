/* Auth.js: sign-in / create-account panel.
   Loads FIRST. Once someone is signed in it sets window.DC_NS (the per-account storage prefix)
   and then loads Script.js and Extras.js, so every account has its own transactions, settings and chats.

   NOTE: accounts live in this browser's localStorage. That separates people who share a device, but it is
   not server-side security and data does not sync between devices. For that you need a backend. */
(() => {
  'use strict';

  /* The app's name: change it here and it updates everywhere (page title, sign-in, header, backups). */
  const APP_NAME = 'Expenses Pro';
  window.DC_APP_NAME = APP_NAME;
  document.title = APP_NAME;

  const ACC = 'dailycal.accounts.v1';
  const SES = 'dailycal.session.v1';
  const LEGACY = ['dailycal.settings.v1', 'dailycal.tx.v1'];

  const $ = id => document.getElementById(id);
  const rd = (k, fb) => { try { const v = localStorage.getItem(k); return v === null ? fb : JSON.parse(v); } catch (e) { return fb; } };
  const wr = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };
  const accounts = () => { const a = rd(ACC, {}); return a && typeof a === 'object' && !Array.isArray(a) ? a : {}; };

  /* ───────── password hashing ───────── */
  const enc = new TextEncoder();
  const hex = buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  const newSalt = () => { const a = new Uint8Array(16); (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => { a[i] = Math.floor(Math.random() * 256); }); return hex(a); };

  async function hashPw(pw, salt) {
    if (window.crypto && crypto.subtle) {
      const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations: 120000, hash: 'SHA-256' }, key, 256);
      return 'p:' + hex(bits);
    }
    // weak fallback for non-secure origins where SubtleCrypto is unavailable
    let h = 2166136261;
    const str = salt + ':' + pw;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return 'f:' + (h >>> 0).toString(16);
  }

  /* ───────── helpers ───────── */
  const idOf = name => String(name).trim().toLowerCase();
  const NAME_RE = /^[\w.-]{3,24}$/;

  function initialsOf(name) {
    const parts = String(name).split(/[\s._-]+/).filter(Boolean);
    const s = parts.length > 1 ? parts[0][0] + parts[1][0] : String(name).slice(0, 2);
    return s.toUpperCase();
  }

  function hasLegacyData() {
    try { return LEGACY.some(k => localStorage.getItem(k) !== null); } catch (e) { return false; }
  }

  /* The first account created on this device inherits any data saved before accounts existed. */
  function adoptLegacy(ns) {
    LEGACY.forEach(k => { const v = localStorage.getItem(k); if (v !== null) localStorage.setItem(ns + k, v); });
    try {
      const c = JSON.parse(localStorage.getItem('dailycal.chat.v1'));
      if (c && c.day && Array.isArray(c.msgs)) localStorage.setItem(ns + 'dailycal.chat.v2', JSON.stringify({ [c.day]: c.msgs }));
    } catch (e) { /* ignore */ }
  }

  function seedProfile(ns, name) {
    const key = ns + 'dailycal.settings.v1';
    const s = rd(key, {}) || {};
    if (!s.initials || s.initials === 'DC') s.initials = initialsOf(name);
    wr(key, s);
  }

  const nsFor = id => 'u.' + id + '.';

  /* ───────── load the app for a signed-in user ───────── */
  const loadScript = src => new Promise(resolve => {
    const el = document.createElement('script');
    el.src = src; el.async = false;
    el.onload = () => resolve(true);
    el.onerror = () => { console.error('Could not load ' + src); resolve(false); };
    document.body.appendChild(el);
  });

  function showLoadError(file) {
    const box = document.createElement('div');
    box.className = 'auth-gate';
    const card = document.createElement('div'); card.className = 'auth-card';
    const h = document.createElement('h2'); h.textContent = 'Could not start ' + APP_NAME;
    const p = document.createElement('p'); p.className = 'auth-sub';
    p.textContent = file + ' failed to load. Check that the file exists next to the HTML page (names are case-sensitive on most hosts), then reload.';
    const b = document.createElement('button'); b.type = 'button'; b.className = 'auth-submit'; b.textContent = 'Reload';
    b.addEventListener('click', () => location.reload());
    card.append(h, p, b); box.appendChild(card); document.body.appendChild(box);
  }

  async function boot(id, name) {
    window.DC_USER = { id, name };
    window.DC_NS = nsFor(id);
    for (const f of ['Script.js', 'Extras.js', 'Layout.js', 'Calc.js']) {
      if (!(await loadScript(f))) { showLoadError(f); return; }
    }
    wireAccountMenu(name);
  }

  /* ───────── account menu (avatar, top right) ───────── */
  function wireAccountMenu(name) {
    const btn = $('accountBtn'), menu = $('accountMenu');
    if (!btn || !menu) return;
    $('accountName').textContent = name;
    const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.addEventListener('click', () => {
      menu.hidden = !menu.hidden;
      btn.setAttribute('aria-expanded', String(!menu.hidden));
    });
    document.addEventListener('click', e => { if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) { close(); btn.focus(); } });

    $('signOutBtn').addEventListener('click', () => { try { localStorage.removeItem(SES); } catch (e) { /* ignore */ } location.reload(); });

    $('deleteAccBtn').addEventListener('click', () => {
      if (!confirm('Delete this account and ALL of its transactions, settings and chats from this device? This cannot be undone.')) return;
      const ns = window.DC_NS;
      const doomed = [];
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(ns)) doomed.push(k); }
      doomed.forEach(k => localStorage.removeItem(k));
      const all = accounts(); delete all[window.DC_USER.id]; wr(ACC, all);
      try { localStorage.removeItem(SES); } catch (e) { /* ignore */ }
      location.reload();
    });
  }

  /* First-time setup: ask for the current balance, saved as the account's opening balance. */
  function askBalance(gate, ns, name) {
    return new Promise(resolve => {
      const key = ns + 'dailycal.settings.v1';
      const s = rd(key, {}) || {};
      if (s.openingBalance || s.openingCash || s.openingBank) { resolve(); return; }   // e.g. data adopted from before accounts existed
      const card = gate.querySelector('.auth-card');
      card.innerHTML =
        '<img class="auth-logo" src="images/Logo.png" alt="" onerror="this.remove()">' +
        '<h2 id="authWelcome"></h2>' +
        '<p class="auth-sub">How much money do you have right now? ' + APP_NAME + ' starts tracking from these amounts.</p>' +
        '<form id="balForm" novalidate>' +
          '<div class="auth-field"><label for="authBalCash">Cash in hand</label>' +
          '<input id="authBalCash" type="number" inputmode="decimal" step="any" placeholder="e.g. 5000"></div>' +
          '<div class="auth-field"><label for="authBalBank">Bank balance</label>' +
          '<input id="authBalBank" type="number" inputmode="decimal" step="any" placeholder="e.g. 20000"></div>' +
          '<p class="auth-note">You can change this any time in Settings → Finance.</p>' +
          '<button type="submit" class="auth-submit">Continue</button>' +
          '<button type="button" class="auth-skip" id="balSkip">Skip for now</button>' +
        '</form>';
      card.querySelector('#authWelcome').textContent = 'Welcome, ' + name + '!';
      const cash = card.querySelector('#authBalCash'), bank = card.querySelector('#authBalBank');
      cash.focus();
      let finished = false;
      const done = save => {
        if (finished) return false;
        if (save) {
          const c = cash.value.trim() === '' ? 0 : parseFloat(cash.value);
          const b = bank.value.trim() === '' ? 0 : parseFloat(bank.value);
          if (isNaN(c)) { cash.focus(); return false; }
          if (isNaN(b)) { bank.focus(); return false; }
          s.openingCash = c; s.openingBank = b; wr(key, s);
        }
        finished = true; resolve(); return true;
      };
      card.querySelector('#balForm').addEventListener('submit', e => { e.preventDefault(); done(true); });
      card.querySelector('#balSkip').addEventListener('click', () => done(false));
    });
  }

  /* ───────── sign-in panel ───────── */
  function buildGate() {
    const gate = document.createElement('div');
    gate.className = 'auth-gate';
    gate.id = 'authGate';
    gate.innerHTML =
      '<div class="auth-card" role="dialog" aria-modal="true" aria-labelledby="authTitle">' +
        '<img class="auth-logo" src="images/Logo.png" alt="" onerror="this.remove()">' +
        '<h2 id="authTitle">Welcome back</h2>' +
        '<p class="auth-sub" id="authSub">Sign in to open ' + APP_NAME + '.</p>' +
        '<div class="auth-tabs" role="tablist">' +
          '<button type="button" class="auth-tab active" data-mode="login" role="tab">Sign in</button>' +
          '<button type="button" class="auth-tab" data-mode="register" role="tab">Create account</button>' +
        '</div>' +
        '<form id="authForm" novalidate>' +
          '<div class="auth-field">' +
            '<label for="authUser">Username</label>' +
            '<input id="authUser" placeholder="e.g. alex_91" autocomplete="username" maxlength="24" autocapitalize="none" spellcheck="false">' +
          '</div>' +
          '<div class="auth-field">' +
            '<label for="authPass">Password</label>' +
            '<div class="auth-pw">' +
              '<input id="authPass" type="password" placeholder="Your password" autocomplete="current-password">' +
              '<button type="button" class="auth-eye" id="authEye" aria-label="Show password" aria-pressed="false">Show</button>' +
            '</div>' +
          '</div>' +
          '<div class="auth-field" id="authConfirmWrap" hidden>' +
            '<label for="authPass2">Confirm password</label>' +
            '<input id="authPass2" type="password" placeholder="Repeat the password" autocomplete="new-password">' +
          '</div>' +
          '<p class="auth-error" id="authError" role="alert"></p>' +
          '<p class="auth-note" id="authNote"></p>' +
          '<button type="submit" class="auth-submit" id="authSubmit">Sign in</button>' +
        '</form>' +
        '<p class="auth-foot">Accounts are stored on this device only.</p>' +
      '</div>';
    document.body.appendChild(gate);

    let mode = 'login';
    const user = $('authUser'), pass = $('authPass'), pass2 = $('authPass2');
    const err = $('authError'), submit = $('authSubmit');
    const noAccountsYet = () => Object.keys(accounts()).length === 0;

    function setMode(m) {
      mode = m;
      const reg = m === 'register';
      gate.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === m));
      $('authTitle').textContent = reg ? 'Create your account' : 'Welcome back';
      $('authSub').textContent = reg ? 'Pick a username and password to get started.' : 'Sign in to open ' + APP_NAME + '.';
      $('authConfirmWrap').hidden = !reg;
      pass.autocomplete = reg ? 'new-password' : 'current-password';
      pass.placeholder = reg ? 'At least 6 characters' : 'Your password';
      pass.value = ''; if (pass2) pass2.value = '';
      submit.textContent = reg ? 'Create account' : 'Sign in';
      $('authNote').textContent = (reg && noAccountsYet() && hasLegacyData()) ? 'Your existing data on this device will be moved into this account.' : '';
      err.textContent = '';
      user.focus();
    }
    gate.querySelectorAll('.auth-tab').forEach(t => t.addEventListener('click', () => setMode(t.dataset.mode)));

    $('authEye').addEventListener('click', () => {
      const show = pass.type === 'password';
      pass.type = show ? 'text' : 'password';
      if (pass2) pass2.type = pass.type;
      $('authEye').textContent = show ? 'Hide' : 'Show';
      $('authEye').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      $('authEye').setAttribute('aria-pressed', String(show));
    });

    $('authForm').addEventListener('submit', async ev => {
      ev.preventDefault();
      err.textContent = '';
      const name = user.value.trim(), pw = pass.value, id = idOf(name);
      if (!name || !pw) { err.textContent = 'Enter a username and password.'; return; }
      submit.disabled = true;
      try {
        const all = accounts();
        if (mode === 'register') {
          if (!NAME_RE.test(name)) { err.textContent = 'Username: 3–24 letters, numbers, dots, dashes or underscores.'; return; }
          if (all[id]) { err.textContent = 'That username is already taken.'; return; }
          if (pw.length < 6) { err.textContent = 'Password must be at least 6 characters.'; return; }
          if (pw !== pass2.value) { err.textContent = 'Passwords do not match.'; return; }
          const first = Object.keys(all).length === 0;
          const salt = newSalt();
          all[id] = { name, salt, hash: await hashPw(pw, salt), created: Date.now() };
          if (!wr(ACC, all)) { err.textContent = 'Could not save the account (browser storage is unavailable).'; return; }
          const ns = nsFor(id);
          if (first && hasLegacyData()) adoptLegacy(ns);
          seedProfile(ns, name);
          await askBalance(gate, ns, name);
          wr(SES, { user: id });
          gate.remove();
          await boot(id, name);
        } else {
          const acc = all[id];
          if (!acc || (await hashPw(pw, acc.salt)) !== acc.hash) { err.textContent = 'Incorrect username or password.'; return; }
          wr(SES, { user: id });
          gate.remove();
          await boot(id, acc.name);
        }
      } catch (e) {
        console.error(e);
        err.textContent = 'Something went wrong. Please try again.';
      } finally {
        submit.disabled = false;
      }
    });

    // fresh device with no accounts: open on "Create account"
    setMode(noAccountsYet() ? 'register' : 'login');
  }

  /* ───────── start ───────── */
  const ses = rd(SES, null);
  const acc = ses && accounts()[ses.user];
  if (acc) boot(ses.user, acc.name);
  else buildGate();
})();