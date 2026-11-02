// Shared sync with Firebase (Auth + Firestore), loaded from Google's CDN.
// Only runs when firebase-config.js is filled in; otherwise the app stays local-only.
const V = '13.1.0';
const CDN = `https://www.gstatic.com/firebasejs/${V}`;
const cfg = window.FIREBASE_CONFIG || {};
const configured = !!(cfg.apiKey && cfg.projectId && !/PASTE/.test(cfg.apiKey + cfg.projectId + (cfg.appId || '')));
const LISTS = ['purchases', 'bills', 'subs', 'moves'];
const MAIN_FIELDS = ['period', 'limits', 'limitsNote', 'hotelDays'];
const OWNER = String(window.TRACKER_OWNER || '').toLowerCase();
const HH = window.TRACKER_HOUSEHOLD || 'main';
const qs = new URLSearchParams(location.search);

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const stable = v => JSON.stringify(v, (k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x).sort().reduce((o, k2) => (o[k2] = x[k2], o), {}) : x);
const plain = v => JSON.parse(JSON.stringify(v ?? null));
const whenReady = () => new Promise(r => window.__ready ? r() : document.addEventListener('app-ready', r, { once: true }));

async function start() {
  document.body.classList.add('cloud');
  mountGate();
  await whenReady();
  showGate('loading');
  let fb;
  try {
    const [A, U, F] = await Promise.all([import(`${CDN}/firebase-app.js`), import(`${CDN}/firebase-auth.js`), import(`${CDN}/firebase-firestore.js`)]);
    fb = { ...A, ...U, ...F };
  } catch (e) {
    console.warn('Firebase could not load', e);
    showGate('nonet'); return;
  }
  run(fb);
}

// ---------------------------------------------------------------------------
function run(fb) {
  const app = fb.initializeApp(cfg);
  const auth = fb.getAuth(app);
  let db;
  try {
    db = fb.initializeFirestore(app, { localCache: fb.persistentLocalCache({ tabManager: fb.persistentMultipleTabManager() }) });
  } catch (e) { db = fb.getFirestore(app); }
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  if (local && qs.get('emulator') === '1') {
    fb.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    fb.connectFirestoreEmulator(db, '127.0.0.1', 8080);
  }

  const hhRef = fb.doc(db, 'households', HH);
  let unsubs = [];
  let remote = null;            // last data seen from the server: { main, lists: { purchases: Map(id -> doc) } }
  let seen = {};                // which listeners have delivered at least once
  let pending = {};             // which listeners have unsent local writes
  let user = null;

  const Sync = window.Sync = {
    ready: false,
    get user() { return user; },
    push, settingsHTML, bindSettings,
    signOut: doSignOut
  };
  // Signing out also clears this device's copy of the shared data.
  async function doSignOut() {
    await fb.signOut(auth); App.clearLocal();
    try { await fb.terminate(db); await fb.clearIndexedDbPersistence(db); } catch (e) { console.warn('cache clear', e); }
    location.reload();
  }

  // ---------- status pill ----------
  function updateStatus() {
    if (!Sync.ready) return;
    const anyPending = Object.values(pending).some(Boolean);
    if (!navigator.onLine) App.setStatus({ tone: 'off', long: anyPending ? 'Offline · will sync' : 'Offline · saved', short: 'Offline' });
    else if (anyPending) App.setStatus({ tone: 'busy', long: 'Syncing…', short: 'Syncing' });
    else App.setStatus({ tone: 'good', long: 'Synced with everyone', short: 'Synced' });
  }
  addEventListener('online', updateStatus); addEventListener('offline', updateStatus);

  // ---------- auth ----------
  fb.onAuthStateChanged(auth, async u => {
    stopListening();
    user = u;
    if (!u) { Sync.ready = false; App.setStatus({ tone: 'off', long: 'Not signed in', short: 'Signed out' }); showGate('signin'); return; }
    if (!u.emailVerified) { showGate('verify', { email: u.email }); return; }
    listen();
  });

  function stopListening() { unsubs.forEach(f => f()); unsubs = []; remote = null; seen = {}; pending = {}; Sync.ready = false; }

  // ---------- real-time listeners ----------
  function listen() {
    showGate('loading', { msg: 'Getting the shared tracker…' });
    remote = { main: undefined, lists: Object.fromEntries(LISTS.map(l => [l, new Map()])) };
    const onErr = e => {
      console.warn('sync', e.code || e);
      stopListening();
      if (e.code === 'permission-denied') showGate('denied', { email: user && user.email });
      else showGate('error', { msg: e.message });
    };
    unsubs.push(fb.onSnapshot(hhRef, { includeMetadataChanges: true }, snap => {
      remote.main = snap.exists() ? snap.data() : null;
      seen.main = snap.metadata.fromCache ? (seen.main || 'cache') : 'server';
      pending.main = snap.metadata.hasPendingWrites;
      changed();
    }, onErr));
    LISTS.forEach(l => unsubs.push(fb.onSnapshot(fb.collection(hhRef, l), { includeMetadataChanges: true }, snap => {
      const m = new Map(); snap.forEach(d => m.set(d.id, d.data()));
      remote.lists[l] = m; seen[l] = true; pending[l] = snap.metadata.hasPendingWrites;
      changed();
    }, onErr)));
  }

  function changed() {
    if (!remote || remote.main === undefined || !LISTS.every(l => seen[l])) return;
    if (remote.main === null) {
      Sync.ready = false;
      // No shared tracker yet. Only trust that once the server has confirmed it.
      if (seen.main === 'server') showGate('setup', { email: user.email, hasLocal: hasLocalData() });
      else showGate('loading', { msg: navigator.onLine ? 'Getting the shared tracker…' : 'Connect to the internet once to get the shared tracker.' });
      return;
    }
    const first = !Sync.ready;
    Sync.ready = true;
    hideGate();
    App.applyRemote(toState());
    updateStatus();
    if (first) App.render();
  }

  function toState() {
    const m = remote.main || {};
    const s = { version: 1, setup: true };
    MAIN_FIELDS.forEach(k => { if (m[k] !== undefined) s[k] = plain(m[k]); });
    LISTS.forEach(l => {
      s[l] = [...remote.lists[l].values()].sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0) || String(a.id).localeCompare(String(b.id)))
        .map(d => { const x = plain(d); delete x.ord; return x; });
    });
    s.updatedAt = m.updatedAt && m.updatedAt.toDate ? m.updatedAt.toDate().toISOString() : new Date().toISOString();
    s.updatedBy = m.updatedBy || '';
    return s;
  }

  // ---------- writes: only what changed ----------
  function push(state, opts = {}) {
    if (!user || !remote) return Promise.resolve();
    const batch = fb.writeBatch(db);
    let n = 0;
    const main = remote.main || {};
    const upd = {};
    MAIN_FIELDS.forEach(k => {
      if (k === 'hotelDays') {
        const cur = state.hotelDays || {}, old = main.hotelDays || {};
        const diff = {}; Object.keys(cur).forEach(d => { if (cur[d] !== old[d]) diff[d] = cur[d]; });
        if (Object.keys(diff).length || opts.all) upd.hotelDays = opts.all ? plain(cur) : diff;
      } else if (opts.all || stable(state[k]) !== stable(main[k])) upd[k] = plain(state[k] ?? null);
    });
    LISTS.forEach(l => {
      const have = remote.lists[l]; const ids = new Set();
      (state[l] || []).forEach((item, i) => {
        if (!item || !item.id) return;
        const id = String(item.id); ids.add(id);
        const docData = plain({ ...item, ord: i });
        if (opts.all || !have.has(id) || stable(have.get(id)) !== stable(docData)) { batch.set(fb.doc(hhRef, l, id), docData); n++; }
      });
      have.forEach((_, id) => { if (!ids.has(id)) { batch.delete(fb.doc(hhRef, l, id)); n++; } });
    });
    if (!n && !Object.keys(upd).length) return Promise.resolve();
    upd.updatedAt = fb.serverTimestamp(); upd.updatedBy = user.email; upd.setup = true;
    batch.set(hhRef, upd, { merge: true });
    pending.main = true; updateStatus();
    return batch.commit().catch(e => {
      console.warn('sync write', e);
      App.toast(e.code === 'permission-denied' ? "You don't have access to change the shared tracker" : "Couldn't sync that change");
    });
    // Offline: commit() waits for the server, but the change is already saved and shows everywhere once back online.
  }

  // ---------- first-time upload ----------
  function hasLocalData() { const s = App.state; return !!(s && s.setup && (s.purchases.length || s.bills.length || s.subs.length)); }
  async function seedCloud(data) {
    showGate('loading', { msg: 'Uploading…' });
    const s = App.normalize(data); s.setup = true;
    remote.main = remote.main || {};
    push(s, { all: true });
    // The listener picks it up right away (and the server copy follows).
  }

  // ---------- people (allowlist) ----------
  let people = null, peopleUnsub = null;
  function watchPeople() {
    if (peopleUnsub) return;
    peopleUnsub = fb.onSnapshot(fb.collection(db, 'allowlist'), snap => {
      people = []; snap.forEach(d => people.push(d.id)); people.sort();
      if (document.querySelector('#people')) App.render();
    }, () => { people = null; });
    unsubs.push(() => { peopleUnsub && peopleUnsub(); peopleUnsub = null; });
  }
  function isOwner() { return user && user.email && user.email.toLowerCase() === OWNER; }

  function settingsHTML() {
    watchPeople();
    const owner = isOwner();
    const list = (people || []).filter(e => e !== OWNER);
    return `
      <div class="sec">Shared tracker</div>
      <div class="card sharecard">
        <div class="who"><div class="av">${esc((user.email || '?')[0].toUpperCase())}</div>
          <div><div class="t">${esc(user.email)}</div><div class="s">${owner ? 'Owner' : 'Can add and edit'}</div></div>
          <button class="btn ghost sm" id="signout">Sign out</button></div>
        <div class="sub2" id="people">People with access</div>
        <div class="plist">
          <div class="p"><span>${esc(OWNER)}</span><em>Owner</em></div>
          ${list.map(e => `<div class="p"><span>${esc(e)}</span>${owner ? `<button class="x" data-rmperson="${esc(e)}" aria-label="Remove ${esc(e)}">Remove</button>` : ''}</div>`).join('')}
        </div>
        ${owner ? `<div class="addp"><input id="newp" type="email" inputmode="email" autocomplete="off" autocapitalize="off" placeholder="name@email.com"><button class="btn" id="addp">Add</button></div>
          <div class="hint">They sign in with this email on the same link. Anyone on the list can add and edit everything.</div>`
          : `<div class="hint">Ask ${esc(OWNER)} to add someone.</div>`}
      </div>`;
  }
  function bindSettings(root) {
    const so = root.querySelector('#signout'); if (so) so.onclick = () => { if (confirm('Sign out on this device? The shared data stays safe online.')) doSignOut(); };
    const add = root.querySelector('#addp');
    if (add) add.onclick = async () => {
      const inp = root.querySelector('#newp'); const e = inp.value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) { inp.focus(); App.toast('Type a full email address'); return; }
      try { fb.setDoc(fb.doc(db, 'allowlist', e), { addedBy: user.email, addedAt: fb.serverTimestamp() }).catch(err => App.toast(err.code === 'permission-denied' ? 'Only the owner can add people' : "Couldn't add them")); inp.value = ''; App.toast(`Added ${e}. Send them the link.`); }
      catch (err) { App.toast("Couldn't add them"); }
    };
    root.querySelectorAll('[data-rmperson]').forEach(b => b.onclick = () => {
      const e = b.dataset.rmperson;
      if (confirm(`Remove ${e}? They won't be able to see or change the tracker.`)) fb.deleteDoc(fb.doc(db, 'allowlist', e)).catch(() => App.toast("Couldn't remove them"));
    });
  }

  // ---------- gate actions ----------
  Gate.actions = {
    async signin(email, pw) { await fb.signInWithEmailAndPassword(auth, email, pw); },
    async signup(email, pw) {
      const c = await fb.createUserWithEmailAndPassword(auth, email, pw);
      await sendVerify(c.user);
    },
    async reset(email) { await fb.sendPasswordResetEmail(auth, email); },
    async resend() { await sendVerify(auth.currentUser); },
    async checkVerified() {
      await auth.currentUser.reload();
      if (!auth.currentUser.emailVerified) return false;
      await auth.currentUser.getIdToken(true);
      user = auth.currentUser; listen(); return true;
    },
    retry() { if (user) listen(); },
    signOut() { return doSignOut(); },
    uploadLocal() { return seedCloud(App.state); },
    uploadFile(data) { return seedCloud(data); },
    startEmpty() { return seedCloud(Object.assign(App.normalize(window.SEED), { setup: true })); }
  };
  async function sendVerify(u) {
    const url = location.origin + location.pathname;
    try { await fb.sendEmailVerification(u, { url }); } catch (e) { await fb.sendEmailVerification(u); }
  }

  // Import from Daily > "Replace shared data" goes through App's import, which calls save() -> push().
}

// ---------------------------------------------------------------------------
// The gate: sign-in / verify / setup screens, styled like the rest of the app.
const Gate = { mode: null, actions: {} };
function mountGate() {
  if ($('#gate')) return;
  const g = document.createElement('div'); g.id = 'gate'; g.className = 'gate on';
  g.innerHTML = `<div class="gwrap"><div class="gcard" id="gcard"></div></div>`;
  document.body.appendChild(g);
}
function hideGate() { const g = $('#gate'); if (g) g.classList.remove('on'); document.body.classList.remove('gated'); Gate.mode = null; }
const LOGO = `<img src="icons/icon-192.png" alt="" class="glogo">`;
const errText = e => {
  const c = (e && e.code) || '';
  return ({
    'auth/invalid-credential': 'Wrong email or password.', 'auth/wrong-password': 'Wrong email or password.', 'auth/user-not-found': 'No account with that email yet. Tap "Create one".',
    'auth/invalid-email': 'That email doesn\'t look right.', 'auth/email-already-in-use': 'That email already has an account. Sign in instead.',
    'auth/weak-password': 'Use at least 6 characters.', 'auth/too-many-requests': 'Too many tries. Wait a minute and try again.',
    'auth/network-request-failed': 'No connection. Try again when you have signal.', 'auth/missing-password': 'Type your password.'
  })[c] || (e && e.message ? e.message.replace(/^Firebase: /, '') : 'Something went wrong.');
};

function showGate(mode, o = {}) {
  const g = $('#gate'); if (!g) return;
  g.classList.add('on'); document.body.classList.add('gated'); Gate.mode = mode;
  const card = $('#gcard');
  const signForm = up => `
    ${LOGO}
    <h1>${up ? 'Create your account' : 'Sign in to Spending'}</h1>
    <p class="gsub">${up ? 'Use the email Charles added. You\'ll get a quick email to confirm it.' : 'Your shared tracker, synced on every device.'}</p>
    <form id="gform" novalidate>
      <div class="glist">
        <label class="gf"><span>Email</span><input id="gemail" type="email" inputmode="email" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="name@email.com" value="${esc(o.email && mode !== 'signin' ? o.email : '')}"></label>
        <label class="gf"><span>Password</span><input id="gpw" type="password" autocomplete="${up ? 'new-password' : 'current-password'}" placeholder="${up ? 'At least 6 characters' : 'Password'}"></label>
      </div>
      <div class="gerr" id="gerr" role="alert"></div>
      <button class="btn gbtn" id="gok" type="submit">${up ? 'Create account' : 'Sign in'}</button>
    </form>
    <div class="galt">${up ? 'Already have an account? <a href="#" id="gswap">Sign in</a>' : 'New here? <a href="#" id="gswap">Create an account</a>'}</div>
    ${up ? '' : '<div class="galt sm"><a href="#" id="gforgot">Forgot password?</a></div>'}`;

  if (mode === 'signin' || mode === 'signup') {
    const up = mode === 'signup';
    card.innerHTML = signForm(up);
    $('#gswap').onclick = e => { e.preventDefault(); showGate(up ? 'signin' : 'signup', { email: $('#gemail').value }); };
    const fg = $('#gforgot');
    if (fg) fg.onclick = async e => {
      e.preventDefault(); const em = $('#gemail').value.trim();
      if (!em) { $('#gerr').textContent = 'Type your email first, then tap Forgot password.'; $('#gemail').focus(); return; }
      try { await Gate.actions.reset(em); $('#gerr').className = 'gerr ok'; $('#gerr').textContent = `Sent a reset link to ${em}.`; }
      catch (err) { $('#gerr').textContent = errText(err); }
    };
    $('#gform').onsubmit = async e => {
      e.preventDefault();
      const em = $('#gemail').value.trim(), pw = $('#gpw').value, b = $('#gok');
      $('#gerr').className = 'gerr'; $('#gerr').textContent = '';
      if (!em) { $('#gemail').focus(); return; }
      if (!pw) { $('#gpw').focus(); return; }
      if (!Gate.actions.signin) return;
      b.disabled = true; b.textContent = up ? 'Creating…' : 'Signing in…';
      try { await Gate.actions[up ? 'signup' : 'signin'](em, pw); }
      catch (err) { $('#gerr').textContent = errText(err); b.disabled = false; b.textContent = up ? 'Create account' : 'Sign in'; }
    };
    return;
  }
  if (mode === 'verify') {
    card.innerHTML = `${LOGO}<div class="gicon">✉️</div>
      <h1>Check your email</h1>
      <p class="gsub">We sent a link to <b>${esc(o.email)}</b>. Tap it to confirm it's you, then come back here.</p>
      <div class="gerr" id="gerr" role="alert"></div>
      <button class="btn gbtn" id="gdone">I tapped the link</button>
      <div class="galt"><a href="#" id="gresend">Send it again</a> · <a href="#" id="gout">Use another email</a></div>`;
    $('#gdone').onclick = async () => {
      const b = $('#gdone'); b.disabled = true; b.textContent = 'Checking…';
      try { if (!(await Gate.actions.checkVerified())) { $('#gerr').textContent = 'Not confirmed yet. Open the email and tap the link first.'; } }
      catch (err) { $('#gerr').textContent = errText(err); }
      b.disabled = false; b.textContent = 'I tapped the link';
    };
    $('#gresend').onclick = async e => { e.preventDefault(); try { await Gate.actions.resend(); $('#gerr').className = 'gerr ok'; $('#gerr').textContent = 'Sent again.'; } catch (err) { $('#gerr').textContent = errText(err); } };
    $('#gout').onclick = e => { e.preventDefault(); Gate.actions.signOut && Gate.actions.signOut(); };
    return;
  }
  if (mode === 'denied') {
    card.innerHTML = `${LOGO}<div class="gicon">🔒</div>
      <h1>Not on the list yet</h1>
      <p class="gsub">You're signed in as <b>${esc(o.email)}</b>, but this tracker is private. Ask Charles to add this email, then tap Try again.</p>
      <button class="btn gbtn" id="gretry">Try again</button>
      <div class="galt"><a href="#" id="gout">Sign out</a></div>`;
    $('#gretry').onclick = () => Gate.actions.retry && Gate.actions.retry();
    $('#gout').onclick = e => { e.preventDefault(); Gate.actions.signOut && Gate.actions.signOut(); };
    return;
  }
  if (mode === 'setup') {
    const hasLocal = o.hasLocal ?? (window.App && App.state && App.state.setup);
    const s = window.App && App.state;
    card.innerHTML = `${LOGO}
      <h1>Set up the shared tracker</h1>
      <p class="gsub">You're the first one here. Upload your data once and everyone you add will see it and can edit it.</p>
      <div class="gopts">
        ${hasLocal ? `<button class="gopt primary" id="gup"><span class="gi">⬆︎</span><span><b>Upload my current data to the shared tracker</b><small>${s.purchases.length} purchases, ${s.bills.length} bills, ${s.subs.length} subscriptions from this device</small></span></button>` : ''}
        <button class="gopt ${hasLocal ? '' : 'primary'}" id="gfile"><span class="gi">📄</span><span><b>Upload a backup file</b><small>The Spending-backup .json you exported</small></span></button>
        <button class="gopt" id="gempty"><span class="gi">✨</span><span><b>Start empty</b><small>Add bills and purchases as you go</small></span></button>
      </div>
      <div class="gerr" id="gerr" role="alert"></div>
      <div class="galt sm">Signed in as ${esc(o.email || '')} · <a href="#" id="gout">Sign out</a></div>
      <input type="file" id="gfilein" accept="application/json,.json" hidden>`;
    const up = $('#gup'); if (up) up.onclick = () => Gate.actions.uploadLocal && Gate.actions.uploadLocal();
    $('#gempty').onclick = () => { if (confirm('Start the shared tracker empty?')) Gate.actions.startEmpty && Gate.actions.startEmpty(); };
    $('#gfile').onclick = () => $('#gfilein').click();
    $('#gfilein').onchange = async e => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      try { const j = JSON.parse(await f.text()); const d = j.data || j; if (!d.period || !Array.isArray(d.purchases)) throw 0; Gate.actions.uploadFile && Gate.actions.uploadFile(d); }
      catch { $('#gerr').textContent = "That file isn't a Spending backup."; }
    };
    $('#gout').onclick = e => { e.preventDefault(); Gate.actions.signOut && Gate.actions.signOut(); };
    return;
  }
  if (mode === 'nonet') {
    card.innerHTML = `${LOGO}<div class="gicon">📶</div><h1>No connection</h1>
      <p class="gsub">The shared tracker needs the internet the first time on this device. After that it works offline.</p>
      <button class="btn gbtn" onclick="location.reload()">Try again</button>`;
    return;
  }
  if (mode === 'error') {
    card.innerHTML = `${LOGO}<h1>Couldn't sync</h1><p class="gsub">${esc(o.msg || 'Something went wrong.')}</p>
      <button class="btn gbtn" id="gretry">Try again</button><div class="galt"><a href="#" id="gout">Sign out</a></div>`;
    $('#gretry').onclick = () => Gate.actions.retry && Gate.actions.retry();
    $('#gout').onclick = e => { e.preventDefault(); Gate.actions.signOut && Gate.actions.signOut(); };
    return;
  }
  // loading
  card.innerHTML = `${LOGO}<div class="spin" aria-label="Loading"></div><p class="gsub">${esc(o.msg || 'Loading…')}</p>`;
}

if (configured) start();
