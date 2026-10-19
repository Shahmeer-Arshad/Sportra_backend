import { BadRequestError } from '../../utils/errors'
import { RequestMeta } from './identity.domain'
import { consentEvent } from './identity.events'
import { IdentityQueries } from './identity.repository'

/**
 * Records a WhatsApp opt-in or opt-out: user flags, append-only history and event.
 * Call with transaction-bound queries so the three commit together.
 */
export async function recordConsent(
  q: IdentityQueries,
  user: { id: string; phone: string | null },
  c: { action: 'OPT_IN' | 'OPT_OUT'; source: string; textVersion?: string | null },
  meta: RequestMeta,
) {
  if (!user.phone)
    throw new BadRequestError('A phone number is required for WhatsApp', 'PHONE_REQUIRED')
  const now = new Date()
  if (c.action === 'OPT_IN') {
    if (!c.textVersion)
      throw new BadRequestError('Consent text version is required', 'VALIDATION_ERROR')
    await q.updateUser(user.id, {
      whatsappOptIn: true,
      whatsappOptInAt: now,
      whatsappOptInSource: c.source,
      whatsappOptInTextVersion: c.textVersion,
      whatsappOptOutAt: null,
    })
  } else {
    await q.updateUser(user.id, { whatsappOptIn: false, whatsappOptOutAt: now })
  }
  await q.createConsent({
    userId: user.id,
    phoneE164: user.phone,
    action: c.action,
    source: c.source,
    consentTextVersion: c.textVersion ?? null,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent?.slice(0, 300) ?? null,
    occurredAt: now,
  })
  await q.emit(consentEvent(user.id, c.action, now))
}
