import { uuidv7 } from './id'

/** Envelope every event uses: {id,type,version,occurredAt,producer,traceId,data} */
export interface DomainEvent<T = unknown> {
  id: string
  type: string
  version: number
  occurredAt: string
  producer: string
  traceId: string | null
  data: T
}

export function buildEvent<T>(input: {
  type: string
  producer: string
  data: T
  version?: number
  traceId?: string | null
  occurredAt?: Date
}): DomainEvent<T> {
  return {
    id: uuidv7(),
    type: input.type,
    version: input.version ?? 1,
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
    producer: input.producer,
    traceId: input.traceId ?? null,
    data: input.data,
  }
}
