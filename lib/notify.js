// Notifications. Every message is saved in the "messages" table so you can show
// "sent / failed" per step. The provider decides how it really leaves the server:
//   MESSAGE_PROVIDER=console -> printed in the server log (default, for development)
//   MESSAGE_PROVIDER=twilio  -> WhatsApp and SMS through Twilio
//
// IMPORTANT for WhatsApp in production: messages that you start must use templates that
// WhatsApp has approved, and the person must have opted in. The texts below are what you
// would submit as templates (replace {{...}} style variables when you register them).
const db = require('./db');
const { formatTime, nowIso } = require('./util');

const TEMPLATES = {
  otp: (v) => `Your ParcelHub login code is ${v.code}. It expires in 5 minutes. Do not share it.`,
  parcel_expected: (v) =>
    `Your parcel ${v.tracking}${v.courier ? ` (${v.courier})` : ''} is registered. We will update you when it reaches the hub.`,
  // v.code is only included when the resident collects personally. When a trusted person
  // collects, the code goes to that person instead and the owner never needs it.
  parcel_received: (v) =>
    `Your parcel ${v.tracking} has reached the hub. Open the app to choose your pickup time.${v.code ? ` Handover code: ${v.code}` : ` It will be collected by ${v.who}.`}`,
  slot_confirmed: (v) =>
    `Pickup confirmed for parcel ${v.tracking}: ${formatTime(v.slot_start)}. ${v.who}${v.code ? ` Handover code: ${v.code}` : ''}`,
  slot_reminder: (v) =>
    `Reminder: your parcel ${v.tracking} pickup is at ${formatTime(v.slot_start)}.${v.code ? ` Handover code: ${v.code}` : ` ${v.who} will collect it.`}`,
  refused: (v) =>
    `Parcel ${v.tracking} was refused at delivery and is going back to the courier, as you decided.`,
  trusted_ready: (v) =>
    `${v.owner} asked you to collect parcel ${v.tracking} from ${v.society}${v.slot_start ? ` at ${formatTime(v.slot_start)}` : ''}. Show this code at the hub desk: ${v.code}`,
  handed_over: (v) => `Parcel ${v.tracking} was handed over to ${v.who} at ${formatTime(v.at)}.`,
  live_check: (v) =>
    `Your open-box parcel ${v.tracking} is at the hub with the courier. Join the video check now and approve or reject it: ${v.link}`,
  unclaimed: (v) =>
    `Parcel ${v.tracking} has been at the hub for ${v.days} days. Please collect it soon, or it may be returned to the courier.`,
};

async function viaTwilio(phone, body, channel) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('Twilio credentials are missing');
  const sms = channel === 'sms';
  const from = sms ? process.env.TWILIO_SMS_FROM : `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`;
  const to = sms ? `+${phone}` : `whatsapp:+${phone}`;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ From: from, To: to, Body: body }),
  });
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function deliver(phone, body, channel) {
  const provider = process.env.MESSAGE_PROVIDER || 'console';
  if (provider === 'twilio') return viaTwilio(phone, body, channel);
  if (process.env.NODE_ENV !== 'test') console.log(`[${channel}] to +${phone}: ${body}`);
}

// Never throws: a failed message must not break the parcel flow.
async function sendMessage({ phone, template, vars = {}, channel = 'whatsapp', societyId = null }) {
  const body = TEMPLATES[template](vars);
  const logIt = template !== 'otp'; // do not store login codes
  let id = null;
  if (logIt) {
    id = db
      .prepare(
        'INSERT INTO messages (society_id, phone, channel, template, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(societyId, phone, channel, template, body, 'queued', nowIso()).lastInsertRowid;
  }
  try {
    await deliver(phone, body, channel);
    if (id) db.prepare("UPDATE messages SET status = 'sent' WHERE id = ?").run(id);
    return true;
  } catch (err) {
    console.error('Message failed:', err.message);
    if (id) {
      db.prepare("UPDATE messages SET status = 'failed', error = ? WHERE id = ?").run(
        String(err.message).slice(0, 300),
        id
      );
    }
    return false;
  }
}

// Message a resident (respects their opt-in choice).
function notifyUser(user, template, vars) {
  if (!user || !user.notify_opt_in) return Promise.resolve(false);
  return sendMessage({ phone: user.phone, template, vars, societyId: user.society_id });
}

// Message a trusted person (a phone number that is not a user).
function notifyPhone(phone, societyId, template, vars) {
  return sendMessage({ phone, template, vars, societyId });
}

module.exports = { sendMessage, notifyUser, notifyPhone };
