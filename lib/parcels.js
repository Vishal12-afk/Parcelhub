// Shared helpers for reading parcels.
const db = require('./db');

const SELECT_PARCEL = `
  SELECT p.*,
         u.name  AS resident_name,
         u.phone AS resident_phone,
         u.flat  AS resident_flat,
         t.name  AS trusted_name,
         t.phone AS trusted_phone
    FROM parcels p
    JOIN users u ON u.id = p.resident_id
    LEFT JOIN trusted_persons t ON t.id = p.trusted_person_id
`;

function getParcel(id) {
  return db.prepare(`${SELECT_PARCEL} WHERE p.id = ?`).get(id);
}

function getParcelByTracking(societyId, trackingId) {
  return db
    .prepare(`${SELECT_PARCEL} WHERE p.society_id = ? AND p.tracking_id = ?`)
    .get(societyId, trackingId);
}

// What the resident may see. The handover code is shown only when they collect personally.
function residentView(p) {
  const showCode = p.status === 'received' && p.collector === 'self' && !!p.handover_code;
  return {
    id: p.id,
    tracking_id: p.tracking_id,
    courier: p.courier,
    value: p.value,
    open_box: !!p.open_box,
    check_status: p.check_status,
    video_link: p.check_status === 'pending' ? p.video_link : null,
    status: p.status,
    slot_start: p.slot_start,
    slot_end: p.slot_end,
    collector: p.collector,
    trusted_name: p.trusted_name || null,
    handover_code: showCode ? p.handover_code : null,
    has_photo: !!p.photo_file,
    received_at: p.received_at,
    handed_over_at: p.handed_over_at,
    handed_over_to: p.handed_over_to,
    created_at: p.created_at,
  };
}

// What staff may see. Staff never see the handover code: the person collecting must show it.
function staffView(p) {
  return {
    id: p.id,
    tracking_id: p.tracking_id,
    courier: p.courier,
    value: p.value,
    open_box: !!p.open_box,
    check_status: p.check_status,
    video_link: p.video_link,
    status: p.status,
    slot_start: p.slot_start,
    slot_end: p.slot_end,
    collector: p.collector,
    resident: { name: p.resident_name, phone: p.resident_phone, flat: p.resident_flat },
    trusted: p.trusted_name ? { name: p.trusted_name, phone: p.trusted_phone } : null,
    has_photo: !!p.photo_file,
    received_at: p.received_at,
    handed_over_at: p.handed_over_at,
    handed_over_to: p.handed_over_to,
    locked: p.code_attempts >= 5,
    created_at: p.created_at,
  };
}

module.exports = { getParcel, getParcelByTracking, residentView, staffView };
