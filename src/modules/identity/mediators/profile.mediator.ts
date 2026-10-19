import { ConflictError } from '../../../utils/errors'
import { recordConsent } from '../identity.consent'
import { IdentityDeps } from '../identity.deps'
import { RequestMeta, toPublicUser } from '../identity.domain'
import { userEvent } from '../identity.events'

/** Profile edits. A phone change withdraws WhatsApp consent because consent belongs to a number. */
export const profileMediator = ({ repo }: IdentityDeps) => ({
  async updateMe(
    userId: string,
    input: { fullName?: string; phone?: string | null },
    meta: RequestMeta,
  ) {
    const current = await repo.userByIdOrThrow(userId)
    if (input.phone && input.phone !== current.phone && (await repo.userByPhone(input.phone))) {
      throw new ConflictError('This phone number is already in use', 'PHONE_IN_USE')
    }
    const phoneChanged = input.phone !== undefined && input.phone !== current.phone
    const updated = await repo.transaction(async (q) => {
      if (phoneChanged && current.whatsappOptIn) {
        await recordConsent(q, current, { action: 'OPT_OUT', source: 'PROFILE_SETTINGS' }, meta)
      }
      const u = await q.updateUser(userId, {
        ...(input.fullName !== undefined && { fullName: input.fullName.trim() }),
        ...(phoneChanged && { phone: input.phone, phoneVerifiedAt: null }),
      })
      await q.emit(userEvent(u))
      return u
    })
    return toPublicUser(updated)
  },

  async setWhatsappConsent(
    userId: string,
    input: { action: 'OPT_IN' | 'OPT_OUT'; textVersion?: string; source?: string },
    meta: RequestMeta,
  ) {
    const user = await repo.userByIdOrThrow(userId)
    const consent = {
      action: input.action,
      source: input.source ?? 'PROFILE_SETTINGS',
      textVersion: input.textVersion,
    }
    await repo.transaction((q) => recordConsent(q, user, consent, meta))
    const u = await repo.userByIdOrThrow(userId)
    return {
      whatsappOptIn: u.whatsappOptIn,
      optInAt: u.whatsappOptInAt,
      optOutAt: u.whatsappOptOutAt,
    }
  },
})
