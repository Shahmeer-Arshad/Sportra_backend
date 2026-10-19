import { User } from '@prisma/client'

const producer = 'identity'

/** Outbox payloads for the identity module. Pass the result to `repo.emit(...)`. */
export const userEvent = (u: User) => ({
  type: 'user.upserted',
  routingKey: 'user.upserted',
  producer,
  data: { userId: u.id, email: u.email, fullName: u.fullName, phone: u.phone, status: u.status },
})

export const sessionsRevokedEvent = (userId: string, reason: string) => ({
  type: 'user.sessions_revoked',
  routingKey: 'user.sessions_revoked',
  producer,
  data: { userId, reason },
})

export const membershipEvent = (
  userId: string,
  venueId: string,
  role: string,
  active: boolean,
) => ({
  type: 'membership.changed',
  routingKey: 'membership.changed',
  producer,
  data: { userId, venueId, role, active },
})

export const consentEvent = (userId: string, action: string, at: Date) => ({
  type: 'WhatsAppConsentChanged',
  routingKey: 'user.whatsapp_consent.changed',
  producer,
  data: { userId, action, at: at.toISOString() },
})
