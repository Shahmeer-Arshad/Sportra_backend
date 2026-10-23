const uuid = { type: 'string', format: 'uuid' }
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }
const dateTime = { type: 'string', format: 'date-time' }
const phone = { type: 'string', pattern: '^\\+?[0-9 \\-]{10,18}$' }
const uuidList = (min: number, max: number) => ({
  type: 'array',
  items: uuid,
  minItems: min,
  maxItems: max,
  uniqueItems: true,
})

export const holdBody = {
  type: 'object',
  required: ['courtId', 'slotIds'],
  properties: { courtId: uuid, slotIds: uuidList(1, 4), customerPhone: phone },
}

export const cancelBody = {
  type: 'object',
  properties: { itemIds: uuidList(1, 12), reason: { type: 'string', maxLength: 300 } },
}

// Ajv runs with removeAdditional:'all', so every path parameter must be listed or it is stripped
export const idParams = {
  type: 'object',
  properties: { id: uuid, venueId: uuid, inviteId: uuid },
}
export const bookingItemQuery = { type: 'object', properties: { itemIds: uuidList(1, 12) } }

export const myBookingsQuery = {
  type: 'object',
  properties: {
    tab: { type: 'string', enum: ['upcoming', 'past', 'cancelled'], default: 'upcoming' },
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    offset: { type: 'integer', minimum: 0, default: 0 },
  },
}

export const availabilityQuery = {
  type: 'object',
  required: ['date'],
  properties: { date, courtId: uuid },
}

export const rsvpBody = {
  type: 'object',
  required: ['name', 'status'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 60 },
    phone,
    status: { type: 'string', enum: ['GOING', 'NOT_GOING'] },
  },
}
export const headcountBody = {
  type: 'object',
  required: ['headcount'],
  properties: { headcount: { type: 'integer', minimum: 1, maximum: 100 } },
}

// ───────────── POS ─────────────
export const gridQuery = { type: 'object', required: ['date'], properties: { date, courtId: uuid } }

const staffBookingProps = {
  courtId: uuid,
  slotIds: uuidList(1, 12),
  customerName: { type: 'string', minLength: 1, maxLength: 80 },
  customerPhone: phone,
  cashCollectedMinor: { type: 'integer', minimum: 0, maximum: 100000000 },
  headcount: { type: 'integer', minimum: 1, maximum: 100 },
}
export const walkInBody = {
  type: 'object',
  required: ['courtId', 'slotIds', 'customerName', 'customerPhone'],
  properties: staffBookingProps,
}
export const manualBody = {
  type: 'object',
  required: ['courtId', 'slotIds', 'customerName', 'customerPhone'],
  properties: { ...staffBookingProps, payLater: { type: 'boolean' } },
}

export const dayListQuery = {
  type: 'object',
  properties: {
    date,
    status: { type: 'string', maxLength: 200 },
    q: { type: 'string', minLength: 1, maxLength: 60 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    offset: { type: 'integer', minimum: 0, default: 0 },
  },
}

export const checkInBody = {
  type: 'object',
  properties: {
    token: { type: 'string', maxLength: 2000 },
    ref: { type: 'string', maxLength: 20 },
  },
}
export const collectBody = {
  type: 'object',
  required: ['amountMinor'],
  properties: { amountMinor: { type: 'integer', minimum: 1, maximum: 100000000 } },
}

const window = {
  courtIds: uuidList(1, 50),
  from: dateTime,
  to: dateTime,
}
export const blockBody = {
  type: 'object',
  required: ['courtIds', 'from', 'to', 'reason'],
  properties: {
    ...window,
    reason: {
      type: 'string',
      enum: ['RAIN', 'POWER_OUTAGE', 'MAINTENANCE', 'PRIVATE_EVENT', 'OTHER'],
    },
    note: { type: 'string', maxLength: 300 },
  },
}
export const unblockQuery = {
  type: 'object',
  required: ['courtIds', 'from', 'to'],
  properties: window,
}
export const outageBody = {
  type: 'object',
  required: ['courtIds', 'from', 'to', 'reason'],
  properties: {
    ...window,
    reason: { type: 'string', enum: ['RAIN', 'POWER_OUTAGE', 'MAINTENANCE', 'OTHER'] },
    note: { type: 'string', maxLength: 300 },
  },
}
export const outagePreviewBody = {
  type: 'object',
  required: ['courtIds', 'from', 'to'],
  properties: window,
}
export const settingsBody = {
  type: 'object',
  required: ['payAtVenueEnabled'],
  properties: { payAtVenueEnabled: { type: 'boolean' } },
}
export const blocklistBody = {
  type: 'object',
  required: ['phone'],
  properties: { phone, reason: { type: 'string', maxLength: 200 } },
}
export const blocklistParams = {
  type: 'object',
  properties: { phone: { type: 'string', maxLength: 20 } },
}

// ───────────── admin ─────────────
export const adminSearchQuery = {
  type: 'object',
  properties: {
    ref: { type: 'string', maxLength: 20 },
    email: { type: 'string', maxLength: 100 },
    phone: { type: 'string', maxLength: 20 },
    venueId: uuid,
    date,
    status: { type: 'string', maxLength: 200 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
    offset: { type: 'integer', minimum: 0, default: 0 },
  },
}
export const adminCancelBody = {
  type: 'object',
  required: ['reason'],
  properties: {
    reason: { type: 'string', minLength: 5, maxLength: 300 },
    itemIds: uuidList(1, 12),
  },
}
export const adminUnblockBody = {
  type: 'object',
  required: ['slotIds', 'reason'],
  properties: {
    slotIds: uuidList(1, 200),
    reason: { type: 'string', minLength: 5, maxLength: 300 },
  },
}
