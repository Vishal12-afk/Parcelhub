const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('./db');

const DEFAULT_SECRET = 'dev-only-secret-change-me';
const SECRET = process.env.JWT_SECRET || DEFAULT_SECRET;
if (process.env.NODE_ENV === 'production' && SECRET === DEFAULT_SECRET) {
  throw new Error('Set JWT_SECRET in your environment before running in production.');
}

function signToken(user) {
  return jwt.sign({ uid: user.id }, SECRET, { expiresIn: '7d' });
}

function hashOtp(phone, code) {
  return crypto.createHash('sha256').update(`${phone}:${code}:${SECRET}`).digest('hex');
}

// Reads "Authorization: Bearer <token>", loads the user, and attaches it as req.user.
function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try {
    const { uid } = jwt.verify(token, SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    if (!user) return res.status(401).json({ error: 'Account not found' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
}

function requireRole(...roles) {
  return (req, res, next) =>
    roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Not allowed' });
}

function publicUser(user) {
  const society = db
    .prepare('SELECT id, name, hub_address FROM societies WHERE id = ?')
    .get(user.society_id);
  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    role: user.role,
    flat: user.flat,
    notify_opt_in: !!user.notify_opt_in,
    society,
  };
}

module.exports = { signToken, hashOtp, authRequired, requireRole, publicUser };
