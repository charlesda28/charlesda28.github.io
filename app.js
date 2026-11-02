(() => {
'use strict';
const KEY = 'spending-tracker.v1';
const CATS = ['Food', 'Hotel', 'Gas', 'Other'];
const META = {
  Food:  { ic: '🍔', color: 'var(--food)',  tint: 'var(--food-t)' },
  Hotel: { ic: '🏨', color: 'var(--hotel)', tint: 'var(--hotel-t)' },
  Gas:   { ic: '⛽', color: 'var(--gas)',   tint: 'var(--gas-t)' },
  Other: { ic: '🛒', color: 'var(--other)', tint: 'var(--other-t)' }
};
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r2 = n => Math.round((+n || 0) * 100) / 100;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const clone = o => JSON.parse(JSON.stringify(o));

// Money: one sign only. Negative shows as "−$32.48" (single minus), never "--".
function money(n, { cents = true, plus = false } = {}) {
  n = r2(n);
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
  return (n < 0 ? '−' : (plus && n > 0 ? '+' : '')) + '$' + s;
}
const negc = n => r2(n) < 0 ? ' neg' : '';

// ---------- dates (local, YYYY-MM-DD) ----------
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const isISO = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const fmtDay = (s, o = { weekday: 'short', month: 'short', day: 'numeric' }) => parse(s).toLocaleDateString('en-US', o);
const qp = new URLSearchParams(location.search);
const todayISO = () => (isISO(qp.get('today')) ? qp.get('today') : iso(new Date()));

// ---------- storage: localStorage + IndexedDB mirror ----------
let state;
const idb = {
  open() { return new Promise((res, rej) => { const r = indexedDB.open('spending', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async get(k) { try { const db = await this.open(); return await new Promise(res => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(null); }); } catch { return null; } },
  async set(k, v) { try { const db = await this.open(); db.transaction('kv', 'readwrite').objectStore('kv').put(v, k); } catch {} }
};
function normalize(s) {
  const raw = s;
  const seed = clone(window.SEED);
  s = Object.assign(seed, s || {});
  s.limits = Object.assign(clone(window.SEED.limits), s.limits || {});
  s.hotelDays = s.hotelDays || {};
  ['purchases', 'moves', 'bills', 'subs'].forEach(k => { if (!Array.isArray(s[k])) s[k] = []; });
  if (!(raw && 'setup' in raw)) s.setup = !!(raw && (raw.purchases?.length || raw.bills?.length));
  return s;
}
function save(quiet) {
  state.updatedAt = new Date().toISOString();
  const json = JSON.stringify(state);
  try { localStorage.setItem(KEY, json); } catch (e) { toast('Could not save on this device'); }
  idb.set(KEY, json);
  if (!quiet) render();
}
async function load() {
  let a = null, b = null;
  try { a = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
  try { b = JSON.parse((await idb.get(KEY)) || 'null'); } catch {}
  let pick = a || b;
  if (a && b && (b.updatedAt || '') > (a.updatedAt || '')) pick = b;
  state = normalize(pick || clone(window.SEED));
  if (!pick) { state.createdAt = new Date().toISOString(); save(true); }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}

// ---------- the math (mirrors build_tracker.py formulas) ----------
function calc(s = state, today = todayISO()) {
  const { start, days } = s.period;
  const L = s.limits;
  const end = addDays(start, days - 1);
  const net = c => r2(s.moves.reduce((t, m) => t + (m.to === c ? +m.amt : 0) - (m.from === c ? +m.amt : 0), 0));
  const spentBy = (c, d) => r2(s.purchases.reduce((t, p) => t + (p.cat === c && (!d || p.date === d) ? +p.amt : 0), 0));
  const rows = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(start, i);
    const hotelY = (s.hotelDays[date] || 'Y').toUpperCase() === 'Y';
    const fb = +L.Food, fc = i === 0 ? net('Food') : rows[i - 1].foodLeft;
    const hb = hotelY ? +L.Hotel : 0, hc = i === 0 ? net('Hotel') : rows[i - 1].hotelLeft;
    const fa = r2(fb + fc), fs = spentBy('Food', date), ha = r2(hb + hc), hs = spentBy('Hotel', date);
    rows.push({ date, hotelY, foodBudget: fb, foodCarry: fc, foodAvail: fa, foodSpent: fs, foodLeft: r2(fa - fs),
      hotelBudget: hb, hotelCarry: hc, hotelAvail: ha, hotelSpent: hs, hotelLeft: r2(ha - hs), dayLeft: r2(fa - fs + ha - hs) });
  }
  const budget = {
    Food: r2(rows.reduce((t, r) => t + r.foodBudget, 0) + net('Food')),
    Hotel: r2(rows.reduce((t, r) => t + r.hotelBudget, 0) + net('Hotel')),
    Gas: r2(+L.Gas + net('Gas')),
    Other: r2(+L.Other + net('Other'))
  };
  const summary = {};
  CATS.forEach(c => { const sp = spentBy(c); summary[c] = { budget: budget[c], spent: sp, left: r2(budget[c] - sp), net: net(c) }; });
  const tot = { budget: r2(CATS.reduce((t, c) => t + summary[c].budget, 0)), spent: r2(CATS.reduce((t, c) => t + summary[c].spent, 0)) };
  tot.left = r2(tot.budget - tot.spent);
  const day = today < start ? start : today > end ? end : today;
  const idx = rows.findIndex(r => r.date === day);
  const sumB = list => ({ total: r2(list.reduce((t, b) => t + (+b.amt || 0), 0)), paid: r2(list.reduce((t, b) => t + (b.paid ? +b.amt || 0 : 0), 0)) });
  const bills = sumB(s.bills); bills.left = r2(bills.total - bills.paid);
  const subs = sumB(s.subs); subs.left = r2(subs.total - subs.paid);
  return { rows, summary, tot, day, idx, cur: rows[idx], start, end, today, bills, subs,
    phase: today < start ? 'before' : today > end ? 'after' : 'during' };
}
window.__calc = () => calc();

// ---------- UI helpers ----------
const ic = c => `<span class="ic" style="background:${META[c].tint}">${META[c].ic}</span>`;
const bar = (num, den, color) => { const p = den > 0 ? Math.max(0, Math.min(1, num / den)) : 0; return `<div class="bar"><i style="width:${(p * 100).toFixed(1)}%;background:${color}"></i></div>`; };
const savedBadge = () => `<span class="saved" title="Saved on this device"><i></i><span class="lg">Saved on this device</span><span class="sm">Saved</span></span>`;
let toastT;
function toast(msg, action, fn) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
  if (action) t.querySelector('button').onclick = () => { fn(); t.classList.remove('on'); };
  t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), action ? 5000 : 2400);
}
function openSheet(html, bind) {
  const sh = $('#sheet');
  sh.innerHTML = `<div class="grab"></div>${html}`;
  $('#backdrop').classList.add('on'); sh.classList.add('on');
  bind && bind(sh);
}
function closeSheet() { $('#sheet').classList.remove('on'); $('#backdrop').classList.remove('on'); }
$('#backdrop').onclick = closeSheet;

// ---------- tabs ----------
let tab = (location.hash || '#today').slice(1);
if (!['today', 'add', 'purchases', 'bills', 'daily'].includes(tab)) tab = 'today';
function go(t) {
  tab = t; history.replaceState(null, '', '#' + t);
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + t));
  render(); window.scrollTo(0, 0);
  if (t === 'add' && $('#amt')) { try { $('#amt').focus({ preventScroll: true }); } catch {} } // inside the tap, so iOS opens the keypad
}
document.querySelectorAll('.tab').forEach(b => b.onclick = () => go(b.dataset.tab));
window.addEventListener('hashchange', () => { const t = location.hash.slice(1); if (t && t !== tab && document.getElementById('page-' + t)) go(t); });

function render() {
  const c = calc();
  ({ today: rToday, add: rAdd, purchases: rPurchases, bills: rBills, daily: rDaily })[tab](c);
}

// ---------- TODAY ----------
function rWelcome() {
  $('#page-today').innerHTML = `
    <div class="welcome">
      <img src="icons/icon-192.png" alt="" class="wlogo">
      <h1>Welcome to Spending</h1>
      <p>Your purchases, bills, and limits live in a backup file. Import it once on this device and everything shows up.</p>
      <button class="btn" id="wImport">Import your backup</button>
      <button class="btn ghost" id="wFresh" style="margin-top:10px">Start from scratch</button>
      <div class="wsteps">
        <div><b>1</b><span>Tap <em>Import your backup</em>.</span></div>
        <div><b>2</b><span>Pick <em>Spending_starter_backup.json</em> (or your latest export) from Files, iCloud Drive, or Downloads.</span></div>
        <div><b>3</b><span>Done. It saves on this device. Nothing connects to your bank.</span></div>
      </div>
    </div>`;
  $('#wImport').onclick = () => $('#importFile').click();
  $('#wFresh').onclick = () => { state.setup = true; save(); toast('Starting fresh'); };
}
function rToday(c) {
  if (!state.setup) return rWelcome();
  const cur = c.cur, dayN = c.idx + 1, toPay = Math.round((parse(state.period.payday) - parse(c.today)) / 864e5);
  const sub = c.phase === 'before' ? `Tracker starts ${fmtDay(c.start, { month: 'short', day: 'numeric' })}`
    : c.phase === 'after' ? 'Period is over, showing the last day'
    : `Day ${dayN} of ${state.period.days} · ${toPay === 1 ? 'payday tomorrow' : toPay + ' days to payday'}`;
  const S = c.summary;
  const card = (cat, kind, left, avail, carryLbl, carry, extra = '') => `
    <div class="card cat">
      <div class="top">${ic(cat)}<span style="color:${META[cat].color}">${cat}</span></div>
      <div class="kind">${kind}</div>
      <div class="amt num${negc(left)}">${money(left)}</div>
      ${bar(left, avail, META[cat].color)}
      ${extra}
      <div class="carry"><span>${carryLbl}</span><b class="num${negc(carry)}">${money(carry)}</b></div>
    </div>`;
  const hotelExtra = `<div class="hotelq" style="margin-top:10px"><span>${cur.hotelY ? 'Hotel tonight' : 'No hotel tonight'}</span><button class="switch sm ${cur.hotelY ? 'on' : ''}" data-hotel="${cur.date}" aria-label="Hotel tonight"></button></div>`;
  const upcoming = state.subs.filter(s => !s.paid && isISO(s.due) && s.due >= c.today).sort((a, b) => a.due.localeCompare(b.due)).slice(0, 4);
  const unpaid = state.bills.filter(b => !b.paid);
  const ringP = c.bills.total > 0 ? c.bills.paid / c.bills.total : 0, R = 24, C = 2 * Math.PI * R;
  $('#page-today').innerHTML = `
    <div class="hdr"><div><div class="eyebrow">${fmtDay(c.today, { weekday: 'long' })}</div><h1>${fmtDay(c.today, { month: 'long', day: 'numeric' })}</h1><p>${sub}</p></div>${savedBadge()}</div>
    <div class="hero">
      <div class="lbl">Total left · Oct 30 – Nov 12</div>
      <div class="big num${negc(c.tot.left)}">${money(c.tot.left)}</div>
      ${bar(c.tot.left, c.tot.budget, '#fff')}
      <div class="row"><span>Spent <b class="num">${money(c.tot.spent)}</b></span><span>Budget <b class="num">${money(c.tot.budget)}</b></span></div>
    </div>
    <div class="sec">Your money ${c.phase === 'during' ? 'today' : 'on ' + fmtDay(c.day)}</div>
    <div class="grid2 cats">
      ${card('Food', 'Left today', cur.foodLeft, cur.foodAvail, 'Carried in', cur.foodCarry)}
      ${card('Hotel', 'Left tonight', cur.hotelLeft, cur.hotelAvail, 'Carried in', cur.hotelCarry, hotelExtra)}
      ${card('Gas', 'Left · 2 weeks', S.Gas.left, S.Gas.budget, 'Carried in', S.Gas.net)}
      ${card('Other', 'Left · 2 weeks', S.Other.left, S.Other.budget, 'Carried in', S.Other.net)}
    </div>
    <div class="wide2">
      <div class="stack" style="margin-top:12px">
        <button class="card billcard" style="width:100%;text-align:left" data-go="bills">
          <svg class="ring" viewBox="0 0 56 56"><circle cx="28" cy="28" r="${R}" fill="none" stroke="var(--fill)" stroke-width="7"/>
            <circle cx="28" cy="28" r="${R}" fill="none" stroke="var(--good)" stroke-width="7" stroke-linecap="round" stroke-dasharray="${(C * ringP).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 28 28)"/>
            <text x="28" y="33" text-anchor="middle" font-size="14" font-weight="800" fill="var(--ink)" font-family="-apple-system,system-ui">${Math.round(ringP * 100)}%</text></svg>
          <div class="t"><div class="muted" style="font-size:13px;font-weight:600">Bills left to pay</div>
            <div class="amt num${c.bills.left > 0 ? '' : ' pos'}">${money(c.bills.left)}</div>
            <div class="muted" style="font-size:13px">${unpaid.length ? unpaid.length + ' unpaid · ' : 'All ' + state.bills.length + ' bills paid · '}Paid <span class="num">${money(c.bills.paid)}</span></div></div>
          <span class="chev">›</span>
        </button>
      </div>
      <div class="stack" style="margin-top:12px">
        <div class="card upnext">
          <div style="font-size:13px;font-weight:600;color:var(--sub);margin-bottom:10px">Subscriptions coming up</div>
          ${upcoming.length ? upcoming.map(s => `<div class="item"><span><span class="due ${daysTo(s.due, c.today) <= 3 ? 'soon' : ''}">${fmtDay(s.due, { month: 'short', day: 'numeric' })}</span>${esc(s.name)}</span><b class="num">${s.amt == null ? '—' : money(s.amt)}</b></div>`).join('') : '<div class="muted" style="font-size:15px">Nothing dated coming up.</div>'}
        </div>
      </div>
    </div>
    <p class="foot">Food and hotel money you don't spend rolls into the next day. Gas and Other are for the whole 2 weeks, so their Carried in is whatever you've moved there. Move money between them on the Daily tab.</p>`;
}
const daysTo = (d, t) => Math.round((parse(d) - parse(t)) / 864e5);

// ---------- ADD / EDIT ----------
let draft = { cat: 'Food' };
function formHTML(p, mode) {
  const c = calc();
  return `
    <div class="card amountbox"><label for="amt">Amount</label>
      <div class="amountwrap"><span>$</span><input id="amt" inputmode="decimal" enterkeyhint="done" autocomplete="off" placeholder="0.00" value="${p.amt != null && p.amt !== '' ? esc(p.amt) : ''}"></div></div>
    <div class="sec">Category</div>
    <div class="catpick">${CATS.map(k => {
      const left = k === 'Food' ? c.cur.foodLeft : k === 'Hotel' ? c.cur.hotelLeft : c.summary[k].left;
      return `<button class="catbtn ${p.cat === k ? 'on' : ''}" data-cat="${k}" style="${p.cat === k ? 'color:' + META[k].color : ''}">${ic(k)}<span>${k}</span><small class="num${negc(left)}">${money(left)} left</small></button>`;
    }).join('')}</div>
    <div class="sec">Details</div>
    <div class="list">
      <div class="field"><label for="note">Note</label><input id="note" placeholder="What was it?" value="${esc(p.note || '')}" autocomplete="off" enterkeyhint="done"></div>
      <div class="field"><label for="date">Date</label><input id="date" type="date" value="${esc(p.date)}" min="${c.start}" max="${c.end}"></div>
    </div>
    <div style="margin-top:18px">${mode === 'edit'
      ? `<div class="btnrow"><button class="btn danger" id="del">Delete</button><button class="btn" id="saveP">Save</button></div>`
      : `<button class="btn" id="saveP" disabled>Add purchase</button>`}</div>
    ${mode === 'add' ? `<div class="hint">Saved right away on this device.</div>` : ''}`;
}
function bindForm(root, p, onSave, onDel) {
  const amt = root.querySelector('#amt'), btn = root.querySelector('#saveP');
  const ctx = document.createElement('canvas').getContext('2d');
  const fit = () => { const cs = getComputedStyle(amt); ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    amt.style.width = Math.ceil(ctx.measureText(amt.value || amt.placeholder).width + 6) + 'px'; };
  const valid = () => { fit(); const v = parseFloat(amt.value.replace(/[^0-9.]/g, '')); btn.disabled = !(v > 0); return v; };
  amt.addEventListener('input', () => { const cleaned = amt.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'); if (cleaned !== amt.value) amt.value = cleaned; p.amt = amt.value; valid(); });
  root.querySelector('#note').addEventListener('input', e => p.note = e.target.value);
  root.querySelector('#date').addEventListener('change', e => p.date = e.target.value || todayISO());
  root.querySelectorAll('.catbtn').forEach(b => b.onclick = () => {
    p.cat = b.dataset.cat;
    root.querySelectorAll('.catbtn').forEach(x => { const on = x.dataset.cat === p.cat; x.classList.toggle('on', on); x.style.color = on ? META[x.dataset.cat].color : ''; });
  });
  [amt, root.querySelector('#note')].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter' && !btn.disabled) btn.click(); }));
  btn.onclick = () => { const v = valid(); if (!(v > 0)) return; onSave({ ...p, amt: r2(v) }); };
  if (onDel) root.querySelector('#del').onclick = onDel;
  valid();
}
function rAdd() {
  const c = calc();
  if (!draft.date) draft.date = c.phase === 'during' ? c.today : c.day;
  const el = $('#page-add');
  el.innerHTML = `<div class="hdr"><div><h1>Add purchase</h1><p>Type it in, pick a category, done.</p></div></div>` + formHTML(draft, 'add');
  bindForm(el, draft, p => {
    const rec = { id: uid(), date: p.date, cat: p.cat, amt: p.amt, note: (p.note || '').trim() };
    state.purchases.push(rec);
    draft = { cat: p.cat };
    save(true); go('today');
    toast(`Added ${money(rec.amt)} to ${rec.cat}`, 'Undo', () => { state.purchases = state.purchases.filter(x => x.id !== rec.id); save(); });
  });
}
function editPurchase(id) {
  const orig = state.purchases.find(x => x.id === id); if (!orig) return;
  const p = { ...orig };
  openSheet(`<h2>Edit purchase<button id="x">Cancel</button></h2>` + formHTML(p, 'edit'), sh => {
    sh.querySelector('#x').onclick = closeSheet;
    bindForm(sh, p, np => { Object.assign(orig, { date: np.date, cat: np.cat, amt: np.amt, note: (np.note || '').trim() }); closeSheet(); save(); toast('Purchase updated'); },
      () => { const i = state.purchases.indexOf(orig); state.purchases.splice(i, 1); closeSheet(); save();
        toast('Purchase deleted', 'Undo', () => { state.purchases.splice(i, 0, orig); save(); }); });
  });
}

// ---------- PURCHASES ----------
let pFilter = 'All';
function rPurchases(c) {
  const list = state.purchases.filter(p => pFilter === 'All' || p.cat === pFilter)
    .slice().sort((a, b) => b.date.localeCompare(a.date) || state.purchases.indexOf(b) - state.purchases.indexOf(a));
  const total = r2(list.reduce((t, p) => t + +p.amt, 0));
  const groups = {};
  list.forEach(p => (groups[p.date] = groups[p.date] || []).push(p));
  $('#page-purchases').innerHTML = `
    <div class="hdr"><div><h1>Purchases</h1><p>${list.length} ${list.length === 1 ? 'purchase' : 'purchases'} · <span class="num">${money(total)}</span></p></div>${savedBadge()}</div>
    <div class="chips">${['All', ...CATS].map(k => `<button class="chip ${pFilter === k ? 'on' : ''}" data-f="${k}">${k === 'All' ? 'All' : META[k].ic + ' ' + k}</button>`).join('')}</div>
    ${list.length ? Object.keys(groups).map(d => {
      const g = groups[d], dt = r2(g.reduce((t, p) => t + +p.amt, 0));
      return `<div class="dayhead"><span>${d === c.today ? 'Today · ' : ''}${fmtDay(d)}</span><b>${money(dt)}</b></div>
      <div class="list">${g.map(p => `<button class="li" data-edit="${p.id}">${ic(p.cat)}<div class="main"><div class="t1">${esc(p.note || p.cat)}</div><div class="t2">${p.cat}</div></div><div class="r num">${money(p.amt)}</div></button>`).join('')}</div>`;
    }).join('') : `<div class="card empty" style="margin-top:14px"><div class="e">🧾</div>No purchases here yet.</div>`}
    <p class="foot">Tap a purchase to edit or delete it.</p>`;
}

// ---------- BILLS ----------
function dueTag(due, today) {
  if (!due) return '';
  if (!isISO(due)) return `<span class="due late">${esc(due)}</span>`;
  const n = daysTo(due, today);
  return `<span class="due ${n < 0 ? 'late' : n <= 3 ? 'soon' : ''}">${fmtDay(due, { month: 'short', day: 'numeric' })}</span>`;
}
function billSection(kind, title, lbls, s, c) {
  const list = state[kind];
  return `
    <div class="sec">${title}<button data-addbill="${kind}">+ Add</button></div>
    <div class="card sum3">
      <div><div class="l">${lbls[0]}</div><div class="v num">${money(s.total)}</div></div>
      <div><div class="l">${lbls[1]}</div><div class="v num pos">${money(s.paid)}</div></div>
      <div><div class="l">${lbls[2]}</div><div class="v num${s.left > 0 ? '' : ' pos'}">${money(s.left)}</div></div>
    </div>
    <div class="list" style="margin-top:12px">${list.map(b => `
      <div class="li ${b.paid ? 'done' : ''}">
        <button class="check ${b.paid ? 'on' : ''}" data-paid="${kind}:${b.id}" aria-label="${b.paid ? 'Mark not paid' : 'Mark paid'}"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <button class="body" data-editbill="${kind}:${b.id}"><div class="main"><div class="t1">${esc(b.name)}</div><div class="t2">${b.paid ? (b.due ? `<span class="due">${isISO(b.due) ? fmtDay(b.due, { month: 'short', day: 'numeric' }) : esc(b.due)}</span>` : '') : dueTag(b.due, c.today)}${esc(b.note)}</div></div>
          <div class="r num">${b.amt == null || b.amt === '' ? '<span class="muted">Add $</span>' : money(b.amt)}</div></button>
      </div>`).join('')}</div>`;
}
function rBills(c) {
  $('#page-bills').innerHTML = `
    <div class="hdr"><div><h1>Bills</h1><p>Tap the circle once it has gone through.</p></div>${savedBadge()}</div>
    <div class="wide2"><div>${billSection('bills', 'Bills', ['Total', 'Paid', 'Still to pay'], c.bills, c)}</div>
    <div>${billSection('subs', 'Subscriptions', ['Per month', 'Charged', 'Still to come'], c.subs, c)}</div></div>
    <p class="foot">Tap a bill's name to change its amount, due date, or note.</p>`;
}
function editBill(kind, id) {
  const isNew = !id;
  const orig = isNew ? { id: uid(), name: '', amt: null, due: '', note: '', paid: false } : state[kind].find(x => x.id === id);
  if (!orig) return;
  const b = { ...orig };
  const dueIsDate = isISO(b.due);
  openSheet(`<h2>${isNew ? 'New ' + (kind === 'bills' ? 'bill' : 'subscription') : 'Edit ' + esc(b.name)}<button id="x">Cancel</button></h2>
    <div class="list">
      <div class="field"><label>Name</label><input id="bn" value="${esc(b.name)}" placeholder="Name"></div>
      <div class="field"><label>Amount</label><input id="ba" inputmode="decimal" value="${b.amt ?? ''}" placeholder="0.00"></div>
      <div class="field"><label>Due</label><input id="bd" type="date" value="${dueIsDate ? b.due : ''}"></div>
      <div class="field"><label>Or</label><input id="bt" value="${dueIsDate ? '' : esc(b.due)}" placeholder="Past due, Overdue…"></div>
      <div class="field"><label>Note</label><input id="bo" value="${esc(b.note)}" placeholder="Optional"></div>
    </div>
    <div style="margin-top:18px" class="${isNew ? '' : 'btnrow'}">${isNew ? '' : '<button class="btn danger" id="del">Delete</button>'}<button class="btn" id="ok">Save</button></div>`, sh => {
    sh.querySelector('#x').onclick = closeSheet;
    sh.querySelector('#ok').onclick = () => {
      const name = sh.querySelector('#bn').value.trim(); if (!name) { sh.querySelector('#bn').focus(); return; }
      const a = sh.querySelector('#ba').value.replace(/[^0-9.]/g, '');
      Object.assign(orig, { name, amt: a === '' ? null : r2(a), due: sh.querySelector('#bd').value || sh.querySelector('#bt').value.trim(), note: sh.querySelector('#bo').value.trim() });
      if (isNew) state[kind].push(orig);
      closeSheet(); save(); toast('Saved');
    };
    if (!isNew) sh.querySelector('#del').onclick = () => { const i = state[kind].indexOf(orig); state[kind].splice(i, 1); closeSheet(); save();
      toast(`${orig.name} deleted`, 'Undo', () => { state[kind].splice(i, 0, orig); save(); }); };
  });
}

// ---------- DAILY ----------
let mv = { from: 'Hotel', to: 'Other' };
function rDaily(c) {
  const S = c.summary;
  const opt = sel => CATS.map(k => `<option ${sel === k ? 'selected' : ''}>${k}</option>`).join('');
  $('#page-daily').innerHTML = `
    <div class="hdr"><div><h1>Daily</h1><p>Summary, limits, money moves, and every day.</p></div>${savedBadge()}</div>
    <div class="dailygrid">
    <div class="da">
      <div class="sec">Summary</div>
      <div class="card"><table class="tbl"><thead><tr><th>Category</th><th>Budget</th><th>Spent</th><th>Left</th></tr></thead><tbody>
        ${CATS.map(k => `<tr><td><span class="dot" style="background:${META[k].color}"></span>${k}</td><td>${money(S[k].budget)}</td><td>${money(S[k].spent)}</td><td class="${S[k].left < 0 ? 'neg' : 'pos'}"><b>${money(S[k].left)}</b></td></tr>`).join('')}
        <tr class="tot"><td>Total</td><td>${money(c.tot.budget)}</td><td>${money(c.tot.spent)}</td><td class="${c.tot.left < 0 ? 'neg' : 'pos'}">${money(c.tot.left)}</td></tr>
      </tbody></table></div>
      <p class="foot">${esc(state.limitsNote || '')}</p>

      <div class="sec">Move money</div>
      <div class="card">
        <div class="mv"><select class="sel" id="mvf" aria-label="From">${opt(mv.from)}</select><span class="arrow">→</span><select class="sel" id="mvt" aria-label="To">${opt(mv.to)}</select></div>
        <div class="mvamt"><input id="mva" inputmode="decimal" placeholder="$0.00" aria-label="Amount"><button class="btn" id="mvgo">Move</button></div>
        <div class="hint" id="mvhint"></div>
      </div>
      ${state.moves.length ? `<div class="list" style="margin-top:12px">${state.moves.map(m => `<div class="li">${ic(m.to)}<div class="main"><div class="t1">${m.from} → ${m.to}</div><div class="t2">${m.when ? new Date(m.when).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'Move'}</div></div><div class="r num">${money(m.amt)}</div><button class="chip" style="box-shadow:none;background:var(--bad-t);color:var(--bad);padding:6px 12px" data-delmove="${m.id}">Delete</button></div>`).join('')}</div>`
        : `<p class="foot">No moves yet. Moving takes money out of one budget and adds it to another. Food and hotel moves go into day 1, so they roll forward.</p>`}
    </div>
    <div class="dc">

      <div class="sec">Limits</div>
      <div class="list limits">
        ${[['Food', 'Food', 'per day'], ['Hotel', 'Hotel', 'per night'], ['Gas', 'Gas', '2 weeks'], ['Other', 'Other', '2 weeks']].map(([k, l, u]) =>
          `<div class="field"><label><span class="dot" style="background:${META[k].color}"></span>${l}</label><input data-limit="${k}" inputmode="decimal" value="${state.limits[k]}"><span class="u">${u}</span></div>`).join('')}
      </div>

      <div class="sec">Backup &amp; sync</div>
      <div class="card">
        <div style="font-size:15px;line-height:1.45">Your data saves on this device automatically. To move it to your Mac or iPhone, export a backup here and import it on the other device.</div>
        <div class="btnrow" style="margin-top:14px"><button class="btn ghost" id="exp">Export backup</button><button class="btn ghost" id="imp">Import backup</button></div>
        <div class="hint">Last saved ${state.updatedAt ? new Date(state.updatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'}</div>
        <button class="btn danger" id="reset" style="margin-top:14px;height:46px;font-size:15px">Erase data on this device</button>
      </div>
    </div>
    <div class="db">
      <div class="sec">Every day</div>
      <div class="card" style="padding:0;overflow:hidden"><div class="daysgrid">${c.rows.map(r => `
        <div class="day ${r.date === c.day ? 'today' : ''} ${r.date < c.day ? 'past' : ''}">
          <div class="dh"><span class="d">${fmtDay(r.date)}${r.date === c.day ? '<em>TODAY</em>' : ''}</span>
            <span class="hq">Hotel <button class="switch sm ${r.hotelY ? 'on' : ''}" data-hotel="${r.date}" aria-label="Hotel ${r.date}"></button></span></div>
          <div class="cols">
            <div class="c"><div class="k" style="color:var(--food)">Food left</div><div class="v${negc(r.foodLeft)}">${money(r.foodLeft)}</div><div class="s">In ${money(r.foodCarry)}<br>Spent ${money(r.foodSpent)}</div></div>
            <div class="c ${r.hotelY ? '' : 'off'}"><div class="k" style="color:var(--hotel)">Hotel left</div><div class="v${negc(r.hotelLeft)}">${money(r.hotelLeft)}</div><div class="s">In ${money(r.hotelCarry)}<br>Spent ${money(r.hotelSpent)}</div></div>
            <div class="c"><div class="k">Day left</div><div class="v${negc(r.dayLeft)}">${money(r.dayLeft)}</div><div class="s">Food + hotel<br>&nbsp;</div></div>
          </div>
        </div>`).join('')}</div></div>
      <p class="foot">"In" is the money carried in from the day before. Leftovers (or overspending) roll into the next day. Flip Hotel off for nights with no hotel.</p>
    </div>
    </div>`;
  const f = $('#mvf'), t = $('#mvt'), a = $('#mva'), h = $('#mvhint');
  const leftOf = k => k === 'Food' ? c.cur.foodLeft : k === 'Hotel' ? c.cur.hotelLeft : S[k].left;
  const hint = () => { mv.from = f.value; mv.to = t.value; h.innerHTML = f.value === t.value ? 'Pick two different categories.' : `${f.value} has <b class="num${negc(leftOf(f.value))}">${money(leftOf(f.value))}</b> left ${f.value === 'Food' || f.value === 'Hotel' ? 'today' : 'for 2 weeks'}.`; };
  f.onchange = t.onchange = hint; hint();
  $('#mvgo').onclick = () => {
    const v = r2(a.value.replace(/[^0-9.]/g, ''));
    if (!(v > 0) || f.value === t.value) { a.focus(); return; }
    state.moves.push({ id: uid(), from: f.value, to: t.value, amt: v, when: new Date().toISOString() }); save();
    toast(`Moved ${money(v)} from ${mv.from} to ${mv.to}`);
  };
  document.querySelectorAll('[data-limit]').forEach(i => i.onchange = () => {
    const v = r2(i.value.replace(/[^0-9.]/g, '')); state.limits[i.dataset.limit] = v; save(); toast(`${i.dataset.limit} limit set to ${money(v, { cents: v % 1 !== 0 })}`);
  });
  $('#exp').onclick = exportData; $('#imp').onclick = () => $('#importFile').click();
  $('#reset').onclick = () => { if (confirm('Erase everything on this device? Export a backup first if you want to keep it.')) { state = normalize(clone(window.SEED)); state.setup = false; save(true); go('today'); toast('Erased. Import a backup to start again.'); } };
}

// ---------- backup ----------
async function exportData() {
  const name = `Spending-backup-${todayISO()}.json`;
  const blob = new Blob([JSON.stringify({ app: 'spending-tracker', exportedAt: new Date().toISOString(), data: state }, null, 2)], { type: 'application/json' });
  try {
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] }) && /iPhone|iPad|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document) {
      await navigator.share({ files: [file], title: 'Spending backup' }); return;
    }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast('Backup saved to Downloads');
}
$('#importFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const j = JSON.parse(await f.text()); const d = j.data || j;
    if (!d.period || !Array.isArray(d.purchases)) throw new Error('bad');
    const when = d.updatedAt ? new Date(d.updatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'unknown time';
    if (state.setup && !confirm(`Replace the data on this device with the backup from ${when}? (${d.purchases.length} purchases)`)) return;
    state = normalize(d); state.setup = true; save(true); go('today'); toast(`Backup imported · ${state.purchases.length} purchases, ${state.bills.length} bills`);
  } catch { toast("That file isn't a Spending backup"); }
};

// ---------- global clicks ----------
document.addEventListener('click', e => {
  const t = e.target.closest('[data-hotel],[data-go],[data-f],[data-edit],[data-paid],[data-editbill],[data-addbill],[data-delmove]');
  if (!t) return;
  const d = t.dataset;
  if (d.hotel) { const cur = (state.hotelDays[d.hotel] || 'Y') === 'Y'; state.hotelDays[d.hotel] = cur ? 'N' : 'Y'; save(); toast(`${fmtDay(d.hotel)}: ${cur ? 'no hotel' : 'hotel night'}`); }
  else if (d.go) go(d.go);
  else if (d.f) { pFilter = d.f; render(); }
  else if (d.edit) editPurchase(d.edit);
  else if (d.paid) { const [k, id] = d.paid.split(':'); const b = state[k].find(x => x.id === id); b.paid = !b.paid; save(); }
  else if (d.editbill) { const [k, id] = d.editbill.split(':'); editBill(k, id); }
  else if (d.addbill) editBill(d.addbill, null);
  else if (d.delmove) { const i = state.moves.findIndex(m => m.id === d.delmove); const m = state.moves.splice(i, 1)[0]; save(); toast('Move deleted', 'Undo', () => { state.moves.splice(i, 0, m); save(); }); }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
// Keep "today" fresh if the app stays open past midnight or comes back from the background.
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
window.addEventListener('storage', e => { if (e.key === KEY) { load().then(render); } });

load().then(() => { go(tab); window.__ready = true; });
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
