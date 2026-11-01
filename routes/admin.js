const express = require('express');
const db = require('../lib/db');
const { authRequired, requireRole } = require('../lib/auth');
const { normalizePhone, nowIso } = require('../lib/util');

const router = express.Router();
router.use(authRequired, requireRole('admin'));

router.get('/stats', (req, res) => {
  const sid = req.user.society_id;
  const society = db.prepare('SELECT * FROM societies WHERE id = ?').get(sid);

  const byStatus = Object.fromEntries(
    db.prepare('SELECT status, COUNT(*) AS n FROM parcels WHERE society_id = ? GROUP BY status').all(sid).map((r) => [r.status, r.n])
  );
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const received24h = db
    .prepare('SELECT COUNT(*) AS n FROM parcels WHERE society_id = ? AND received_at >= ?')
    .get(sid, dayAgo).n;
  const overdue = db
    .prepare(
      `SELECT COUNT(*) AS n FROM parcels
        WHERE society_id = ? AND status = 'received' AND julianday('now') - julianday(received_at) >= ?`
    )
    .get(sid, society.hold_days).n;
  const avg = db
    .prepare(
      `SELECT AVG((julianday(handed_over_at) - julianday(received_at)) * 24) AS hours
         FROM parcels WHERE society_id = ? AND status = 'handed_over'`
    )
    .get(sid).hours;
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const msgs = Object.fromEntries(
    db
      .prepare('SELECT status, COUNT(*) AS n FROM messages WHERE society_id = ? AND created_at >= ? GROUP BY status')
      .all(sid, weekAgo)
      .map((r) => [r.status, r.n])
  );
  const residents = db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE society_id = ? AND role = 'resident'")
    .get(sid).n;

  res.json({
    society: { name: society.name, join_code: society.join_code, hub_address: society.hub_address, hold_days: society.hold_days, value_limit: society.value_limit },
    residents,
    expected: byStatus.expected || 0,
    on_shelf: byStatus.received || 0,
    handed_over: byStatus.handed_over || 0,
    refused: byStatus.refused || 0,
    returned: byStatus.returned || 0,
    received_last_24h: received24h,
    overdue,
    avg_hours_to_handover: avg == null ? null : Math.round(avg * 10) / 10,
    messages_7d: { sent: msgs.sent || 0, failed: msgs.failed || 0 },
  });
});

router.patch('/society', (req, res) => {
  const hold = parseInt(req.body.hold_days, 10);
  const limit = parseInt(req.body.value_limit, 10);
  const addr = req.body.hub_address == null ? null : String(req.body.hub_address).trim().slice(0, 200);
  if (hold >= 1 && hold <= 60) db.prepare('UPDATE societies SET hold_days = ? WHERE id = ?').run(hold, req.user.society_id);
  if (limit >= 0 && limit <= 10000000) db.prepare('UPDATE societies SET value_limit = ? WHERE id = ?').run(limit, req.user.society_id);
  if (addr !== null) db.prepare('UPDATE societies SET hub_address = ? WHERE id = ?').run(addr, req.user.society_id);
  res.json({ ok: true });
});

router.get('/staff', (req, res) => {
  res.json(
    db
      .prepare("SELECT id, name, phone, role FROM users WHERE society_id = ? AND role IN ('staff','admin') ORDER BY name")
      .all(req.user.society_id)
  );
});

router.post('/staff', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const phone = normalizePhone(req.body.phone);
  if (!name || !phone) return res.status(400).json({ error: 'Enter a name and a valid phone number' });
  if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone)) {
    return res.status(409).json({ error: 'That phone number already has an account' });
  }
  const info = db
    .prepare("INSERT INTO users (phone, name, role, society_id, created_at) VALUES (?, ?, 'staff', ?, ?)")
    .run(phone, name, req.user.society_id, nowIso());
  res.status(201).json({ id: info.lastInsertRowid, name, phone, role: 'staff' });
});

router.delete('/staff/:id', (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare("SELECT * FROM users WHERE id = ? AND society_id = ? AND role = 'staff'").get(id, req.user.society_id);
  if (!target) return res.status(404).json({ error: 'Staff member not found' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

router.get('/messages', (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT id, phone, channel, template, status, error, created_at
           FROM messages WHERE society_id = ? ORDER BY id DESC LIMIT 100`
      )
      .all(req.user.society_id)
  );
});

module.exports = router;
