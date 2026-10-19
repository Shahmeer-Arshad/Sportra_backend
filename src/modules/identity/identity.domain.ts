import { User } from '@prisma/client'

export const GENERIC_SENT = {
  message: 'If the details are valid, a code has been sent to the email address.',
}

export interface RequestMeta {
  ip?: string | null
  userAgent?: string | null
}

export interface PublicUser {
  id: string
  email: string
  fullName: string
  phone: string | null
  platformRole: string
  status: string
  emailVerified: boolean
  whatsappOptIn: boolean
}

export interface AuthResult {
  accessToken: string
  refreshToken: string
  refreshExpiresAt: Date
  user: PublicUser
}
export type LoginResult = ({ mfaRequired: false } & AuthResult) | { mfaRequired: true }

export const LOCK_AFTER_FAILURES = 10
const DISPOSABLE_DOMAINS = [
  'mailinator.com',
  'guerrillamail.com',
  '10minutemail.com',
  'tempmail.com',
]

export const normalizeEmail = (e: string) => e.trim().toLowerCase()
export const isDisposableEmail = (email: string) => DISPOSABLE_DOMAINS.includes(email.split('@')[1])

export const toPublicUser = (u: User): PublicUser => ({
  id: u.id,
  email: u.email,
  fullName: u.fullName,
  phone: u.phone,
  platformRole: u.platformRole,
  status: u.status,
  emailVerified: !!u.emailVerifiedAt,
  whatsappOptIn: u.whatsappOptIn,
})

/** Every 10 failed logins lock the account: 15 min, doubling each time, max 24 h. 0 = no lock. */
export const lockDurationMs = (failedCount: number) =>
  failedCount % LOCK_AFTER_FAILURES === 0
    ? Math.min(15 * 60_000 * 2 ** (failedCount / LOCK_AFTER_FAILURES - 1), 24 * 3600_000)
    : 0

export const isBlockedStatus = (status: string) => status === 'SUSPENDED' || status === 'DELETED'
