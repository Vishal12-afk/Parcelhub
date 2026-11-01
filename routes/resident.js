const express = require('express');
const path = require('path');
const db = require('../lib/db');
const { authRequired, requireRole } = require('../lib/auth');
const { getParcel, residentView } = require('../lib/parcels');
const { notifyUser, notifyPhone } = require('../lib/notify');
const { cleanTracking, normalizePhone, nowIso, randomDigits, logEvent } = require('../lib/util');

const router = express.Router();
router.use(authRequired, requireRole('resident'));

function ownParcel(req, res) {
  const p = getParcel(Number(req.params.id));
  if (!p || p.resident_id !== req.user.id) {
    res.status(404).json({ error: 'Parcel not found' });
    return null;
  }
  return p;
}

// ---- Parcels ----------------------------------------------------------------

router.get('/parcels', (req, res) => {
  const rows = db
    .prepare(
      `SELECT id FROM parcels WHERE resident_id = ?
        ORDER BY CASE status WHEN 'received' THEN 0 WHEN 'expected' THEN 1 ELSE 2 END, id DESC LIMIT 200`
    )
    .all(req.user.id);
  res.json(rows.map((r) => residentView(getParcel(r.id))));
});

router.post('/parcels', async (req, res) => {
  const tracking = cleanTracking(req.body.tracking_id);
  if (!tracking) return res.status(400).json({ error: 'Enter a valid tracking ID (letters and numbers)' });

  const society = db.prepare('SELECT * FROM societies WHERE id = ?').get(req.user.society_id);
  const value = Math.max(0, Math.min(10000000, parseInt(req.body.value, 10) || 0));
  const courier = String(req.body.courier || '').trim().slice(0, 40) || null;
  // Expensive parcels always need the live check.
  const openBox = req.body.open_box === true || value > society.value_limit ? 1 : 0;

  try {
    const info = db
      .prepare(
        `INSERT INTO parcels (society_id, resident_id, tracking_id, courier, value, open_box, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(society.id, req.user.id, tracking, courier, value, openBox, nowIso());
    logEvent(info.lastInsertRowid, req.user.id, 'registered', null);
    await notifyUser(req.user, 'parcel_expected', { tracking, courier });
    res.status(201).json(residentView(getParcel(info.lastInsertRowid)));
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'This tracking ID is already registered' });
    }
    throw err;
  }
});

router.delete('/parcels/:id', (req, res) => {
  const p = ownParcel(req, res);
  if (!p) return;
  if (p.status !== 'expected') {
    return res.status(409).json({ error: 'Only parcels that have not reached the hub can be removed' });
  }
  db.prepare('DELETE FROM events WHERE parcel_id = ?').run(p.id);
  db.prepare('DELETE FROM parcels WHERE id = ?').run(p.id);
  res.json({ ok: true });
});

// Book or change the pickup time. Works before and after the parcel reaches the hub.
router.post('/parcels/:id/slot', async (req, res) => {
  const p = ownParcel(req, res);
  if (!p) return;
  if (!['expected', 'received'].includes(p.status)) {
    return res.status(409).json({ error: 'This parcel can no longer be rescheduled' });
  }

  const start = new Date(req.body.slot_start);
  if (Number.isNaN(start.getTime())) return res.status(400).json({ error: 'Choose a pickup time' });
  const now = Date.now();
  if (start.getTime() < now - 5 * 60 * 1000) {
    return res.status(400).json({ error: 'Pickup time must be in the future' });
  }
  if (start.getTime() > now + 30 * 24 * 3600 * 1000) {
    return res.status(400).json({ error: 'Pickup time must be within the next 30 days' });
  }
  const minutes = Math.max(15, Math.min(240, parseInt(req.body.duration_min, 10) || 60));
  const end = new Date(start.getTime() + minutes * 60 * 1000);

  const collector = req.body.collector === 'trusted' ? 'trusted' : 'self';
  let trusted = null;
  if (collector === 'trusted') {
    trusted = db
      .prepare('SELECT * FROM trusted_persons WHERE id = ? AND resident_id = ?')
      .get(Number(req.body.trusted_person_id), req.user.id);
    if (!trusted) return res.status(400).json({ error: 'Choose one of your trusted people' });
  }

  // A parcel that is already at the hub gets a fresh code whenever the plan changes,
  // so an old code (for example a previous collector's) stops working.
  let code = p.handover_code;
  if (p.status === 'received') code = randomDigits(6);

  db.prepare(
    `UPDATE parcels SET slot_start = ?, slot_end = ?, collector = ?, trusted_person_id = ?,
            handover_code = ?, code_attempts = 0, reminded = 0 WHERE id = ?`
  ).run(start.toISOString(), end.toISOString(), collector, trusted ? trusted.id : null, code, p.id);
  logEvent(p.id, req.user.id, 'slot_booked', `${start.toISOString()} by ${collector}`);

  const society = db.prepare('SELECT name FROM societies WHERE id = ?').get(p.society_id);
  const atHub = p.status === 'received';
  const who = trusted ? `${trusted.name} will collect it.` : 'You will collect it.';
  await notifyUser(req.user, 'slot_confirmed', {
    tracking: p.tracking_id,
    slot_start: start.toISOString(),
    who,
    code: atHub && !trusted ? code : null,
  });
  if (trusted && atHub) {
    await notifyPhone(trusted.phone, p.society_id, 'trusted_ready', {
      tracking: p.tracking_id,
      owner: req.user.name,
      society: society.name,
      slot_start: start.toISOString(),
      code,
    });
  }
  res.json(residentView(getParcel(p.id)));
});

// Live open-box check: the resident approves or rejects while staff open the box.
router.post('/parcels/:id/check', (req, res) => {
  const p = ownParcel(req, res);
  if (!p) return;
  const decision = req.body.decision;
  if (!['approve', 'reject'].includes(decision)) {
    return res.status(400).json({ error: 'Choose approve or reject' });
  }
  if (p.check_status !== 'pending') {
    return res.status(409).json({ error: 'There is no live check waiting for you on this parcel' });
  }
  const status = decision === 'approve' ? 'approved' : 'rejected';
  db.prepare('UPDATE parcels SET check_status = ? WHERE id = ?').run(status, p.id);
  logEvent(p.id, req.user.id, `live_check_${status}`, null);
  res.json(residentView(getParcel(p.id)));
});

router.get('/parcels/:id/photo', (req, res) => {
  const p = ownParcel(req, res);
  if (!p) return;
  if (!p.photo_file) return res.status(404).json({ error: 'No photo' });
  const dir = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads'));
  res.sendFile(path.join(dir, path.basename(p.photo_file)));
});

// ---- Trusted people ---------------------------------------------------------

router.get('/trusted', (req, res) => {
  res.json(
    db
      .prepare('SELECT id, name, phone FROM trusted_persons WHERE resident_id = ? ORDER BY name')
      .all(req.user.id)
  );
});

router.post('/trusted', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const phone = normalizePhone(req.body.phone);
  if (!name || !phone) return res.status(400).json({ error: 'Enter a name and a valid phone number' });
  const count = db
    .prepare('SELECT COUNT(*) AS n FROM trusted_persons WHERE resident_id = ?')
    .get(req.user.id).n;
  if (count >= 10) return res.status(400).json({ error: 'You can save up to 10 trusted people' });
  const info = db
    .prepare('INSERT INTO trusted_persons (resident_id, name, phone, created_at) VALUES (?, ?, ?, ?)')
    .run(req.user.id, name, phone, nowIso());
  res.status(201).json({ id: info.lastInsertRowid, name, phone });
});

router.delete('/trusted/:id', (req, res) => {
  db.prepare('DELETE FROM trusted_persons WHERE id = ? AND resident_id = ?').run(
    Number(req.params.id),
    req.user.id
  );
  res.json({ ok: true });
});

module.exports = router;
