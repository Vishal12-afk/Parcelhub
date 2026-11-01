# ParcelHub

A parcel-hub app for residential societies and offices. The hub (guard desk or reception) receives parcels on behalf of residents. Residents choose when to collect, can send a trusted person instead, get WhatsApp/SMS updates at every step, and approve expensive open-box parcels live on video.

This is a complete working version 1: web app (works on phones), API, database, notifications and reminders. It runs on your laptop with no accounts or paid services.

## Run it (5 minutes)

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
cp .env.example .env      # on Windows: copy .env.example .env
npm run seed              # creates a demo society and users
npm start
```

Open http://localhost:3000. Sign in with these demo numbers (in development the login code is shown on screen):

| Role | Phone | What they do |
|---|---|---|
| Admin | 9000000001 | Dashboard, staff, settings, message log |
| Staff | 9000000002 | Desk: scan, receive, hand over |
| Resident | 9000000003 | Asha, flat A-402 (has a trusted person saved) |
| Resident | 9000000004 | Ravi, flat B-101 |

New residents can sign up with society code `GREEN1`.

Run the automated tests with `npm test`.

## Try the whole flow

1. **Resident (Asha):** My parcels → choose a pickup time for `DEL1234567`, collected by "Meena Rao (mother)".
2. **Staff:** Desk → type `DEL1234567` → take a photo → Mark received. The server log prints the messages that WhatsApp would send; Meena's message contains her own code.
3. **Staff:** type the code Meena received → Hand over. The resident is told who collected it.
4. **Open-box:** Desk → `EKT9988776` (₹45,999, so live check is required) → Start live check. As Asha, tap Approve. As staff, take a photo and Mark received.

## How it matches your pitch

| Pitch | Where |
|---|---|
| Hub is the delivery address | Resident → Account shows the address to use at checkout |
| Resident registers an expected parcel | Add parcel |
| Resident books the pickup time | Choose pickup time (before or after arrival) |
| Trusted person collects | Trusted people tab, gets their own code by message |
| Photo at intake, audit trail | Receive needs a photo; History shows every step |
| Open-box live check | Value above the limit, or ticked by the resident |
| Updates at every step | `lib/notify.js` (all stored in the messages table) |
| Reminders | `lib/scheduler.js`: 30 minutes before a slot, and for unclaimed parcels |
| Society dashboard | Admin → Dashboard |

## Project layout

```
server.js        starts the server and the reminder scheduler
app.js           Express app (security headers, routes, errors)
seed.js          demo data
lib/db.js        database tables (SQLite)
lib/auth.js      login tokens and role checks
lib/notify.js    message templates and sending (console or Twilio)
lib/scheduler.js reminders
lib/parcels.js   what residents and staff are allowed to see
routes/          auth, resident, staff, admin APIs
public/          the web app (index.html, app.js, styles.css)
test/            end-to-end API tests
```

## Real WhatsApp and SMS

By default messages are only printed in the server log. To send real ones, set in `.env`:

```
MESSAGE_PROVIDER=twilio
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_WHATSAPP_FROM=+14155238886
TWILIO_SMS_FROM=+1...
```

- Twilio's WhatsApp sandbox lets you test with your own phone first.
- For production WhatsApp you need a verified business and **pre-approved message templates**. The texts in `lib/notify.js` are the ones to submit. Messages you start outside the 24-hour reply window must use a template, and people must have opted in.
- Login codes go by SMS. In India, commercial SMS usually needs DLT registration with your provider, so start that early. An alternative is to send login codes by WhatsApp too.
- To use another provider (Gupshup, Interakt, MSG91, Amazon SES for email), add a function next to `viaTwilio` in `lib/notify.js` and select it with `MESSAGE_PROVIDER`.

## Before real users

- Set a long random `JWT_SECRET` and `NODE_ENV=production` (the app refuses to start in production with the default secret). In production the login code is never shown on screen.
- Serve over HTTPS (needed for the camera and barcode scanner on phones). Put it behind Nginx, or use a host that gives you HTTPS.
- The database and photos are local files in `data/`. Back that folder up, and keep it on a persistent disk.
- Have a lawyer review your terms (liability for loss or damage after handover) and privacy policy. You store names, phone numbers and photos.
- Check each courier's and marketplace's rules for open-box delivery and who may accept a parcel or take the delivery OTP.

## Growing it later

This version runs on one server. When you outgrow that:

- Move SQLite to PostgreSQL (for example Amazon RDS). The tables are plain SQL.
- Store photos in Amazon S3 instead of the `data/uploads` folder.
- Replace the in-memory rate limiter in `lib/util.js` with a shared one such as Redis.
- Split notifications into a queue (Amazon SQS plus Lambda) as message volume grows.

## Not included yet

Native Android/iOS apps, QR codes (codes are typed), automatic courier tracking by AWB, payments and billing, cash-on-delivery handling, email notifications, and in-app video (it uses a Jitsi link). Each can be added on top of this base.
