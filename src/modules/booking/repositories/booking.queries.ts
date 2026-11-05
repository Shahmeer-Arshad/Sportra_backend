import { Prisma } from '@prisma/client'
import { uuidv7 } from '../../../lib/id'
import { Db } from '../../../lib/outbox'
import { BOOKING_COLS, BookingRowRaw, ITEM_COLS, ItemRowRaw } from './columns'

export interface NewBooking {
  id: string
  ref: string
  venueId: string
  courtId: string
  userId: string | null
  source: 'APP' | 'WALKIN' | 'MANUAL' | 'TOURNAMENT'
  customerName: string
  customerPhone: string
  customerEmail?: string | null
  headcount?: number | null
  status: 'PENDING_PAYMENT' | 'CONFIRMED'
  paymentMode: 'CASH_ONLY' | 'DEPOSIT_20' | 'FULL_ONLINE' | 'TOURNAMENT'
  paymentStatus?: 'UNPAID' | 'PAID'
  paymentMethod?: 'CASH' | 'BANK_TRANSFER' | 'FREE'
  startAt: Date
  endAt: Date
  businessDate: string
  totalMinor: bigint
  cutoffHours: number
  slotIds: string[]
  holdId?: string | null
  holdExpiresAt?: Date | null
  cashCollectedMinor?: bigint
  createdBy: string | null
}

export type MyTab = 'upcoming' | 'past' | 'cancelled'

/** Booking rows, itemised lines, counters and small helpers every booking flow shares. */
export function bookingQueries(db: Db) {
  const count = async (q: Promise<{ n: number }[]>) => (await q)[0].n

  return {
    // ───────── session helpers ─────────
    clock: async () => (await db.$queryRaw<{ n: Date }[]>`SELECT clock_timestamp() AS n`)[0].n,
    setLockTimeout: (value: string) => db.$executeRawUnsafe(`SET LOCAL lock_timeout = '${value}'`),
    advisoryLock: (name: string) =>
      db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${name}, 0))`,

    // ───────── booking rows ─────────
    async bookingById(id: string): Promise<BookingRowRaw | null> {
      const r = await db.$queryRaw<
        BookingRowRaw[]
      >`SELECT ${BOOKING_COLS} FROM bookings WHERE id = ${id}::uuid`
      return r[0] ?? null
    },
    async lockBooking(id: string): Promise<BookingRowRaw | null> {
      const r = await db.$queryRaw<
        BookingRowRaw[]
      >`SELECT ${BOOKING_COLS} FROM bookings WHERE id = ${id}::uuid FOR UPDATE`
      return r[0] ?? null
    },
    bookingByRef: (ref: string) => db.booking.findUnique({ where: { ref } }),
    bookingItems: (bookingId: string) =>
      db.$queryRaw<ItemRowRaw[]>`
        SELECT ${ITEM_COLS} FROM booking_items WHERE booking_id = ${bookingId}::uuid ORDER BY start_at`,
    confirmedItemIds: async (bookingId: string) =>
      (
        await db.$queryRaw<{ id: string }[]>`
          SELECT id FROM booking_items WHERE booking_id = ${bookingId}::uuid AND status = 'CONFIRMED'`
      ).map((r) => r.id),

    /** Inserts a booking under the given ref. False when the ref is already taken. */
    async insertBooking(b: NewBooking): Promise<boolean> {
      const n = await db.$executeRaw`
        INSERT INTO bookings (id, ref, venue_id, court_id, user_id, source, customer_name, customer_phone, customer_email,
          headcount, status, payment_mode, payment_status, payment_method, start_at, end_at, business_date, total_minor, original_total_minor,
          cash_collected_minor, slot_ids, hold_id, hold_expires_at, cancellation_cutoff_hours, created_by)
        VALUES (${b.id}::uuid, ${b.ref}, ${b.venueId}::uuid, ${b.courtId}::uuid, ${b.userId}::uuid, ${b.source},
          ${b.customerName}, ${b.customerPhone}, ${b.customerEmail ?? null}, ${b.headcount ?? null}, ${b.status},
          ${b.paymentMode}, ${b.paymentStatus ?? 'UNPAID'}, ${b.paymentMethod ?? 'CASH'}, ${b.startAt}, ${b.endAt}, ${b.businessDate}::date, ${b.totalMinor}, ${b.totalMinor},
          ${b.cashCollectedMinor ?? 0n}, ${b.slotIds}::uuid[], ${b.holdId ?? null}::uuid, ${b.holdExpiresAt ?? null},
          ${b.cutoffHours}, ${b.createdBy}::uuid)
        ON CONFLICT (ref) DO NOTHING`
      return n === 1
    },

    /** Items are created at confirmation only (never at hold time, finding F2). Returns how many. */
    async createItems(bookingId: string, onlinePaid = 0n, deposit = 0n) {
      const r = await db.$queryRaw<{ n: number }[]>`
        SELECT create_confirmed_items(${bookingId}::uuid, ${onlinePaid}::bigint, ${deposit}::bigint) AS n`
      return r[0].n
    },

    // ───────── state changes ─────────
    expireBooking: (id: string) =>
      db.$executeRaw`
        UPDATE bookings SET status = 'EXPIRED', hold_id = NULL, hold_expires_at = NULL,
               version = version + 1, updated_at = clock_timestamp() WHERE id = ${id}::uuid`,
    confirmPayAtVenue: (id: string) =>
      db.$executeRaw`
        UPDATE bookings SET status = 'CONFIRMED', payment_mode = 'CASH_ONLY', payment_status = 'UNPAID',
               hold_id = NULL, hold_expires_at = NULL, version = version + 1, updated_at = clock_timestamp()
         WHERE id = ${id}::uuid`,
    markCheckedIn: (id: string, now: Date) =>
      db.$executeRaw`
        UPDATE bookings SET status = 'CHECKED_IN', checked_in_at = ${now}, version = version + 1, updated_at = ${now}
         WHERE id = ${id}::uuid`,
    collectCash: (id: string, amountMinor: number, balanceAfter: number) =>
      db.$executeRaw`
        UPDATE bookings SET cash_collected_minor = cash_collected_minor + ${BigInt(amountMinor)},
               payment_status = CASE WHEN ${BigInt(balanceAfter)} = 0 THEN 'PAID' ELSE payment_status END,
               version = version + 1, updated_at = clock_timestamp()
         WHERE id = ${id}::uuid`,
    markNoShow: (id: string, now: Date) =>
      db.$executeRaw`
        UPDATE bookings SET status = 'NO_SHOW', no_show_at = ${now}, forfeited_minor = forfeited_minor + deposit_minor,
               version = version + 1, updated_at = ${now} WHERE id = ${id}::uuid`,
    addNoShowStrike: (userId: string) =>
      db.$executeRaw`UPDATE users SET no_show_count = no_show_count + 1 WHERE id = ${userId}::uuid`,
    setHeadcount: (id: string, headcount: number) =>
      db.$executeRaw`
        UPDATE bookings SET headcount = ${headcount}, version = version + 1, updated_at = clock_timestamp()
         WHERE id = ${id}::uuid`,

    // ───────── limits ─────────
    pendingHolds: (userId: string) =>
      count(db.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM bookings
         WHERE user_id = ${userId}::uuid AND status = 'PENDING_PAYMENT' AND hold_expires_at > clock_timestamp()`),
    unpaidBookings: (userId: string) =>
      count(db.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM bookings
         WHERE user_id = ${userId}::uuid AND status IN ('CONFIRMED','CHECKED_IN') AND source = 'APP'
           AND balance_due_minor > 0 AND end_at > clock_timestamp()`),

    // ───────── lists ─────────
    async listMine(userId: string, tab: MyTab, limit: number, offset: number) {
      const where =
        tab === 'upcoming'
          ? Prisma.sql`((status IN ('CONFIRMED','CHECKED_IN') AND end_at > clock_timestamp())
                        OR (status = 'PENDING_PAYMENT' AND hold_expires_at > clock_timestamp()))`
          : tab === 'past'
            ? Prisma.sql`status IN ('CONFIRMED','CHECKED_IN','COMPLETED','NO_SHOW') AND end_at <= clock_timestamp()`
            : Prisma.sql`(status IN ('CANCELLED_BY_USER','CANCELLED_BY_VENUE','EXPIRED')
                          OR (status = 'PENDING_PAYMENT' AND hold_expires_at <= clock_timestamp()))`
      const order = tab === 'upcoming' ? Prisma.sql`start_at ASC` : Prisma.sql`start_at DESC`
      const rows = await db.$queryRaw<BookingRowRaw[]>`
        SELECT ${BOOKING_COLS} FROM bookings WHERE user_id = ${userId}::uuid AND ${where}
        ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`
      const total = await count(db.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM bookings WHERE user_id = ${userId}::uuid AND ${where}`)
      return { rows, total }
    },

    async dayList(
      venueId: string,
      q: {
        date?: string
        from?: string
        to?: string
        status?: string
        source?: string
        q?: string
        limit: number
        offset: number
      },
    ) {
      const status = q.status ? q.status.split(',').filter(Boolean) : null
      const source = q.source ? q.source.split(',').filter(Boolean) : null
      const text = q.q ? `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null
      const where = Prisma.sql`venue_id = ${venueId}::uuid
        ${
          q.from && q.to
            ? Prisma.sql`AND business_date BETWEEN ${q.from}::date AND ${q.to}::date`
            : q.date
              ? Prisma.sql`AND business_date = ${q.date}::date`
              : Prisma.empty
        }
        ${status ? Prisma.sql`AND status = ANY(${status}::text[])` : Prisma.sql`AND status NOT IN ('EXPIRED')`}
        ${source ? Prisma.sql`AND source = ANY(${source}::text[])` : Prisma.empty}
        ${text ? Prisma.sql`AND (customer_name ILIKE ${text} OR customer_phone ILIKE ${text} OR ref ILIKE ${text})` : Prisma.empty}`
      const rows = await db.$queryRaw<BookingRowRaw[]>`
        SELECT ${BOOKING_COLS} FROM bookings WHERE ${where} ORDER BY start_at, created_at LIMIT ${q.limit} OFFSET ${q.offset}`
      const total = await count(
        db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM bookings WHERE ${where}`,
      )
      return { rows, total }
    },

    /** All / online (APP) / walk-in (WALKIN+MANUAL) counts for the Bookings page filter chips. */
    async sourceCounts(
      venueId: string,
      range: { date?: string; from?: string; to?: string },
    ): Promise<{ all: number; online: number; walkin: number }> {
      const dateFilter =
        range.from && range.to
          ? Prisma.sql`AND business_date BETWEEN ${range.from}::date AND ${range.to}::date`
          : range.date
            ? Prisma.sql`AND business_date = ${range.date}::date`
            : Prisma.empty
      const r = await db.$queryRaw<{ all: number; online: number; walkin: number }[]>`
        SELECT count(*)::int AS all,
               count(*) FILTER (WHERE source = 'APP')::int AS online,
               count(*) FILTER (WHERE source IN ('WALKIN', 'MANUAL'))::int AS walkin
          FROM bookings WHERE venue_id = ${venueId}::uuid ${dateFilter} AND status NOT IN ('EXPIRED')`
      return r[0] ?? { all: 0, online: 0, walkin: 0 }
    },

    /** "Bookings today" tile on the owner Home page: how many, how many already arrived. */
    async bookingCountsForDay(
      venueId: string,
      date: string,
    ): Promise<{ total: number; arrived: number; upcoming: number }> {
      const r = await db.$queryRaw<{ total: number; arrived: number; upcoming: number }[]>`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE status IN ('CHECKED_IN', 'COMPLETED'))::int AS arrived,
               count(*) FILTER (WHERE status = 'CONFIRMED')::int AS upcoming
          FROM bookings WHERE venue_id = ${venueId}::uuid AND business_date = ${date}::date
            AND status NOT IN ('EXPIRED')`
      return r[0] ?? { total: 0, arrived: 0, upcoming: 0 }
    },

    /** Sum of what's still owed at the venue for the day's active bookings (POS day-summary tile). */
    async stillToCollectForDay(
      venueId: string,
      date: string,
    ): Promise<{ amountMinor: bigint; bookingCount: number }> {
      const r = await db.$queryRaw<{ amount_minor: bigint; booking_count: number }[]>`
        SELECT COALESCE(SUM(balance_due_minor), 0)::bigint AS amount_minor,
               count(*) FILTER (WHERE balance_due_minor > 0)::int AS booking_count
          FROM bookings
         WHERE venue_id = ${venueId}::uuid AND business_date = ${date}::date
           AND status IN ('CONFIRMED', 'CHECKED_IN')`
      return { amountMinor: r[0].amount_minor, bookingCount: r[0].booking_count }
    },

    /** Next few not-yet-checked-in bookings today, soonest first, for the "arriving next" rail. */
    async arrivingNext(venueId: string, date: string, now: Date, limit: number) {
      return db.$queryRaw<
        Pick<
          BookingRowRaw,
          'id' | 'ref' | 'source' | 'customer_name' | 'start_at' | 'balance_due_minor' | 'court_id'
        >[]
      >`
        SELECT id, ref, source, customer_name, start_at, balance_due_minor, court_id FROM bookings
         WHERE venue_id = ${venueId}::uuid AND business_date = ${date}::date AND status = 'CONFIRMED'
           AND start_at >= ${now}
         ORDER BY start_at LIMIT ${limit}`
    },

    // ───────── names and contacts ─────────
    venueName: (id: string) => db.venue.findUnique({ where: { id }, select: { name: true } }),
    courtName: (id: string) => db.court.findUnique({ where: { id }, select: { name: true } }),
    venueNames: (ids: string[]) =>
      db.venue.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    courtNames: (ids: string[]) =>
      db.court.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    courtNamesOfVenue: (venueId: string) =>
      db.court.findMany({ where: { venueId }, select: { id: true, name: true } }),
    venueById: (id: string) => db.venue.findUnique({ where: { id } }),
    courtById: (id: string) => db.court.findUnique({ where: { id } }),
    userContact: (id: string) =>
      db.user.findUnique({ where: { id }, select: { fullName: true, email: true, phone: true } }),
    courtCountInVenue: (venueId: string, courtIds: string[]) =>
      db.court.count({ where: { venueId, id: { in: courtIds } } }),

    // ───────── invites ─────────
    activeInvites: (bookingId: string) =>
      db.invite.count({ where: { bookingId, revokedAt: null, expiresAt: { gt: new Date() } } }),
    createInvite: (data: Omit<Prisma.InviteUncheckedCreateInput, 'id'>) =>
      db.invite.create({ data: { id: uuidv7(), ...data } }),
    invitesWithRsvps: (bookingId: string) =>
      db.invite.findMany({
        where: { bookingId },
        orderBy: { createdAt: 'desc' },
        include: { rsvps: { orderBy: { createdAt: 'asc' } } },
      }),
    revokeInvite: async (id: string, bookingId: string) =>
      (
        await db.invite.updateMany({
          where: { id, bookingId, revokedAt: null },
          data: { revokedAt: new Date() },
        })
      ).count,
    inviteByHash: (tokenHash: string) => db.invite.findUnique({ where: { tokenHash } }),
    inviteWithRsvps: (tokenHash: string) =>
      db.invite.findUnique({ where: { tokenHash }, include: { rsvps: true } }),
    rsvpCount: (inviteId: string) => db.inviteRsvp.count({ where: { inviteId } }),
    findRsvp: (inviteId: string, rsvpKey: string) =>
      db.inviteRsvp.findUnique({ where: { inviteId_rsvpKey: { inviteId, rsvpKey } } }),
    upsertRsvp: (
      inviteId: string,
      rsvpKey: string,
      v: { name: string; phone: string | null; status: string },
    ) =>
      db.inviteRsvp.upsert({
        where: { inviteId_rsvpKey: { inviteId, rsvpKey } },
        create: { id: uuidv7(), inviteId, name: v.name, phone: v.phone, rsvpKey, status: v.status },
        update: { name: v.name, status: v.status, updatedAt: new Date() },
      }),
    goingCount: (bookingId: string) =>
      count(db.$queryRaw<{ n: number }[]>`
        SELECT count(DISTINCT r.rsvp_key)::int AS n FROM invite_rsvps r JOIN invites i ON i.id = r.invite_id
         WHERE i.booking_id = ${bookingId}::uuid AND r.status = 'GOING'`),

    // ───────── venue settings and blocklist ─────────
    bookingSettings: (venueId: string) => db.bookingSettings.findUnique({ where: { venueId } }),
    upsertSettings: (venueId: string, payAtVenueEnabled: boolean, updatedBy: string) =>
      db.bookingSettings.upsert({
        where: { venueId },
        create: { venueId, payAtVenueEnabled, updatedBy },
        update: { payAtVenueEnabled, updatedBy, updatedAt: new Date() },
      }),
    isBlocklisted: async (venueId: string, phone: string) =>
      (await db.venueBlocklist.count({ where: { venueId, phone } })) > 0,
    addBlock: (venueId: string, phone: string, reason: string | null, createdBy: string) =>
      db.venueBlocklist.upsert({
        where: { venueId_phone: { venueId, phone } },
        create: { venueId, phone, reason, createdBy },
        update: { reason },
      }),
    blocklist: (venueId: string) =>
      db.venueBlocklist.findMany({ where: { venueId }, orderBy: { createdAt: 'desc' } }),
    removeBlock: async (venueId: string, phone: string) =>
      (await db.venueBlocklist.deleteMany({ where: { venueId, phone } })).count,
  }
}
