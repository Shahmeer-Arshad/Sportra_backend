/**
 * Watch live slot changes of a venue while you click around in Swagger or the POS.
 *
 *   npx tsx scripts/watch-venue.ts <venueId> [YYYY-MM-DD] [staffAccessToken]
 *
 * Without a token you see what a player sees (public fields). With a staff token for that venue you
 * also join the POS room and see full detail. Needs the API running (npm run dev) and Redis if you
 * want updates made by the worker (hold sweeper) to show up.
 */
import { io } from 'socket.io-client'

const [venueId, date, token] = process.argv.slice(2)
if (!venueId) {
  console.error('usage: npx tsx scripts/watch-venue.ts <venueId> [YYYY-MM-DD] [staffAccessToken]')
  process.exit(1)
}
const url = process.env.API_URL ?? 'http://localhost:3000'
const socket = io(url, { path: '/realtime', auth: token ? { token } : {}, transports: ['websocket'] })

const rooms = [date ? `venue:${venueId}:date:${date}` : `venue:${venueId}`]
if (token) rooms.push(`pos:${venueId}`)

socket.on('connect', async () => {
  console.log(`connected (${socket.id})`)
  for (const room of rooms) {
    socket.emit('join', room, (r: { ok: boolean; code?: string }) =>
      console.log(r.ok ? `joined ${room}` : `could not join ${room}: ${r.code}`),
    )
  }
})
socket.on('connect_error', (e) => console.error('connect error:', e.message))
for (const ev of ['slot.updated', 'booking.updated', 'outage.progress', 'grid.changed', 'room.removed', 'auth.expired'])
  socket.on(ev, (p) => console.log(new Date().toISOString().slice(11, 23), ev, JSON.stringify(p)))
