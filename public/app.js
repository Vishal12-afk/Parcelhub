'use strict';
// ParcelHub web app: one page, three roles (resident, staff, admin).
// All user text is passed through esc() before it goes into the page.

const root = document.getElementById('app');
const modalRoot = document.getElementById('modal');
const toastEl = document.getElementById('toast');

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};

let token = store.get('ph_token');
let me = null;
const state = {
  tab: null,
  login: { step: 'phone', phone: '', isNew: false, devOtp: null },
  parcels: [], trusted: [],
  list: { status: 'received', q: '' },
  desk: { parcel: null, notFound: null },
  stats: null, staff: [], messages: [],
};
let pollTimer = null;
let modalCleanup = null;

// ---- helpers ----------------------------------------------------------------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATUS = { expected: 'On the way', received: 'At the hub', handed_over: 'Collected', refused: 'Refused', returned: 'Returned' };

function fmt(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
}

function localInput(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Only ever link to the video rooms our server creates.
const safeLink = (u) => (/^https:\/\/meet\.jit\.si\/[A-Za-z0-9\-_]+$/.test(u || '') ? u : '#');

let toastTimer;
function toast(msg, bad) {
  toastEl.textContent = msg;
  toastEl.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = ''; }, 3500);
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (token) opts.headers.Authorization = 'Bearer ' + token;
  if (body instanceof FormData) opts.body = body;
  else if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(url, opts); } catch { throw new Error('No connection. Check your internet and try again.'); }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && token) { signOut(); throw new Error('Please sign in again'); }
  if (!res.ok) { const e = new Error((data && data.error) || 'Something went wrong'); e.data = data; throw e; }
  return data;
}

function openModal(html, onClose) {
  closeModal();
  modalCleanup = onClose || null;
  modalRoot.innerHTML = `<div class="overlay"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
}
function closeModal() {
  if (modalCleanup) { try { modalCleanup(); } catch { /* ignore */ } modalCleanup = null; }
  modalRoot.innerHTML = '';
}

function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

function signOut() {
  stopPoll(); closeModal();
  token = null; me = null;
  store.del('ph_token');
  state.login = { step: 'phone', phone: '', isNew: false, devOtp: null };
  render();
}

// ---- login ------------------------------------------------------------------

function renderLogin() {
  const l = state.login;
  const body = l.step === 'phone'
    ? `<form data-form="otp-request">
         <label for="phone">Mobile number</label>
         <input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="98765 43210" required autofocus>
         <button class="primary block">Send login code</button>
       </form>`
    : `<form data-form="otp-verify">
         <p class="muted">We sent a 6-digit code to +${esc(l.phone)}.</p>
         ${l.devOtp ? `<div class="note">Development mode: your code is <b>${esc(l.devOtp)}</b></div>` : ''}
         <label for="code">Login code</label>
         <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="\\d{6}" required autofocus>
         ${l.isNew ? `
           <p class="muted small" style="margin-top:14px">First time here? Tell us who you are.</p>
           <label for="name">Your name</label><input id="name" name="name" autocomplete="name" required>
           <label for="flat">Flat or desk number</label><input id="flat" name="flat" placeholder="A-402" required>
           <label for="join">Society code</label><input id="join" name="join_code" placeholder="Ask your society office" required>` : ''}
         <button class="primary block">${l.isNew ? 'Create account' : 'Sign in'}</button>
         <button type="button" class="link" data-action="login-back">Use a different number</button>
       </form>`;
  root.innerHTML = `<div class="login"><h1>ParcelHub</h1>
    <p class="muted">Your parcels, collected when you are ready.</p>${body}</div>`;
}

// ---- shell ------------------------------------------------------------------

function tabsFor(role) {
  if (role === 'resident') return [['parcels', 'My parcels'], ['add', 'Add parcel'], ['trusted', 'Trusted people'], ['account', 'Account']];
  const t = [['desk', 'Desk'], ['list', 'All parcels']];
  if (role === 'admin') t.push(['dash', 'Dashboard'], ['team', 'Staff & settings'], ['msgs', 'Messages']);
  return t;
}

function shell(body) {
  const tabs = tabsFor(me.role)
    .map(([id, label]) => `<button class="tab ${state.tab === id ? 'on' : ''}" data-action="tab" data-tab="${id}">${label}</button>`)
    .join('');
  return `<header class="top">
      <div class="brand"><strong>ParcelHub</strong><span class="muted small">${esc(me.society.name)} · ${esc(me.name)}${me.flat ? ' · ' + esc(me.flat) : ''}</span></div>
      <button class="link" data-action="signout">Sign out</button>
    </header>
    <nav class="tabs" aria-label="Sections">${tabs}</nav>
    <main>${body}</main>`;
}

async function go(tab) {
  stopPoll();
  state.tab = tab;
  try {
    if (tab === 'parcels') state.parcels = await api('GET', '/api/resident/parcels');
    if (tab === 'add') { /* no data needed */ }
    if (tab === 'trusted') state.trusted = await api('GET', '/api/resident/trusted');
    if (tab === 'list') state.parcels = await api('GET', `/api/staff/parcels?status=${encodeURIComponent(state.list.status)}&q=${encodeURIComponent(state.list.q)}`);
    if (tab === 'dash') state.stats = await api('GET', '/api/admin/stats');
    if (tab === 'team') { state.staff = await api('GET', '/api/admin/staff'); state.stats = await api('GET', '/api/admin/stats'); }
    if (tab === 'msgs') state.messages = await api('GET', '/api/admin/messages');
  } catch (err) { toast(err.message, true); }
  render();
}

function render() {
  if (!token || !me) return renderLogin();
  const views = {
    parcels: viewParcels, add: viewAdd, trusted: viewTrusted, account: viewAccount,
    desk: viewDesk, list: viewList, dash: viewDash, team: viewTeam, msgs: viewMsgs,
  };
  root.innerHTML = shell((views[state.tab] || (() => ''))());
  if (state.tab === 'desk') maybePoll();
}

// ---- resident views ---------------------------------------------------------

function slotLine(p) {
  if (!p.slot_start) return '<span class="muted">No pickup time chosen yet</span>';
  const who = p.collector === 'trusted' ? esc(p.trusted_name || 'Trusted person') : 'You';
  return `Pickup: <b>${esc(fmt(p.slot_start))}</b> · ${who}`;
}

function residentCard(p) {
  const open = p.status === 'expected' || p.status === 'received';
  let live = '';
  if (p.open_box && p.check_status === 'pending') {
    live = `<div class="alert"><b>Live check needed now.</b> The courier is at the hub. Join the video call, look at the item, then approve or reject.
      <div class="row" style="margin-top:10px">
        <a class="btn primary" href="${esc(safeLink(p.video_link))}" target="_blank" rel="noopener noreferrer">Join video</a>
        <button data-action="check" data-id="${p.id}" data-decision="approve">Approve</button>
        <button class="danger" data-action="check" data-id="${p.id}" data-decision="reject">Reject</button>
      </div></div>`;
  } else if (p.open_box && p.check_status === 'approved' && p.status === 'expected') {
    live = '<p class="small muted">You approved the open-box check. The hub is accepting the parcel.</p>';
  } else if (p.open_box && p.check_status === 'rejected') {
    live = '<p class="small error">You rejected this parcel. It is going back to the courier.</p>';
  }
  const code = p.handover_code
    ? `<div class="code" aria-label="Handover code">${esc(p.handover_code)}</div><p class="small muted">Show this code at the hub desk to collect.</p>`
    : (p.status === 'received' && p.collector === 'trusted' ? `<p class="small muted">${esc(p.trusted_name)} has the collection code.</p>` : '');
  const history = p.status === 'handed_over' ? `<p class="small muted">Collected ${esc(fmt(p.handed_over_at))} by ${esc(p.handed_over_to)}</p>` : '';
  return `<article class="card">
    <div class="spread"><div><h3>${esc(p.tracking_id)}</h3><span class="muted small">${esc(p.courier || 'Courier not set')}${p.value ? ' · ₹' + esc(p.value) : ''}</span></div>
      <div class="row"><span class="chip ${p.status}">${STATUS[p.status]}</span>${p.open_box ? '<span class="chip flag">Open-box</span>' : ''}</div></div>
    ${open ? `<p style="margin-top:10px">${slotLine(p)}</p>` : ''}
    ${live}${code}${history}
    <div class="row" style="margin-top:10px">
      ${open ? `<button class="primary" data-action="slot" data-id="${p.id}">${p.slot_start ? 'Change pickup time' : 'Choose pickup time'}</button>` : ''}
      ${p.has_photo ? `<button class="ghost" data-action="photo" data-url="/api/resident/parcels/${p.id}/photo">View photo</button>` : ''}
      ${p.status === 'expected' && p.check_status === 'none' ? `<button class="ghost" data-action="remove" data-id="${p.id}">Remove</button>` : ''}
    </div></article>`;
}

function viewParcels() {
  if (!state.parcels.length) return '<div class="empty"><h3>No parcels yet</h3><p>Add a tracking ID under “Add parcel”, so we can expect it.</p></div>';
  return state.parcels.map(residentCard).join('');
}

function viewAdd() {
  return `<form class="card" data-form="add-parcel">
    <h2>Add an expected parcel</h2>
    <p class="muted small">Order using your hub address (see Account), then add the tracking ID here.</p>
    <label for="t">Tracking ID / AWB</label><input id="t" name="tracking_id" required autocapitalize="characters" placeholder="e.g. DEL1234567">
    <label for="c">Courier</label>
    <select id="c" name="courier"><option value="">Not sure</option><option>Amazon</option><option>Flipkart / Ekart</option><option>Delhivery</option><option>Blue Dart</option><option>DTDC</option><option>India Post</option><option>Other</option></select>
    <label for="v">Item value (₹)</label><input id="v" name="value" type="number" min="0" inputmode="numeric" placeholder="1500">
    <label class="check"><input type="checkbox" name="open_box"> Open-box delivery (I want to check the item live)</label>
    <p class="note">Parcels above ₹${esc(me.value_limit)} always get a live video check before the hub accepts them.</p>
    <button class="primary block">Add parcel</button></form>`;
}

function viewTrusted() {
  const list = state.trusted.length
    ? state.trusted.map((t) => `<div class="card spread"><div><b>${esc(t.name)}</b><br><span class="muted small">+${esc(t.phone)}</span></div><button class="ghost" data-action="del-trusted" data-id="${t.id}">Remove</button></div>`).join('')
    : '<p class="muted">No trusted people yet.</p>';
  return `<form class="card" data-form="add-trusted"><h2>Add a trusted person</h2>
      <p class="muted small">They get their own code by message and can collect your parcel when you choose them.</p>
      <label for="tn">Name</label><input id="tn" name="name" required>
      <label for="tp">Mobile number</label><input id="tp" name="phone" type="tel" inputmode="tel" required>
      <button class="primary block">Save</button></form>${list}`;
}

function viewAccount() {
  return `<div class="card"><h2>Your hub address</h2>
      <p class="muted small">Use this as the delivery address at checkout. Staff receive your parcel and the courier calls the hub, not you.</p>
      <p><b>${esc(me.delivery_address)}</b></p>
      <button class="ghost" data-action="copy-address">Copy address</button></div>
    <div class="card"><h2>Messages</h2>
      <p class="muted small">WhatsApp and SMS updates for your parcels: <b>${me.notify_opt_in ? 'On' : 'Off'}</b></p>
      <button class="ghost" data-action="toggle-notify">${me.notify_opt_in ? 'Turn off' : 'Turn on'}</button></div>`;
}

function openSlotModal(id) {
  const p = state.parcels.find((x) => x.id === id);
  if (!p) return;
  let start = p.slot_start ? new Date(p.slot_start) : new Date(Date.now() + 2 * 3600 * 1000);
  start = new Date(Math.ceil(start.getTime() / (15 * 60 * 1000)) * 15 * 60 * 1000);
  const trusted = state.trusted;
  openModal(`<form data-form="slot" data-id="${id}">
    <h2>Pickup time</h2><p class="muted small">${esc(p.tracking_id)}</p>
    <label for="when">Date and time</label>
    <input id="when" name="when" type="datetime-local" value="${localInput(start)}" min="${localInput(new Date())}" required>
    <label for="dur">Window</label>
    <select id="dur" name="duration"><option value="30">30 minutes</option><option value="60" selected>1 hour</option><option value="120">2 hours</option></select>
    <label>Who collects?</label>
    <label class="check"><input type="radio" name="collector" value="self" ${p.collector !== 'trusted' ? 'checked' : ''}> I will</label>
    <label class="check"><input type="radio" name="collector" value="trusted" ${p.collector === 'trusted' ? 'checked' : ''} ${trusted.length ? '' : 'disabled'}> A trusted person${trusted.length ? '' : ' (add one first)'}</label>
    ${trusted.length ? `<select name="trusted" aria-label="Trusted person">${trusted.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>` : ''}
    <div class="row" style="margin-top:16px"><button class="primary">Confirm</button><button type="button" class="ghost" data-action="closemodal">Cancel</button></div>
  </form>`);
}

// ---- staff views ------------------------------------------------------------

function deskCard(p) {
  const waiting = p.status === 'expected';
  let actions = '';
  if (waiting) {
    if (p.open_box && p.check_status === 'none') {
      actions = `<div class="alert"><b>Open-box parcel.</b> Start a live video check. The resident is messaged a link.
        <button class="primary block" data-action="startcheck" data-id="${p.id}">Start live check</button></div>`;
    } else if (p.open_box && p.check_status === 'pending') {
      actions = `<div class="alert"><b>Waiting for the resident to approve…</b>
        <p class="small">Open the video call, open the box in front of the camera and the courier.</p>
        <a class="btn primary" href="${esc(safeLink(p.video_link))}" target="_blank" rel="noopener noreferrer">Open video call</a></div>`;
    } else if (p.open_box && p.check_status === 'rejected') {
      actions = `<div class="alert"><b>Resident rejected this parcel.</b> Hand it back to the courier.
        <button class="danger block" data-action="refuse" data-id="${p.id}">Refuse parcel</button></div>`;
    }
    if (!p.open_box || p.check_status === 'approved') {
      actions += `<form data-form="receive" data-id="${p.id}">
        ${p.open_box ? '<p class="small muted">Resident approved the live check.</p>' : ''}
        <label for="ph">Photo of the parcel</label>
        <input id="ph" name="photo" type="file" accept="image/*" capture="environment" required>
        <button class="primary block">Mark received</button></form>`;
    }
  } else if (p.status === 'received') {
    const who = p.collector === 'trusted' && p.trusted ? `${esc(p.trusted.name)} (trusted person, +${esc(p.trusted.phone)})` : esc(p.resident.name);
    actions = `<form data-form="handover" data-id="${p.id}">
        <p class="small">Collector: <b>${who}</b>${p.collector === 'trusted' ? '. Check their ID.' : ''}</p>
        ${p.locked ? '<p class="error">Locked after too many wrong codes. An admin must reset it.</p>' : `
        <label for="hc">Handover code (ask the collector)</label>
        <input id="hc" name="code" inputmode="numeric" maxlength="6" pattern="\\d{6}" required autocomplete="off">
        <button class="primary block">Hand over</button>`}
      </form>
      <div class="row" style="margin-top:10px">
        ${me.role === 'admin' ? `<button class="ghost" data-action="resetcode" data-id="${p.id}">Reset code</button>` : ''}
        <button class="ghost" data-action="returnp" data-id="${p.id}">Return to courier</button>
      </div>`;
  } else if (p.status === 'refused') {
    actions = `<button class="ghost" data-action="returnp" data-id="${p.id}">Mark as returned</button>`;
  }
  return `<article class="card">
    <div class="spread"><div><h3>${esc(p.tracking_id)}</h3><span class="muted small">${esc(p.courier || 'Courier not set')}${p.value ? ' · ₹' + esc(p.value) : ''}</span></div>
      <div class="row"><span class="chip ${p.status}">${STATUS[p.status]}</span>${p.open_box ? '<span class="chip flag">Open-box</span>' : ''}</div></div>
    <p style="margin-top:8px"><b>${esc(p.resident.name)}</b> · ${esc(p.resident.flat || '')} · <a href="tel:+${esc(p.resident.phone)}">+${esc(p.resident.phone)}</a></p>
    ${p.slot_start ? `<p class="small">Pickup: <b>${esc(fmt(p.slot_start))}</b> · ${p.collector === 'trusted' && p.trusted ? esc(p.trusted.name) : 'Resident'}</p>` : ''}
    ${p.status === 'handed_over' ? `<p class="small muted">Handed over ${esc(fmt(p.handed_over_at))} to ${esc(p.handed_over_to)}</p>` : ''}
    ${actions}
    <div class="row" style="margin-top:10px">
      ${p.has_photo ? `<button class="ghost" data-action="photo" data-url="/api/staff/parcels/${p.id}/photo">View photo</button>` : ''}
      <button class="ghost" data-action="history" data-id="${p.id}">History</button>
    </div></article>`;
}

function viewDesk() {
  const d = state.desk;
  const scanBtn = 'BarcodeDetector' in window ? '<button type="button" class="ghost" data-action="scan">Scan</button>' : '';
  let result = '';
  if (d.parcel) result = deskCard(d.parcel);
  else if (d.notFound) {
    result = `<form class="card" data-form="register-walkin">
      <h3>Not registered yet</h3><p class="muted small">${esc(d.notFound.error)}</p>
      <input type="hidden" name="tracking_id" value="${esc(d.notFound.tracking)}">
      <label for="rp">Resident’s mobile number</label><input id="rp" name="resident_phone" type="tel" required>
      <label for="rc">Courier</label><input id="rc" name="courier" placeholder="Optional">
      <label for="rv">Item value (₹)</label><input id="rv" name="value" type="number" min="0" placeholder="Optional">
      <label class="check"><input type="checkbox" name="open_box"> Open-box delivery</label>
      <button class="primary block">Add for this resident</button></form>`;
  }
  return `<form class="card" data-form="lookup"><h2>Scan or type the tracking ID</h2>
      <div class="row"><input name="tracking_id" required autocapitalize="characters" placeholder="Tracking ID" value="${esc(d.parcel ? d.parcel.tracking_id : '')}" style="flex:1;min-width:0"><button class="primary">Find</button>${scanBtn}</div></form>${result}`;
}

function maybePoll() {
  stopPoll();
  const p = state.desk.parcel;
  if (!p || p.check_status !== 'pending') return;
  pollTimer = setInterval(async () => {
    if (state.tab !== 'desk' || !state.desk.parcel) return stopPoll();
    try {
      const fresh = await api('GET', '/api/staff/lookup?tracking_id=' + encodeURIComponent(state.desk.parcel.tracking_id));
      if (fresh.check_status !== state.desk.parcel.check_status) {
        state.desk.parcel = fresh; stopPoll(); render();
        toast(fresh.check_status === 'approved' ? 'Resident approved. You can accept the parcel.' : 'Resident rejected the parcel.');
      }
    } catch { /* try again on the next tick */ }
  }, 5000);
}

function viewList() {
  const filters = [['received', 'At hub'], ['expected', 'Expected'], ['handed_over', 'Collected'], ['', 'All']];
  const chips = filters.map(([v, l]) => `<button class="tab ${state.list.status === v ? 'on' : ''}" data-action="filter" data-status="${v}">${l}</button>`).join('');
  const rows = state.parcels.length
    ? state.parcels.map((p) => `<div class="card spread">
        <div><b>${esc(p.tracking_id)}</b> <span class="chip ${p.status}">${STATUS[p.status]}</span>
          <br><span class="muted small">${esc(p.resident.name)} · ${esc(p.resident.flat || '')}${p.slot_start ? ' · pickup ' + esc(fmt(p.slot_start)) : ''}</span></div>
        <button data-action="open" data-tracking="${esc(p.tracking_id)}">Open</button></div>`).join('')
    : '<div class="empty">Nothing here.</div>';
  return `<form class="card" data-form="search"><div class="row"><input name="q" placeholder="Search ID, name, flat or phone" value="${esc(state.list.q)}" style="flex:1;min-width:0"><button class="primary">Search</button></div></form>
    <div class="tabs" style="position:static">${chips}</div>${rows}`;
}

// ---- admin views ------------------------------------------------------------

function viewDash() {
  const s = state.stats;
  if (!s) return '<div class="empty">Loading…</div>';
  const tile = (n, l, warn) => `<div class="tile ${warn ? 'warn' : ''}"><b>${esc(n)}</b>${esc(l)}</div>`;
  return `<div class="tiles">
      ${tile(s.expected, 'On the way')}${tile(s.on_shelf, 'At the hub')}${tile(s.received_last_24h, 'Received in 24 h')}
      ${tile(s.handed_over, 'Collected')}${tile(s.overdue, `Unclaimed ${s.society.hold_days}+ days`, s.overdue > 0)}
      ${tile(s.avg_hours_to_handover == null ? '–' : s.avg_hours_to_handover + ' h', 'Avg hub time')}
      ${tile(s.residents, 'Residents')}${tile(s.messages_7d.sent, 'Messages sent (7 d)')}${tile(s.messages_7d.failed, 'Messages failed (7 d)', s.messages_7d.failed > 0)}
    </div>
    <div class="card"><p class="muted small">Residents sign up with society code <b>${esc(s.society.join_code)}</b>.</p></div>`;
}

function viewTeam() {
  const s = state.stats && state.stats.society;
  const people = state.staff.map((u) => `<div class="card spread"><div><b>${esc(u.name)}</b> <span class="chip expected">${esc(u.role)}</span><br><span class="muted small">+${esc(u.phone)}</span></div>
    ${u.role === 'staff' ? `<button class="ghost" data-action="del-staff" data-id="${u.id}">Remove</button>` : ''}</div>`).join('');
  return `${s ? `<form class="card" data-form="settings"><h2>Hub settings</h2>
      <label for="ha">Hub address (shown to residents)</label><input id="ha" name="hub_address" value="${esc(s.hub_address || '')}">
      <label for="hd">Days to hold a parcel</label><input id="hd" name="hold_days" type="number" min="1" max="60" value="${esc(s.hold_days)}">
      <label for="vl">Live check above this value (₹)</label><input id="vl" name="value_limit" type="number" min="0" value="${esc(s.value_limit)}">
      <button class="primary block">Save settings</button></form>` : ''}
    <form class="card" data-form="add-staff"><h2>Add hub staff</h2>
      <label for="sn">Name</label><input id="sn" name="name" required>
      <label for="sp">Mobile number</label><input id="sp" name="phone" type="tel" required>
      <button class="primary block">Add staff</button></form>${people}`;
}

function viewMsgs() {
  if (!state.messages.length) return '<div class="empty">No messages yet.</div>';
  return `<div class="card"><table><thead><tr><th>When</th><th>To</th><th>Type</th><th>Status</th></tr></thead><tbody>
    ${state.messages.map((m) => `<tr><td>${esc(fmt(m.created_at))}</td><td>+${esc(m.phone)}</td><td>${esc(m.template.replace(/_/g, ' '))}</td><td>${esc(m.status)}${m.error ? '<br><span class="small error">' + esc(m.error) + '</span>' : ''}</td></tr>`).join('')}
    </tbody></table></div>`;
}

// ---- barcode scanning -------------------------------------------------------

async function scan() {
  if (!('BarcodeDetector' in window)) return toast('Scanning is not supported in this browser. Type the ID instead.', true);
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); }
  catch { return toast('Allow camera access to scan', true); }
  let timer;
  const stop = () => { clearInterval(timer); stream.getTracks().forEach((t) => t.stop()); };
  openModal('<h2>Point at the barcode</h2><video id="cam" autoplay playsinline muted></video><button class="ghost block" data-action="closemodal">Cancel</button>', stop);
  const video = document.getElementById('cam');
  video.srcObject = stream;
  let detector;
  try { detector = new BarcodeDetector({ formats: ['code_128', 'code_39', 'ean_13', 'itf', 'codabar', 'qr_code'] }); }
  catch { detector = new BarcodeDetector(); }
  timer = setInterval(async () => {
    try {
      const found = await detector.detect(video);
      if (found.length) { const value = found[0].rawValue; closeModal(); await lookup(value); }
    } catch { /* keep trying */ }
  }, 300);
}

// ---- actions ----------------------------------------------------------------

async function lookup(tracking) {
  try {
    state.desk = { parcel: await api('GET', '/api/staff/lookup?tracking_id=' + encodeURIComponent(tracking)), notFound: null };
  } catch (err) {
    state.desk = { parcel: null, notFound: err.data && err.data.can_register ? { error: err.message, tracking: String(tracking).trim().toUpperCase() } : null };
    if (!state.desk.notFound) toast(err.message, true);
  }
  state.tab = 'desk';
  render();
}

async function refreshDesk(p) { state.desk = { parcel: p, notFound: null }; render(); }

const actions = {
  signout: () => signOut(),
  'login-back': () => { state.login = { step: 'phone', phone: '', isNew: false, devOtp: null }; render(); },
  tab: (d) => go(d.tab),
  closemodal: () => closeModal(),
  scan: () => scan(),
  filter: (d) => { state.list.status = d.status; return go('list'); },
  open: (d) => lookup(d.tracking),

  slot: async (d) => {
    try { state.trusted = await api('GET', '/api/resident/trusted'); } catch { /* use what we have */ }
    openSlotModal(Number(d.id));
  },
  check: async (d) => {
    await api('POST', `/api/resident/parcels/${d.id}/check`, { decision: d.decision });
    toast(d.decision === 'approve' ? 'Approved. Thank you.' : 'Rejected. The courier will take it back.');
    go('parcels');
  },
  remove: async (d) => { if (confirm('Remove this parcel?')) { await api('DELETE', `/api/resident/parcels/${d.id}`); go('parcels'); } },
  'del-trusted': async (d) => { await api('DELETE', `/api/resident/trusted/${d.id}`); go('trusted'); },
  'copy-address': async () => {
    try { await navigator.clipboard.writeText(me.delivery_address); toast('Address copied'); } catch { toast('Select the address and copy it', true); }
  },
  'toggle-notify': async () => {
    await api('PATCH', '/api/auth/me', { notify_opt_in: !me.notify_opt_in });
    me.notify_opt_in = !me.notify_opt_in; render();
  },
  photo: async (d) => {
    let url;
    try {
      const res = await fetch(d.url, { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) throw new Error();
      url = URL.createObjectURL(await res.blob());
    } catch { return toast('Could not load the photo', true); }
    openModal(`<h2>Photo at the hub</h2><img src="${url}" alt="Parcel photo"><button class="ghost block" data-action="closemodal">Close</button>`, () => URL.revokeObjectURL(url));
  },
  history: async (d) => {
    const ev = await api('GET', `/api/staff/parcels/${d.id}/events`);
    openModal(`<h2>History</h2><table><tbody>${ev.map((e) => `<tr><td>${esc(fmt(e.created_at))}</td><td>${esc(e.action.replace(/_/g, ' '))}${e.detail ? ' · ' + esc(e.detail) : ''}<br><span class="muted small">${esc(e.actor || '')}</span></td></tr>`).join('')}</tbody></table><button class="ghost block" data-action="closemodal">Close</button>`);
  },
  startcheck: async (d) => { refreshDesk(await api('POST', `/api/staff/parcels/${d.id}/live-check`)); toast('Resident has been messaged'); },
  refuse: async (d) => { refreshDesk(await api('POST', `/api/staff/parcels/${d.id}/refuse`, {})); },
  returnp: async (d) => { if (confirm('Mark this parcel as returned to the courier?')) refreshDesk(await api('POST', `/api/staff/parcels/${d.id}/return`)); },
  resetcode: async (d) => { refreshDesk(await api('POST', `/api/staff/parcels/${d.id}/reset-code`)); toast('New code sent'); },
  'del-staff': async (d) => { if (confirm('Remove this staff member?')) { await api('DELETE', `/api/admin/staff/${d.id}`); go('team'); } },
};

const forms = {
  'otp-request': async (f, fd) => {
    const r = await api('POST', '/api/auth/request-otp', { phone: fd.get('phone') });
    state.login = { step: 'otp', phone: String(fd.get('phone')).replace(/\D/g, '').replace(/^(\d{10})$/, '91$1'), isNew: r.isNew, devOtp: r.dev_otp || null };
    state._phoneRaw = fd.get('phone');
    render();
  },
  'otp-verify': async (f, fd) => {
    const body = { phone: state._phoneRaw, code: fd.get('code') };
    if (state.login.isNew) Object.assign(body, { name: fd.get('name'), flat: fd.get('flat'), join_code: fd.get('join_code') });
    const r = await api('POST', '/api/auth/verify-otp', body);
    token = r.token; store.set('ph_token', token);
    await boot();
  },
  'add-parcel': async (f, fd) => {
    await api('POST', '/api/resident/parcels', { tracking_id: fd.get('tracking_id'), courier: fd.get('courier'), value: fd.get('value'), open_box: fd.get('open_box') === 'on' });
    toast('Parcel added. We will message you when it reaches the hub.');
    go('parcels');
  },
  'add-trusted': async (f, fd) => { await api('POST', '/api/resident/trusted', { name: fd.get('name'), phone: fd.get('phone') }); toast('Saved'); go('trusted'); },
  slot: async (f, fd) => {
    const body = {
      slot_start: new Date(fd.get('when')).toISOString(),
      duration_min: fd.get('duration'),
      collector: fd.get('collector'),
      trusted_person_id: fd.get('trusted'),
    };
    await api('POST', `/api/resident/parcels/${f.dataset.id}/slot`, body);
    closeModal(); toast('Pickup time confirmed'); go('parcels');
  },
  lookup: (f, fd) => lookup(fd.get('tracking_id')),
  'register-walkin': async (f, fd) => {
    const p = await api('POST', '/api/staff/parcels', {
      tracking_id: fd.get('tracking_id'), resident_phone: fd.get('resident_phone'), courier: fd.get('courier'), value: fd.get('value'), open_box: fd.get('open_box') === 'on',
    });
    refreshDesk(p);
  },
  receive: async (f, fd) => { refreshDesk(await api('POST', `/api/staff/parcels/${f.dataset.id}/receive`, fd)); toast('Received. Resident has been messaged.'); },
  handover: async (f, fd) => {
    try { refreshDesk(await api('POST', `/api/staff/parcels/${f.dataset.id}/handover`, { code: fd.get('code') })); toast('Handed over'); }
    catch (err) { toast(err.message, true); if (/locked/i.test(err.message)) lookup(state.desk.parcel.tracking_id); }
  },
  search: (f, fd) => { state.list.q = String(fd.get('q') || ''); return go('list'); },
  settings: async (f, fd) => {
    await api('PATCH', '/api/admin/society', { hub_address: fd.get('hub_address'), hold_days: fd.get('hold_days'), value_limit: fd.get('value_limit') });
    toast('Settings saved'); go('team');
  },
  'add-staff': async (f, fd) => { await api('POST', '/api/admin/staff', { name: fd.get('name'), phone: fd.get('phone') }); toast('Staff added'); go('team'); },
};

document.addEventListener('click', async (e) => {
  if (e.target.classList && e.target.classList.contains('overlay')) return closeModal();
  const el = e.target.closest('[data-action]');
  if (!el || !actions[el.dataset.action]) return;
  el.disabled = true;
  try { await actions[el.dataset.action](el.dataset, el); }
  catch (err) { toast(err.message, true); }
  finally { el.disabled = false; }
});

document.addEventListener('submit', async (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f || !forms[f.dataset.form]) return;
  e.preventDefault();
  const btn = f.querySelector('button:not([type])');
  if (btn) btn.disabled = true;
  try { await forms[f.dataset.form](f, new FormData(f)); }
  catch (err) { toast(err.message, true); }
  finally { if (btn && btn.isConnected) btn.disabled = false; }
});

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// ---- start ------------------------------------------------------------------

async function boot() {
  if (!token) return render();
  try {
    me = await api('GET', '/api/auth/me');
    state.tab = me.role === 'resident' ? 'parcels' : 'desk';
    await go(state.tab);
  } catch {
    if (!token) return;
    token = null; store.del('ph_token'); render();
  }
}

boot();
