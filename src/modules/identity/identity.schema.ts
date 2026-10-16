// JSON Schemas for Fastify route validation (Ajv: removeAdditional=all, coerceTypes=true).
const email = { type: 'string', format: 'email', maxLength: 254 }
const password = {
  type: 'string',
  minLength: 8,
  maxLength: 72,
  pattern: '^(?=.*[A-Za-z])(?=.*[0-9]).+$',
}
const code = { type: 'string', pattern: '^[0-9]{6}$' }
const phone = { type: 'string', pattern: '^\\+?[0-9]{10,15}$' }

export const registerBody = {
  type: 'object',
  required: ['email', 'password', 'fullName'],
  properties: {
    email,
    password,
    fullName: { type: 'string', minLength: 2, maxLength: 120 },
    phone,
    signupIntent: { type: 'string', enum: ['PLAYER', 'OWNER'] },
    whatsappConsent: {
      type: 'object',
      required: ['optIn'],
      properties: { optIn: { type: 'boolean' }, textVersion: { type: 'string', maxLength: 40 } },
    },
  },
}
export const emailCodeBody = {
  type: 'object',
  required: ['email', 'code'],
  properties: { email, code },
}
export const emailBody = { type: 'object', required: ['email'], properties: { email } }
export const loginBody = {
  type: 'object',
  required: ['email', 'password'],
  properties: { email, password: { type: 'string', minLength: 1, maxLength: 72 } },
}
export const resetBody = {
  type: 'object',
  required: ['email', 'code', 'newPassword'],
  properties: { email, code, newPassword: password },
}
export const updateMeBody = {
  type: 'object',
  properties: {
    fullName: { type: 'string', minLength: 2, maxLength: 120 },
    phone: { type: ['string', 'null'], pattern: '^\\+?[0-9]{10,15}$' },
  },
}
export const consentBody = {
  type: 'object',
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ['OPT_IN', 'OPT_OUT'] },
    textVersion: { type: 'string', maxLength: 40 },
  },
}
export const emailChangeBody = {
  type: 'object',
  required: ['newEmail', 'password'],
  properties: { newEmail: email, password: { type: 'string', minLength: 1, maxLength: 72 } },
}
export const emailChangeConfirmBody = {
  type: 'object',
  required: ['newEmail', 'code'],
  properties: { newEmail: email, code },
}
export const inviteBody = {
  type: 'object',
  required: ['email', 'role'],
  properties: { email, role: { type: 'string', enum: ['MANAGER', 'FRONT_DESK', 'SCORER'] } },
}
export const acceptInviteBody = {
  type: 'object',
  required: ['token'],
  properties: {
    token: { type: 'string', minLength: 20, maxLength: 200 },
    fullName: { type: 'string', minLength: 2, maxLength: 120 },
    password,
  },
}
export const pageQuery = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    offset: { type: 'integer', minimum: 0, default: 0 },
  },
}
