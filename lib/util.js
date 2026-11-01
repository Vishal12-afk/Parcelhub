const crypto = require('crypto');
const db = require('./db');

// Accepts "98765 43210", "+91 98765 43210", "919876543210". Returns digits with country code, or null.
function normalizePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (digits.length === 10) return '91' + digits; // assume India when no country code
  if (digits.length >= 11 && digits.length <= 15) return digits;
  return null;
}

const nowIso = () => new Date().toISOString();

function randomDigits(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += crypto.randomInt(0, 10);
  return s;
}

const randomHex = (bytes = 8) => crypto.randomBytes(bytes).toString('hex');

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

// Tracking IDs (AWB numbers): letters, digits, dash, underscore, 3 to 40 characters.
function cleanTracking(value) {
  const t = String(value || '').trim().toUpperCase();
  return /^[A-Z0-9\-_]{3,40}$/.test(t) ? t : null;
}

function formatTime(iso) {
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function logEvent(parcelId, actorId, action, detail) {
  db.prepare(
    'INSERT INTO events (parcel_id, actor_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(parcelId, actorId || null, action, detail || null, nowIso());
}

// Simple in-memory limiter, enough for one server. Use a shared store (Redis) if you run several.
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) hits.clear();
    next();
  };
}

module.exports = {
  normalizePhone,
  nowIso,
  randomDigits,
  randomHex,
  safeEqual,
  cleanTracking,
  formatTime,
  logEvent,
  rateLimit,
};
