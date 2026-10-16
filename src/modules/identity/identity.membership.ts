import { Prisma } from '@prisma/client'
import { uuidv7 } from '../../lib/id'
import { addOutbox } from '../../lib/outbox'

/**
 * Make a user the OWNER of a venue. Called by the venue module inside its own transaction,
 * so the venue and its owner membership are created together or not at all.
 */
export async function addOwnerMembership(
  tx: Prisma.TransactionClient,
  userId: string,
  venueId: string,
) {
  await tx.venueMembership.upsert({
    where: { userId_venueId: { userId, venueId } },
    create: { id: uuidv7(), userId, venueId, role: 'OWNER' },
    update: { role: 'OWNER', isActive: true },
  })
  await addOutbox(tx, {
    type: 'membership.changed',
    routingKey: 'membership.changed',
    producer: 'identity',
    data: { userId, venueId, role: 'OWNER', active: true },
  })
}
