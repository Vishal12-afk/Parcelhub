// Creates a demo society with an admin, a staff member, two residents and a few parcels.
// Run with: npm run seed
require('dotenv').config();
const db = require('./lib/db');
const { nowIso, randomDigits } = require('./lib/util');

const existing = db.prepare("SELECT id FROM societies WHERE join_code = 'GREEN1'").get();
if (existing) {
  console.log('Demo data already exists. Delete the data folder to start fresh.');
  process.exit(0);
}

const now = nowIso();
const sid = db
  .prepare('INSERT INTO societies (name, join_code, hub_address, created_at) VALUES (?, ?, ?, ?)')
  .run('Green Valley Apartments', 'GREEN1', 'Security Desk, Tower A, Whitefield, Bengaluru 560066', now).lastInsertRowid;

const addUser = db.prepare(
  'INSERT INTO users (phone, name, role, society_id, flat, created_at) VALUES (?, ?, ?, ?, ?, ?)'
);
addUser.run('919000000001', 'Demo Admin', 'admin', sid, null, now);
addUser.run('919000000002', 'Demo Guard', 'staff', sid, null, now);
const asha = addUser.run('919000000003', 'Asha Rao', 'resident', sid, 'A-402', now).lastInsertRowid;
const ravi = addUser.run('919000000004', 'Ravi Nair', 'resident', sid, 'B-101', now).lastInsertRowid;

db.prepare('INSERT INTO trusted_persons (resident_id, name, phone, created_at) VALUES (?, ?, ?, ?)').run(
  asha, 'Meena Rao (mother)', '919000000005', now
);

const addParcel = db.prepare(
  `INSERT INTO parcels (society_id, resident_id, tracking_id, courier, value, open_box, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
addParcel.run(sid, asha, 'DEL1234567', 'Delhivery', 1499, 0, now);
addParcel.run(sid, asha, 'EKT9988776', 'Ekart', 45999, 1, now);
addParcel.run(sid, ravi, 'AMZ5544332', 'Amazon', 799, 0, now);

console.log(`
Demo data created. Start the app with:  npm start   then open http://localhost:3000

Sign in with these phone numbers (the login code is shown on screen in development):
  Admin     9000000001
  Staff     9000000002
  Resident  9000000003   (Asha, flat A-402)
  Resident  9000000004   (Ravi, flat B-101)

A new resident can sign up with society code: GREEN1
`);
