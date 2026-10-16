import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto'

export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex')

/** HMAC of an OTP code. The code itself is never stored. */
export const hmac = (value: string, secret: string) =>
  createHmac('sha256', secret).update(value).digest('hex')

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** 6-digit code from a cryptographically secure source. */
export const randomOtp = () => String(randomInt(0, 1_000_000)).padStart(6, '0')

/** Unguessable opaque token (base64url). */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')
