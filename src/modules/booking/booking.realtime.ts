/**
 * Maps a hot-lane message to the socket rooms that should receive it, and strips what each
 * audience must not see. Pure, so the "public rooms never carry customer data" rule is unit-tested.
 *
 * Rooms:
 *   pos:{venueId}                 staff of the venue: full detail
 *   venue:{venueId}:date:{date}   anyone viewing that venue and day: public fields only
 *   venue:{venueId}               anyone viewing the venue: "refetch the grid" hints
 *   user:{userId}                 the user's own booking changes
 */
import { HotMessage } from '../../lib/hotlane'
import { SlotStatus, publicStatus } from './booking.domain'

export interface RoutedEvent {
  room: string
  event: string
  payload: Record<string, unknown>
}

export const ROOM = {
  pos: (venueId: string) => `pos:${venueId}`,
  venueDate: (venueId: string, date: string) => `venue:${venueId}:date:${date}`,
  venue: (venueId: string) => `venue:${venueId}`,
  user: (userId: string) => `user:${userId}`,
  tournament: (id: string) => `tournament:${id}`,
}

const s = (v: unknown) => (typeof v === 'string' ? v : undefined)

export function routeHotMessage(msg: HotMessage): RoutedEvent[] {
  const venueId = s(msg.venueId)
  const at = s(msg.committedAt) ?? new Date().toISOString()
  switch (msg.type) {
    case 'slot.updated': {
      if (!venueId) return []
      const date = s(msg.businessDate)
      const out: RoutedEvent[] = [
        {
          room: ROOM.pos(venueId),
          event: 'slot.updated',
          payload: {
            type: 'slot.updated',
            venueId,
            courtId: msg.courtId,
            slotId: msg.slotId,
            businessDate: date,
            status: msg.status,
            version: msg.version,
            holdExpiresAt: msg.holdExpiresAt ?? null,
            bookingId: msg.bookingId ?? null,
            blockReason: msg.blockReason ?? null,
            at,
          },
        },
      ]
      if (date)
        out.push({
          room: ROOM.venueDate(venueId, date),
          event: 'slot.updated',
          // a player sees "held" or "booked", never who or why
          payload: {
            type: 'slot.updated',
            venueId,
            courtId: msg.courtId,
            slotId: msg.slotId,
            status: publicStatus(msg.status as SlotStatus),
            version: msg.version,
            at,
          },
        })
      return out
    }
    case 'booking.updated': {
      const base = {
        type: 'booking.updated',
        bookingId: msg.bookingId,
        ref: msg.ref,
        status: msg.status,
        at,
      }
      const out: RoutedEvent[] = []
      if (venueId)
        out.push({
          room: ROOM.pos(venueId),
          event: 'booking.updated',
          payload: { ...base, venueId },
        })
      const userId = s(msg.userId)
      if (userId) out.push({ room: ROOM.user(userId), event: 'booking.updated', payload: base })
      return out
    }
    case 'outage.progress':
      return venueId
        ? [
            {
              room: ROOM.pos(venueId),
              event: 'outage.progress',
              payload: { ...msg, type: 'outage.progress', at },
            },
          ]
        : []
    case 'grid.changed':
      return venueId
        ? [
            {
              room: ROOM.pos(venueId),
              event: 'grid.changed',
              payload: { type: 'grid.changed', venueId, at },
            },
            {
              room: ROOM.venue(venueId),
              event: 'grid.changed',
              payload: { type: 'grid.changed', venueId, at },
            },
          ]
        : []
    default:
      return []
  }
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
export type RoomKind =
  | { kind: 'public' }
  | { kind: 'pos'; venueId: string }
  | { kind: 'user'; userId: string }
  | { kind: 'invalid' }

/** What a room name asks for. The caller then decides whether this socket may join. */
export function classifyRoom(room: string): RoomKind {
  if (new RegExp(`^venue:${UUID}(:date:\\d{4}-\\d{2}-\\d{2})?$`, 'i').test(room))
    return { kind: 'public' }
  if (new RegExp(`^tournament:${UUID}$`, 'i').test(room)) return { kind: 'public' }
  const pos = room.match(new RegExp(`^pos:(${UUID})$`, 'i'))
  if (pos) return { kind: 'pos', venueId: pos[1].toLowerCase() }
  const user = room.match(new RegExp(`^user:(${UUID})$`, 'i'))
  if (user) return { kind: 'user', userId: user[1].toLowerCase() }
  return { kind: 'invalid' }
}
