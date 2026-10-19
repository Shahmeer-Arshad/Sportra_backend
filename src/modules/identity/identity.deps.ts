import { FastifyBaseLogger } from 'fastify'
import { Mailer } from '../../lib/mailer'
import { IdentityRepository } from './identity.repository'
import { OtpService } from './identity.otp'
import { SessionService } from './identity.session'

/** What the identity service and mediators are built from. */
export interface IdentityDeps {
  repo: IdentityRepository
  otp: OtpService
  session: SessionService
  mailer: Mailer
  log: FastifyBaseLogger
}
