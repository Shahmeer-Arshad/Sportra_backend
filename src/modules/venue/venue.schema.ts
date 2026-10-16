import { AMENITIES, RADII_KM, SPORTS, SURFACES } from './venue.domain'

const uuid = { type: 'string', format: 'uuid' }
const hhmm = { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' }
const phone = { type: 'string', pattern: '^\\+?[0-9]{10,15}$' }
const amenities = {
  type: 'array',
  items: { type: 'string', enum: [...AMENITIES] },
  maxItems: 20,
  uniqueItems: true,
}

const venueFields = {
  name: { type: 'string', minLength: 3, maxLength: 120 },
  city: { type: 'string', minLength: 2, maxLength: 60 },
  areaId: uuid,
  address: { type: 'string', minLength: 5, maxLength: 300 },
  lat: { type: 'number', minimum: -90, maximum: 90 },
  lng: { type: 'number', minimum: -180, maximum: 180 },
  amenities,
  whatsappNumber: phone,
  contactPhone: phone,
  contactEmail: { type: 'string', format: 'email' },
  operatingHours: { type: 'object' },
  cancellationCutoffHours: { type: 'integer', minimum: 12, maximum: 24 },
  onboardingStep: { type: 'integer', minimum: 1, maximum: 8 },
}

export const createVenueBody = {
  type: 'object',
  required: ['name', 'city', 'address', 'lat', 'lng', 'operatingHours'],
  properties: venueFields,
}
export const updateVenueBody = { type: 'object', properties: venueFields }

export const courtBody = {
  type: 'object',
  required: ['name', 'sport', 'surface'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 80 },
    sport: { type: 'string', enum: [...SPORTS] },
    surface: { type: 'string', enum: [...SURFACES] },
    capacity: { type: 'integer', minimum: 1, maximum: 200 },
    slotMinutes: { type: 'integer', enum: [30, 60, 90, 120] },
    hoursOverride: { type: 'object' },
  },
}
export const courtPatchBody = {
  type: 'object',
  properties: { ...courtBody.properties, isActive: { type: 'boolean' } },
}

const ruleProps = {
  courtId: uuid,
  name: { type: 'string', minLength: 1, maxLength: 80 },
  dayType: { type: 'string', enum: ['ANY', 'WEEKDAY', 'WEEKEND', 'DATE_RANGE'] },
  startDate: { type: 'string', format: 'date' },
  endDate: { type: 'string', format: 'date' },
  fromTime: hhmm,
  toTime: hhmm,
  // paisa as an integer; amounts are never decimals
  priceMinor: { type: 'integer', minimum: 0, maximum: 100000000 },
  priority: { type: 'integer', minimum: 0, maximum: 100, default: 0 },
  tag: { type: 'string', enum: ['PEAK', 'OFF_PEAK'] },
}
export const pricingRuleBody = {
  type: 'object',
  required: ['courtId', 'name', 'dayType', 'fromTime', 'toTime', 'priceMinor', 'tag'],
  properties: ruleProps,
}
export const pricingRulePatchBody = { type: 'object', properties: { ...ruleProps } }

export const reviewBody = {
  type: 'object',
  required: ['decision'],
  properties: {
    decision: { type: 'string', enum: ['APPROVED', 'CHANGES_REQUESTED', 'REJECTED'] },
    comments: { type: 'string', maxLength: 2000 },
    fieldFlags: {
      type: 'array',
      maxItems: 30,
      items: {
        type: 'object',
        required: ['field', 'note'],
        properties: {
          field: { type: 'string', maxLength: 60 },
          note: { type: 'string', maxLength: 500 },
        },
      },
    },
  },
}
export const reasonBody = {
  type: 'object',
  required: ['reason'],
  properties: { reason: { type: 'string', minLength: 3, maxLength: 500 } },
}

export const areaBody = {
  type: 'object',
  required: ['city', 'name'],
  properties: {
    city: { type: 'string', minLength: 2, maxLength: 60 },
    name: { type: 'string', minLength: 2, maxLength: 80 },
    aliases: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 20 },
    lat: { type: 'number', minimum: -90, maximum: 90 },
    lng: { type: 'number', minimum: -180, maximum: 180 },
  },
}

export const searchQuery = {
  type: 'object',
  properties: {
    lat: { type: 'number', minimum: -90, maximum: 90 },
    lng: { type: 'number', minimum: -180, maximum: 180 },
    radiusKm: { type: 'integer', enum: [...RADII_KM], default: 10 },
    city: { type: 'string', maxLength: 60 },
    areaId: uuid,
    sport: { type: 'array', items: { type: 'string', enum: [...SPORTS] }, maxItems: 6 },
    surface: { type: 'array', items: { type: 'string', enum: [...SURFACES] }, maxItems: 5 },
    amenities,
    q: { type: 'string', minLength: 2, maxLength: 60 },
    sort: { type: 'string', enum: ['distance', 'price', 'name'], default: 'distance' },
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    cursor: { type: 'string', maxLength: 40 },
  },
}
