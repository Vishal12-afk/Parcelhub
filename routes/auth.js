const express = require('express');
const db = require('../lib/db');
const { signToken, hashOtp, authRequired, publicUser } = require('../lib/auth');
const { normalizePhone, randomDigits, safeEqual, nowIso, rateLimit } = require('../lib/util');
const { sendMessage } = require('../lib/notify');

const router = express.Router();
const OTP_MINUTES = 5;
const MAX_ATTEMPTS = 5;
const showDevOtp = () =>
  process.env.DEV_SHOW_OTP === 'true' && process.env.NODE_ENV !== 'production';

// Step 1: ask for a login code. Works for new and existing phone numbers.
router.post(
  '/request-otp',
  rateLimit({ windowMs: 10 * 60 * 1000, max: 20 }),
  async (req, res) => {
    const phone = normalizePhone(req.body.phone);
    if (!phone) return res.status(400).json({ error: 'Enter a valid phone number' });

    const existing = db.prepare('SELECT created_at FROM otps WHERE phone = ?').get(phone);
    if (existing && Date.now() - new Date(existing.created_at).getTime() < 30 * 1000) {
      return res.status(429).json({ error: 'Please wait 30 seconds before asking for another code' });
    }

    const code = randomDigits(6);
    db.prepare(
      `INSERT INTO otps (phone, code_hash, expires_at, attempts, created_at)
       VALUES (?, ?, ?, 0, ?)
       ON CONFLICT(phone) DO UPDATE SET code_hash = excluded.code_hash,
         expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at`
    ).run(phone, hashOtp(phone, code), new Date(Date.now() + OTP_MINUTES * 60 * 1000).toISOString(), nowIso());

    await sendMessage({ phone, template: 'otp', vars: { code }, channel: 'sms' });

    const isNew = !db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone);
    res.json({ ok: true, isNew, ...(showDevOtp() ? { dev_otp: code } : {}) });
  }
);

// Step 2: check the code. New people also send name, flat and their society's join code.
router.post('/verify-otp', rateLimit({ windowMs: 10 * 60 * 1000, max: 40 }), (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const code = String(req.body.code || '').trim();
  if (!phone || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'Enter the 6-digit code' });
  }

  const row = db.prepare('SELECT * FROM otps WHERE phone = ?').get(phone);
  if (!row || new Date(row.expires_at) < new Date()) {
    return res.status(400).json({ error: 'Code expired. Ask for a new one.' });
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Too many wrong attempts. Ask for a new code.' });
  }
  if (!safeEqual(row.code_hash, hashOtp(phone, code))) {
    db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE phone = ?').run(phone);
    return res.status(400).json({ error: 'Wrong code' });
  }

  let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!user) {
    const name = String(req.body.name || '').trim().slice(0, 80);
    const flat = String(req.body.flat || '').trim().slice(0, 30);
    const joinCode = String(req.body.join_code || '').trim().toUpperCase();
    if (!name || !flat || !joinCode) {
      return res.status(400).json({ error: 'Name, flat and society code are required to sign up' });
    }
    const society = db.prepare('SELECT * FROM societies WHERE join_code = ?').get(joinCode);
    if (!society) return res.status(400).json({ error: 'Society code not found' });
    const info = db
      .prepare(
        `INSERT INTO users (phone, name, role, society_id, flat, created_at)
         VALUES (?, ?, 'resident', ?, ?, ?)`
      )
      .run(phone, name, society.id, flat, nowIso());
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  }

  db.prepare('DELETE FROM otps WHERE phone = ?').run(phone);
  res.json({ token: signToken(user), user: publicUser(user) });
});

router.get('/me', authRequired, (req, res) => {
  const user = publicUser(req.user);
  const society = db.prepare('SELECT * FROM societies WHERE id = ?').get(req.user.society_id);
  // The address a resident types at checkout so the courier delivers to the hub.
  user.delivery_address = [
    req.user.name,
    `c/o ParcelHub, Flat ${req.user.flat || '-'}`,
    society.name,
    society.hub_address,
    `Phone: hub desk`,
  ]
    .filter(Boolean)
    .join(', ');
  user.value_limit = society.value_limit;
  res.json(user);
});

router.patch('/me', authRequired, (req, res) => {
  if (typeof req.body.notify_opt_in === 'boolean') {
    db.prepare('UPDATE users SET notify_opt_in = ? WHERE id = ?').run(
      req.body.notify_opt_in ? 1 : 0,
      req.user.id
    );
  }
  res.json({ ok: true });
});

module.exports = router;
