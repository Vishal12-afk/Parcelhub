// End-to-end test of the whole parcel flow against a real in-memory database.
process.env.NODE_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.UPLOAD_DIR = require('path').join(require('os').tmpdir(), `parcelhub-test-${process.pid}`);
process.env.JWT_SECRET = 'test-secret';
process.env.DEV_SHOW_OTP = 'true';
process.env.MESSAGE_PROVIDER = 'console';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const app = require('../app');
const { tick } = require('../lib/scheduler');

let base;
let server;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'); // real PNG signature

test.before(async () => {
  const now = new Date().toISOString();
  const sid = db
    .prepare('INSERT INTO societies (name, join_code, hub_address, value_limit, created_at) VALUES (?,?,?,?,?)')
    .run('Test Society', 'TEST1', 'Gate 1', 10000, now).lastInsertRowid;
  const add = db.prepare('INSERT INTO users (phone, name, role, society_id, flat, created_at) VALUES (?,?,?,?,?,?)');
  add.run('919100000001', 'Admin', 'admin', sid, null, now);
  add.run('919100000002', 'Guard', 'staff', sid, null, now);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function api(method, url, token, body) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

async function login(phone, signup) {
  const r = await api('POST', '/api/auth/request-otp', null, { phone });
  assert.equal(r.status, 200);
  assert.match(r.data.dev_otp, /^\d{6}$/);
  const v = await api('POST', '/api/auth/verify-otp', null, { phone, code: r.data.dev_otp, ...signup });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  return v.data.token;
}

const photo = () => {
  const f = new FormData();
  f.append('photo', new Blob([PNG], { type: 'image/png' }), 'p.png');
  return f;
};
const lastCodeFor = (phone) => {
  const row = db.prepare("SELECT body FROM messages WHERE phone = ? AND body LIKE '%code%' ORDER BY id DESC").get(phone);
  return row && row.body.match(/(\d{6})\s*$/)[1]; // the code is always the last thing in the message
};

let asha, guard, admin;

test('signup, login and wrong code handling', async () => {
  const bad = await api('POST', '/api/auth/request-otp', null, { phone: '123' });
  assert.equal(bad.status, 400);

  const r = await api('POST', '/api/auth/request-otp', null, { phone: '9100000009' });
  const wrong = await api('POST', '/api/auth/verify-otp', null, { phone: '9100000009', code: '000000' });
  assert.equal(wrong.status, 400);
  const noSociety = await api('POST', '/api/auth/verify-otp', null, { phone: '9100000009', code: r.data.dev_otp, name: 'X', flat: '1', join_code: 'NOPE' });
  assert.equal(noSociety.status, 400);

  asha = await login('9100000003', { name: 'Asha', flat: 'A-402', join_code: 'test1' });
  guard = await login('9100000002');
  admin = await login('9100000001');
  const me = await api('GET', '/api/auth/me', asha);
  assert.equal(me.data.role, 'resident');
  assert.match(me.data.delivery_address, /A-402/);
});

test('roles are enforced', async () => {
  assert.equal((await api('GET', '/api/staff/parcels', asha)).status, 403);
  assert.equal((await api('GET', '/api/admin/stats', guard)).status, 403);
  assert.equal((await api('GET', '/api/resident/parcels', guard)).status, 403);
  assert.equal((await api('GET', '/api/resident/parcels')).status, 401);
});

test('standard parcel: register, receive, book slot with trusted person, handover', async () => {
  const reg = await api('POST', '/api/resident/parcels', asha, { tracking_id: 'del-123456', courier: 'Delhivery', value: 1500 });
  assert.equal(reg.status, 201);
  assert.equal(reg.data.tracking_id, 'DEL-123456');
  assert.equal((await api('POST', '/api/resident/parcels', asha, { tracking_id: 'DEL-123456' })).status, 409);

  const trusted = (await api('POST', '/api/resident/trusted', asha, { name: 'Meena', phone: '9100000008' })).data;
  const slot = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
  const booked = await api('POST', `/api/resident/parcels/${reg.data.id}/slot`, asha, { slot_start: slot, collector: 'trusted', trusted_person_id: trusted.id });
  assert.equal(booked.status, 200);
  assert.equal(booked.data.trusted_name, 'Meena');

  // Receiving needs a photo.
  assert.equal((await api('POST', `/api/staff/parcels/${reg.data.id}/receive`, guard, new FormData())).status, 400);
  const rec = await api('POST', `/api/staff/parcels/${reg.data.id}/receive`, guard, photo());
  assert.equal(rec.status, 200, JSON.stringify(rec.data));
  assert.equal(rec.data.status, 'received');
  assert.equal(rec.data.handover_code, undefined, 'staff must never see the code');

  // The trusted person got the code, the owner did not.
  const code = lastCodeFor('919100000008');
  assert.match(code, /^\d{6}$/);
  const mine = (await api('GET', '/api/resident/parcels', asha)).data.find((p) => p.id === reg.data.id);
  assert.equal(mine.handover_code, null);

  const wrong = await api('POST', `/api/staff/parcels/${reg.data.id}/handover`, guard, { code: code === '111111' ? '222222' : '111111' });
  assert.equal(wrong.status, 400);
  const ok = await api('POST', `/api/staff/parcels/${reg.data.id}/handover`, guard, { code });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.status, 'handed_over');
  assert.match(ok.data.handed_over_to, /Meena/);
  assert.equal((await api('POST', `/api/staff/parcels/${reg.data.id}/handover`, guard, { code })).status, 409);

  const events = (await api('GET', `/api/staff/parcels/${reg.data.id}/events`, guard)).data.map((e) => e.action);
  assert.deepEqual(events.slice(0, 2), ['registered', 'slot_booked']);
  assert.ok(events.includes('handed_over'));
});

test('five wrong codes lock the parcel until an admin resets it', async () => {
  const reg = await api('POST', '/api/resident/parcels', asha, { tracking_id: 'LOCK-1' });
  await api('POST', `/api/staff/parcels/${reg.data.id}/receive`, guard, photo());
  for (let i = 0; i < 5; i++) await api('POST', `/api/staff/parcels/${reg.data.id}/handover`, guard, { code: '000000' });
  assert.equal((await api('POST', `/api/staff/parcels/${reg.data.id}/handover`, guard, { code: '000000' })).status, 423);
  assert.equal((await api('POST', `/api/staff/parcels/${reg.data.id}/reset-code`, guard)).status, 403);
  assert.equal((await api('POST', `/api/staff/parcels/${reg.data.id}/reset-code`, admin)).status, 200);
  const code = (await api('GET', '/api/resident/parcels', asha)).data.find((p) => p.id === reg.data.id).handover_code;
  assert.equal((await api('POST', `/api/staff/parcels/${reg.data.id}/handover`, guard, { code })).status, 200);
});

test('open-box parcel needs the resident to approve the live check', async () => {
  const reg = await api('POST', '/api/resident/parcels', asha, { tracking_id: 'PHONE-1', value: 45999 });
  assert.equal(reg.data.open_box, true, 'value above the limit forces open-box');

  const early = await api('POST', `/api/staff/parcels/${reg.data.id}/receive`, guard, photo());
  assert.equal(early.status, 409);

  const lc = await api('POST', `/api/staff/parcels/${reg.data.id}/live-check`, guard);
  assert.equal(lc.status, 200);
  assert.match(lc.data.video_link, /^https:\/\/meet\.jit\.si\/parcelhub-/);
  assert.equal((await api('POST', `/api/resident/parcels/${reg.data.id}/check`, asha, { decision: 'approve' })).data.check_status, 'approved');
  assert.equal((await api('POST', `/api/staff/parcels/${reg.data.id}/receive`, guard, photo())).status, 200);

  // A rejected one is refused and returned.
  const reg2 = await api('POST', '/api/resident/parcels', asha, { tracking_id: 'PHONE-2', open_box: true });
  await api('POST', `/api/staff/parcels/${reg2.data.id}/live-check`, guard);
  await api('POST', `/api/resident/parcels/${reg2.data.id}/check`, asha, { decision: 'reject' });
  assert.equal((await api('POST', `/api/staff/parcels/${reg2.data.id}/receive`, guard, photo())).status, 409);
  assert.equal((await api('POST', `/api/staff/parcels/${reg2.data.id}/refuse`, guard, {})).data.status, 'refused');
  assert.equal((await api('POST', `/api/staff/parcels/${reg2.data.id}/return`, guard)).data.status, 'returned');
});

test('residents cannot see each other’s parcels', async () => {
  const ravi = await login('9100000004', { name: 'Ravi', flat: 'B-1', join_code: 'TEST1' });
  const reg = await api('POST', '/api/resident/parcels', asha, { tracking_id: 'PRIVATE-1' });
  assert.equal((await api('POST', `/api/resident/parcels/${reg.data.id}/slot`, ravi, { slot_start: new Date(Date.now() + 3600e3).toISOString() })).status, 404);
  assert.equal((await api('GET', `/api/resident/parcels/${reg.data.id}/photo`, ravi)).status, 404);
  assert.equal((await api('GET', '/api/resident/parcels', ravi)).data.length, 0);
});

test('scheduler sends a reminder before the slot and for unclaimed parcels', async () => {
  const reg = await api('POST', '/api/resident/parcels', asha, { tracking_id: 'REMIND-1' });
  await api('POST', `/api/staff/parcels/${reg.data.id}/receive`, guard, photo());
  await api('POST', `/api/resident/parcels/${reg.data.id}/slot`, asha, { slot_start: new Date(Date.now() + 20 * 60e3).toISOString(), collector: 'self' });
  const r = await tick();
  assert.ok(r.slotReminders >= 1);
  assert.equal((await tick()).slotReminders, 0, 'each reminder is sent once');

  db.prepare("UPDATE parcels SET received_at = datetime('now','-9 days') WHERE id = ?").run(reg.data.id);
  assert.ok((await tick()).unclaimedReminders >= 1);
});

test('admin dashboard and settings', async () => {
  const stats = await api('GET', '/api/admin/stats', admin);
  assert.equal(stats.status, 200);
  assert.ok(stats.data.handed_over >= 2);
  assert.ok(stats.data.messages_7d.sent > 0);
  assert.equal((await api('PATCH', '/api/admin/society', admin, { value_limit: 5000 })).status, 200);
  const staff = await api('POST', '/api/admin/staff', admin, { name: 'Night Guard', phone: '9100000007' });
  assert.equal(staff.status, 201);
  assert.equal((await api('DELETE', `/api/admin/staff/${staff.data.id}`, admin)).status, 200);
});

test('slot validation', async () => {
  const reg = await api('POST', '/api/resident/parcels', asha, { tracking_id: 'SLOT-1' });
  assert.equal((await api('POST', `/api/resident/parcels/${reg.data.id}/slot`, asha, { slot_start: 'nonsense' })).status, 400);
  assert.equal((await api('POST', `/api/resident/parcels/${reg.data.id}/slot`, asha, { slot_start: new Date(Date.now() - 86400e3).toISOString() })).status, 400);
  assert.equal((await api('POST', `/api/resident/parcels/${reg.data.id}/slot`, asha, { slot_start: new Date(Date.now() + 90 * 86400e3).toISOString() })).status, 400);
  assert.equal((await api('POST', `/api/resident/parcels/${reg.data.id}/slot`, asha, { slot_start: new Date(Date.now() + 3600e3).toISOString(), collector: 'trusted', trusted_person_id: 999 })).status, 400);
});
