import { Db } from './outbox'

export interface AuditInput {
  actorId?: string | null
  actorType?: 'USER' | 'STAFF' | 'ADMIN' | 'SYSTEM'
  venueId?: string | null
  action: string
  entity: string
  entityId?: string | null
  before?: unknown
  after?: unknown
  ip?: string | null
  requestId?: string | null
}

/** Append an audit row. Pass the transaction client so it commits with the change it describes. */
export async function audit(tx: Db, a: AuditInput): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO audit_logs (actor_id, actor_type, venue_id, action, entity, entity_id, before, after, ip, request_id)
    VALUES (${a.actorId ?? null}::uuid, ${a.actorType ?? null}, ${a.venueId ?? null}::uuid, ${a.action}, ${a.entity},
            ${a.entityId ?? null}, ${a.before === undefined ? null : JSON.stringify(a.before)}::jsonb,
            ${a.after === undefined ? null : JSON.stringify(a.after)}::jsonb, ${a.ip ?? null}, ${a.requestId ?? null})`
}
