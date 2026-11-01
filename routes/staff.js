const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../lib/db');
const { authRequired, requireRole } = require('../lib/auth');
const { getParcel, getParcelByTracking, staffView } = require('../lib/parcels');
const { notifyUser, notifyPhone } = require('../lib/notify');
const {
  cleanTracking,
  normalizePhone,
  nowIso,
  randomDigits,
  randomHex,
  safeEqual,
  logEvent,
} = require('../lib/util');

const router = express.Router();
router.use(authRequired, requireRole('staff', 'admin'));

const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads'));
fs.mkdirSync(uploadDir, { recursive: true });

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, randomHex(12) + (EXT[file.mimetype] || '.bin')),
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) =>
    EXT[file.mimetype] ? cb(null, true) : cb(new Error('Only JPG, PNG or WebP photos are allowed')),
});

// Check the real file contents, not just the name the phone sent.
function looksLikeImage(file) {
  const buf = Buffer.alloc(12);
  const fd = fs.openSync(file.path, 'r');
  try {
    fs.readSync(fd, buf, 0, 12, 0);
  } finally {
    fs.closeSync(fd);
  }
  const jpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const png = buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const webp = buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
  return jpg || png || webp;
}

function sameSociety(req, res) {
  const p = getParcel(Number(req.params.id));
  if (!p || p.society_id !== req.user.society_id) {
    res.status(404).json({ error: 'Parcel not found' });
    return null;
  }
  return p;
}

// ---- Find and list ----------------------------------------------------------

router.get('/parcels', (req, res) => {
  const status = String(req.query.status || '');
  const q = String(req.query.q || '').trim();
  const where = ['p.society_id = ?'];
  const args = [req.user.society_id];
  if (['expected', 'received', 'handed_over', 'refused', 'returned'].includes(status)) {
    where.push('p.status = ?');
    args.push(status);
  }
  if (q) {
    where.push('(p.tracking_id LIKE ? OR u.name LIKE ? OR u.flat LIKE ? OR u.phone LIKE ?)');
    const like = `%${q.replace(/[%_]/g, '')}%`;
    args.push(like.toUpperCase(), like, like, like);
  }
  const ids = db
    .prepare(
      `SELECT p.id FROM parcels p JOIN users u ON u.id = p.resident_id
        WHERE ${where.join(' AND ')} ORDER BY p.id DESC LIMIT 200`
    )
    .all(...args);
  res.json(ids.map((r) => staffView(getParcel(r.id))));
});

router.get('/lookup', (req, res) => {
  const tracking = cleanTracking(req.query.tracking_id);
  if (!tracking) return res.status(400).json({ error: 'Enter a valid tracking ID' });
  const p = getParcelByTracking(req.user.society_id, tracking);
  if (!p) {
    return res.status(404).json({
      error: 'This tracking ID is not registered. Add it for a resident to continue.',
      can_register: true,
    });
  }
  res.json(staffView(p));
});

// Parcel arrived but the resident did not register it: staff create it from the resident's phone.
router.post('/parcels', (req, res) => {
  const tracking = cleanTracking(req.body.tracking_id);
  const phone = normalizePhone(req.body.resident_phone);
  if (!tracking || !phone) {
    return res.status(400).json({ error: 'Enter a tracking ID and the resident’s phone number' });
  }
  const resident = db
    .prepare("SELECT * FROM users WHERE phone = ? AND role = 'resident' AND society_id = ?")
    .get(phone, req.user.society_id);
  if (!resident) return res.status(404).json({ error: 'No resident in this society has that phone number' });

  const society = db.prepare('SELECT * FROM societies WHERE id = ?').get(req.user.society_id);
  const value = Math.max(0, parseInt(req.body.value, 10) || 0);
  const openBox = req.body.open_box === true || value > society.value_limit ? 1 : 0;
  try {
    const info = db
      .prepare(
        `INSERT INTO parcels (society_id, resident_id, tracking_id, courier, value, open_box, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        society.id,
        resident.id,
        tracking,
        String(req.body.courier || '').trim().slice(0, 40) || null,
        value,
        openBox,
        nowIso()
      );
    logEvent(info.lastInsertRowid, req.user.id, 'registered_by_staff', null);
    res.status(201).json(staffView(getParcel(info.lastInsertRowid)));
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'This tracking ID already exists' });
    }
    throw err;
  }
});

// ---- Open-box live check ----------------------------------------------------

router.post('/parcels/:id/live-check', async (req, res) => {
  const p = sameSociety(req, res);
  if (!p) return;
  if (!p.open_box) return res.status(409).json({ error: 'This parcel does not need a live check' });
  if (p.status !== 'expected') return res.status(409).json({ error: 'This parcel is already at the hub' });

  // A fresh private video room each time. Jitsi needs no account; swap in your own provider later.
  const link = `https://meet.jit.si/parcelhub-${randomHex(8)}`;
  db.prepare("UPDATE parcels SET check_status = 'pending', video_link = ? WHERE id = ?").run(link, p.id);
  logEvent(p.id, req.user.id, 'live_check_started', null);

  const resident = db.prepare('SELECT * FROM users WHERE id = ?').get(p.resident_id);
  await notifyUser(resident, 'live_check', { tracking: p.tracking_id, link });
  res.json(staffView(getParcel(p.id)));
});

router.post('/parcels/:id/refuse', async (req, res) => {
  const p = sameSociety(req, res);
  if (!p) return;
  if (p.status !== 'expected') return res.status(409).json({ error: 'Only a parcel not yet received can be refused' });
  db.prepare("UPDATE parcels SET status = 'refused' WHERE id = ?").run(p.id);
  logEvent(p.id, req.user.id, 'refused', req.body.reason ? String(req.body.reason).slice(0, 200) : null);
  const resident = db.prepare('SELECT * FROM users WHERE id = ?').get(p.resident_id);
  await notifyUser(resident, 'refused', { tracking: p.tracking_id });
  res.json(staffView(getParcel(p.id)));
});

// ---- Receive at the hub (photo required) ------------------------------------

router.post('/parcels/:id/receive', upload.single('photo'), async (req, res) => {
  const p = sameSociety(req, res);
  const file = req.file;
  const discard = () => file && fs.rm(file.path, { force: true }, () => {});
  if (!p) return discard();

  if (!file) return res.status(400).json({ error: 'Take a photo of the parcel first' });
  if (!looksLikeImage(file)) {
    discard();
    return res.status(400).json({ error: 'That file is not a valid photo' });
  }
  if (p.status !== 'expected') {
    discard();
    return res.status(409).json({ error: 'This parcel is already at the hub or closed' });
  }
  if (p.open_box && p.check_status !== 'approved') {
    discard();
    return res.status(409).json({
      error: 'Open-box parcel: the resident must approve the live check before it can be accepted',
    });
  }

  const code = randomDigits(6);
  db.prepare(
    `UPDATE parcels SET status = 'received', photo_file = ?, handover_code = ?, code_attempts = 0,
            received_at = ? WHERE id = ?`
  ).run(file.filename, code, nowIso(), p.id);
  logEvent(p.id, req.user.id, 'received', null);

  const resident = db.prepare('SELECT * FROM users WHERE id = ?').get(p.resident_id);
  const society = db.prepare('SELECT name FROM societies WHERE id = ?').get(p.society_id);
  const trusted = p.collector === 'trusted' && p.trusted_phone;
  await notifyUser(resident, 'parcel_received', {
    tracking: p.tracking_id,
    code: trusted ? null : code,
    who: p.trusted_name,
  });
  if (trusted) {
    await notifyPhone(p.trusted_phone, p.society_id, 'trusted_ready', {
      tracking: p.tracking_id,
      owner: resident.name,
      society: society.name,
      slot_start: p.slot_start,
      code,
    });
  }
  res.json(staffView(getParcel(p.id)));
});

router.get('/parcels/:id/photo', (req, res) => {
  const p = sameSociety(req, res);
  if (!p) return;
  if (!p.photo_file) return res.status(404).json({ error: 'No photo' });
  res.sendFile(path.join(uploadDir, path.basename(p.photo_file)));
});

// ---- Hand over --------------------------------------------------------------

router.post('/parcels/:id/handover', async (req, res) => {
  const p = sameSociety(req, res);
  if (!p) return;
  if (p.status !== 'received') return res.status(409).json({ error: 'This parcel is not waiting at the hub' });
  if (p.code_attempts >= 5) {
    return res.status(423).json({ error: 'Too many wrong codes. An admin must reset the code.' });
  }
  const code = String(req.body.code || '').trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit handover code' });

  if (!safeEqual(code, p.handover_code)) {
    db.prepare('UPDATE parcels SET code_attempts = code_attempts + 1 WHERE id = ?').run(p.id);
    logEvent(p.id, req.user.id, 'handover_wrong_code', null);
    const left = 4 - p.code_attempts;
    return res.status(400).json({
      error: left > 0 ? `Wrong code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Wrong code. Parcel locked.',
    });
  }

  const who = p.collector === 'trusted' && p.trusted_name ? `${p.trusted_name} (trusted person)` : p.resident_name;
  const at = nowIso();
  db.prepare(
    `UPDATE parcels SET status = 'handed_over', handed_over_at = ?, handed_over_to = ?,
            handover_code = NULL WHERE id = ?`
  ).run(at, who, p.id);
  logEvent(p.id, req.user.id, 'handed_over', who);

  const resident = db.prepare('SELECT * FROM users WHERE id = ?').get(p.resident_id);
  await notifyUser(resident, 'handed_over', { tracking: p.tracking_id, who, at });
  res.json(staffView(getParcel(p.id)));
});

// Parcel goes back to the courier (refused, or left unclaimed too long).
router.post('/parcels/:id/return', (req, res) => {
  const p = sameSociety(req, res);
  if (!p) return;
  if (!['refused', 'received'].includes(p.status)) {
    return res.status(409).json({ error: 'Only refused or waiting parcels can be returned' });
  }
  db.prepare("UPDATE parcels SET status = 'returned', handover_code = NULL WHERE id = ?").run(p.id);
  logEvent(p.id, req.user.id, 'returned', null);
  res.json(staffView(getParcel(p.id)));
});

// After 5 wrong codes only an admin can issue a new one.
router.post('/parcels/:id/reset-code', requireRole('admin'), async (req, res) => {
  const p = sameSociety(req, res);
  if (!p) return;
  if (p.status !== 'received') return res.status(409).json({ error: 'Parcel is not waiting at the hub' });
  const code = randomDigits(6);
  db.prepare('UPDATE parcels SET handover_code = ?, code_attempts = 0 WHERE id = ?').run(code, p.id);
  logEvent(p.id, req.user.id, 'code_reset', null);

  const resident = db.prepare('SELECT * FROM users WHERE id = ?').get(p.resident_id);
  if (p.collector === 'trusted' && p.trusted_phone) {
    const society = db.prepare('SELECT name FROM societies WHERE id = ?').get(p.society_id);
    await notifyPhone(p.trusted_phone, p.society_id, 'trusted_ready', {
      tracking: p.tracking_id,
      owner: resident.name,
      society: society.name,
      slot_start: p.slot_start,
      code,
    });
  } else {
    await notifyUser(resident, 'slot_confirmed', {
      tracking: p.tracking_id,
      slot_start: p.slot_start || nowIso(),
      who: 'New code issued.',
      code,
    });
  }
  res.json(staffView(getParcel(p.id)));
});

router.get('/parcels/:id/events', (req, res) => {
  const p = sameSociety(req, res);
  if (!p) return;
  res.json(
    db
      .prepare(
        `SELECT e.action, e.detail, e.created_at, u.name AS actor
           FROM events e LEFT JOIN users u ON u.id = e.actor_id
          WHERE e.parcel_id = ? ORDER BY e.id`
      )
      .all(p.id)
  );
});

module.exports = router;
