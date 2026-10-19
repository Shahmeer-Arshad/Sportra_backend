import { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { Server, Socket } from 'socket.io'
import { env } from '../config/env'
import { checkSession, authenticate } from '../hooks/auth.hook'
import { ROOM, classifyRoom, routeHotMessage } from '../modules/booking/booking.realtime'
import { ForbiddenError, UnauthorizedError } from '../utils/errors'
import { JwtPayload } from '../types'

declare module 'fastify' {
  interface FastifyInstance {
    realtime: {
      io: Server
      stats(): { connections: number; emitted: number; p95LatencyMs: number | null }
      /** Re-check every connected user now (also runs on a timer). Returns how many sockets were dropped. */
      revalidate(): Promise<number>
    }
  }
}

interface SocketUser {
  id: string
  role: 'USER' | 'PLATFORM_ADMIN'
  exp: number
  iat?: number
}

const STAFF_ROLES = ['OWNER', 'MANAGER', 'FRONT_DESK']
const MAX_ROOMS_PER_SOCKET = 20

/**
 * Real-time updates: Socket.IO at /realtime (rooms, see booking.realtime.ts) and an SSE fallback at
 * /api/v1/realtime/stream. It holds no business data. Events come from the hot lane, are
 * best-effort and carry a version; clients re-fetch the grid after a reconnect.
 */
const realtimePlugin = fp(async (app: FastifyInstance) => {
  const allowed = env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
    : ['http://localhost:3000', 'http://localhost:5173']
  const io = new Server(app.server, {
    path: '/realtime',
    serveClient: false,
    pingInterval: 20_000,
    pingTimeout: 25_000,
    cors: { origin: allowed, credentials: true },
  })

  // commit -> emit latency, the number behind the "< 100 ms" target
  const latencies: number[] = []
  let emitted = 0
  const record = (ms: number) => {
    latencies.push(ms)
    if (latencies.length > 2000) latencies.shift()
  }
  const stats = () => {
    const sorted = [...latencies].sort((a, b) => a - b)
    return {
      connections: io.engine.clientsCount + sseClients.size,
      emitted,
      p95LatencyMs: sorted.length
        ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
        : null,
    }
  }

  const sseClients = new Set<{
    send: (event: string, data: unknown, room: string) => void
    rooms: Set<string>
  }>()

  async function isStaff(userId: string, role: string, venueId: string) {
    if (role === 'PLATFORM_ADMIN') return true // read-only support view
    const m = await app.prisma.venueMembership.findUnique({
      where: { userId_venueId: { userId, venueId } },
    })
    return !!m && m.isActive && STAFF_ROLES.includes(m.role)
  }

  async function mayJoin(user: SocketUser | undefined, room: string): Promise<boolean> {
    const c = classifyRoom(room)
    if (c.kind === 'public') return true
    if (!user) return false
    if (c.kind === 'user') return c.userId === user.id
    if (c.kind === 'pos') return isStaff(user.id, user.role, c.venueId)
    return false
  }

  // ───────────── handshake: the token is optional (public rooms), but a bad token is refused ─────────────
  io.use(async (socket, next) => {
    const token = (socket.handshake.auth as { token?: string } | undefined)?.token
    if (!token) return next()
    try {
      const payload = app.jwt.verify<JwtPayload>(token)
      const role = await checkSession(app.prisma, payload)
      socket.data.user = {
        id: payload.sub,
        role,
        exp: payload.exp ?? 0,
        iat: payload.iat,
      } satisfies SocketUser
      next()
    } catch {
      next(new UnauthorizedError('Invalid or expired token', 'TOKEN_INVALID'))
    }
  })

  io.on('connection', (socket: Socket) => {
    socket.on('join', async (room: unknown, ack?: (r: unknown) => void) => {
      const reply = typeof ack === 'function' ? ack : () => undefined
      if (typeof room !== 'string') return reply({ ok: false, code: 'INVALID_ROOM' })
      if (classifyRoom(room).kind === 'invalid') return reply({ ok: false, code: 'INVALID_ROOM' })
      // one client cannot hold thousands of rooms (the socket's own room is one of them)
      if (socket.rooms.size > MAX_ROOMS_PER_SOCKET)
        return reply({ ok: false, code: 'TOO_MANY_ROOMS' })
      try {
        if (!(await mayJoin(socket.data.user, room))) return reply({ ok: false, code: 'FORBIDDEN' })
        await socket.join(room)
        reply({ ok: true, room })
      } catch {
        reply({ ok: false, code: 'ERROR' })
      }
    })
    socket.on('leave', async (room: unknown) => {
      if (typeof room === 'string') await socket.leave(room)
    })
    // access tokens are short-lived: the client sends a fresh one before the old one expires
    socket.on('reauth', async (token: unknown, ack?: (r: unknown) => void) => {
      const reply = typeof ack === 'function' ? ack : () => undefined
      try {
        const payload = app.jwt.verify<JwtPayload>(String(token))
        if (socket.data.user && socket.data.user.id !== payload.sub)
          return reply({ ok: false, code: 'FORBIDDEN' })
        const role = await checkSession(app.prisma, payload)
        socket.data.user = {
          id: payload.sub,
          role,
          exp: payload.exp ?? 0,
          iat: payload.iat,
        } satisfies SocketUser
        reply({ ok: true })
      } catch {
        reply({ ok: false, code: 'TOKEN_INVALID' })
      }
    })
    socket.emit('hello', { serverNow: new Date().toISOString() })
  })

  // ───────────── hot lane -> rooms ─────────────
  const unsubscribe = app.hotLane.subscribe((msg) => {
    const committed = msg.committedAt ? Date.parse(msg.committedAt) : NaN
    for (const r of routeHotMessage(msg)) {
      io.to(r.room).emit(r.event, r.payload)
      for (const c of sseClients) if (c.rooms.has(r.room)) c.send(r.event, r.payload, r.room)
      emitted++
    }
    if (!Number.isNaN(committed)) record(Math.max(0, Date.now() - committed))
  })

  // ───────────── keep authorisation fresh for long-lived sockets ─────────────
  async function revalidate(): Promise<number> {
    let dropped = 0
    for (const socket of io.sockets.sockets.values()) {
      const u = socket.data.user as SocketUser | undefined
      if (!u) continue
      let ok = u.exp * 1000 > Date.now()
      if (ok) {
        try {
          await checkSession(app.prisma, { sub: u.id, iat: u.iat })
        } catch {
          ok = false
        }
      }
      if (!ok) {
        socket.emit('auth.expired', { reason: 'TOKEN_EXPIRED_OR_REVOKED' })
        socket.disconnect(true)
        dropped++
        continue
      }
      // staff removed from a venue stop receiving its live grid at once
      for (const room of socket.rooms) {
        const c = classifyRoom(room)
        if (c.kind === 'pos' && !(await isStaff(u.id, u.role, c.venueId))) {
          await socket.leave(room)
          socket.emit('room.removed', { room })
        }
      }
    }
    return dropped
  }
  const timer = setInterval(() => void revalidate().catch(() => undefined), 30_000)
  timer.unref()

  app.decorate('realtime', { io, stats, revalidate })
  app.booking.realtimeStats = stats

  // ───────────── SSE fallback (for networks that block WebSockets) ─────────────
  await app.register(
    async (r) => {
      r.get(
        '/realtime/stream',
        {
          schema: {
            tags: ['Realtime'],
            querystring: {
              type: 'object',
              properties: {
                venueId: { type: 'string', format: 'uuid' },
                date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
                pos: { type: 'string', format: 'uuid' },
              },
            },
          },
        },
        async (req, reply) => {
          const q = req.query as { venueId?: string; date?: string; pos?: string }
          const rooms = new Set<string>()
          if (q.venueId)
            rooms.add(q.date ? ROOM.venueDate(q.venueId, q.date) : ROOM.venue(q.venueId))
          if (q.pos) {
            await authenticate(req, reply)
            if (!(await isStaff(req.user.sub, req.user.role, q.pos)))
              throw new ForbiddenError(
                'You do not have access to this venue',
                'VENUE_ACCESS_DENIED',
              )
            rooms.add(ROOM.pos(q.pos))
          }
          if (rooms.size === 0)
            throw new ForbiddenError('Choose a venue to follow', 'VALIDATION_ERROR')
          reply.hijack()
          const raw = reply.raw
          raw.writeHead(200, {
            ...(reply.getHeaders() as Record<string, string>),
            'content-type': 'text/event-stream',
            'cache-control': 'no-store',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          })
          raw.write(
            `event: hello\ndata: ${JSON.stringify({ serverNow: new Date().toISOString() })}\n\n`,
          )
          const client = {
            rooms,
            send: (event: string, data: unknown) =>
              raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          }
          sseClients.add(client)
          const beat = setInterval(() => raw.write(': keep-alive\n\n'), 20_000)
          req.raw.on('close', () => {
            clearInterval(beat)
            sseClients.delete(client)
          })
        },
      )
    },
    { prefix: '/api/v1' },
  )

  app.addHook('onClose', async () => {
    clearInterval(timer)
    unsubscribe()
    for (const c of sseClients) c.rooms.clear()
    sseClients.clear()
    await new Promise<void>((resolve) => io.close(() => resolve()))
  })
})

export default realtimePlugin
