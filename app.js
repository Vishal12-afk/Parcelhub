// Builds the Express app. Kept separate from server.js so tests can start it on any port.
require('dotenv').config();
const express = require('express');
const path = require('path');
const multer = require('multer');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // correct client IPs behind a load balancer, needed for rate limits

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  });
  next();
});

app.use(express.json({ limit: '100kb' }));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/resident', require('./routes/resident'));
app.use('/api/staff', require('./routes/staff'));
app.use('/api/admin', require('./routes/admin'));
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Photo is too large (max 8 MB)' : err.message });
  }
  if (err && err.message === 'Only JPG, PNG or WebP photos are allowed') {
    return res.status(400).json({ error: err.message });
  }
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

module.exports = app;
