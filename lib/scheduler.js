// Runs every minute:
//  1. Reminds people 30 minutes before a booked pickup slot.
//  2. Reminds residents about parcels that have waited at the hub longer than the society's hold limit.
const db = require('./db');
const { notifyUser, notifyPhone } = require('./notify');

async function tick(now = new Date()) {
  const soon = new Date(now.getTime() + 30 * 60 * 1000).toISOString();

  const slots = db
    .prepare(
      `SELECT p.*, t.phone AS trusted_phone
         FROM parcels p
         LEFT JOIN trusted_persons t ON t.id = p.trusted_person_id
        WHERE p.status = 'received' AND p.reminded = 0
          AND p.slot_start IS NOT NULL AND p.slot_start <= ? AND p.slot_start > ?`
    )
    .all(soon, now.toISOString());

  for (const p of slots) {
    const resident = db.prepare('SELECT * FROM users WHERE id = ?').get(p.resident_id);
    db.prepare('UPDATE parcels SET reminded = 1 WHERE id = ?').run(p.id);
    const vars = { tracking: p.tracking_id, slot_start: p.slot_start, code: p.handover_code };
    await notifyUser(resident, 'slot_reminder', vars);
    if (p.collector === 'trusted' && p.trusted_phone) {
      const society = db.prepare('SELECT name FROM societies WHERE id = ?').get(p.society_id);
      await notifyPhone(p.trusted_phone, p.society_id, 'trusted_ready', {
        ...vars,
        owner: resident.name,
        society: society.name,
      });
    }
  }

  const overdue = db
    .prepare(
      `SELECT p.*, s.hold_days
         FROM parcels p JOIN societies s ON s.id = p.society_id
        WHERE p.status = 'received' AND p.unclaimed_reminded = 0
          AND julianday(?) - julianday(p.received_at) >= s.hold_days`
    )
    .all(now.toISOString());

  for (const p of overdue) {
    const resident = db.prepare('SELECT * FROM users WHERE id = ?').get(p.resident_id);
    db.prepare('UPDATE parcels SET unclaimed_reminded = 1 WHERE id = ?').run(p.id);
    await notifyUser(resident, 'unclaimed', { tracking: p.tracking_id, days: p.hold_days });
  }

  return { slotReminders: slots.length, unclaimedReminders: overdue.length };
}

function startScheduler() {
  return setInterval(() => tick().catch((err) => console.error('Scheduler error:', err)), 60 * 1000);
}

module.exports = { tick, startScheduler };
