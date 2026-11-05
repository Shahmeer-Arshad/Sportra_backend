# Ground Owner API Flow

Simple, plain-language map of every API the Ground Owner / POS portal uses: why it exists and which screen or action calls it. All routes are under `/api/v1`. Staff-scoped routes live under `/pos/venues/:venueId/*` and need a venue membership (`OWNER`, `MANAGER`, or `FRONT_DESK` — each route says which).

Not covered here: player-facing (`/me/*`, `/bookings/*`) and admin-only (`/admin/*`) routes — see the other portals.

---

## 1. Sign up and create a venue

| API | Why | Used on |
|---|---|---|
| `POST /venues` | Create a new ground (starts in `DRAFT`). | "Add a new ground" |
| `GET /me/venues` | List every ground the owner/staff member belongs to, with `myRole`, `courtCount`, `pendingChangeCount`. | **My Grounds** (the cards), venue switcher dropdown on every POS screen |

## 2. Venue setup (onboarding wizard)

| API | Why | Used on |
|---|---|---|
| `GET /pos/venues/:venueId` | Read one venue's full detail while editing. | Edit-slots / venue settings |
| `PATCH /pos/venues/:venueId` | Save basics, hours, policy. On a `VERIFIED` venue, risky fields (hours, location) are queued as a change request (202) instead of applied immediately. | Onboarding wizard, venue settings |
| `POST /pos/venues/:venueId/submit` | Owner sends the venue for admin review. | Onboarding wizard, last step |
| `GET /pos/venues/:venueId/verification` | Poll review status (`SUBMITTED` → `VERIFIED` / `CHANGES_REQUESTED`). | My Grounds card status badge |
| `POST /pos/venues/:venueId/copy` | Clone an existing venue as a new draft (fast-track a second branch). | "Add a new ground" (from template) |
| `GET /pos/venues/:venueId/change-requests` | List this venue's pending/past change requests. | My Grounds "1 change needed" banner, venue settings |
| `DELETE /pos/venues/:venueId/change-requests/:changeId` | Owner withdraws a change before an admin decides it. | Venue settings |
| `GET/POST /pos/venues/:venueId/courts` | List / add courts. Adding to a `VERIFIED` venue queues a change request. | Onboarding wizard, My Grounds "X courts" |
| `PATCH /pos/venues/:venueId/courts/:courtId` | Edit a court. | Onboarding wizard |
| `GET/POST /pos/venues/:venueId/pricing-rules`, `DELETE .../pricing-rules/:ruleId` | Set peak/off-peak price bands. | Onboarding wizard |
| `GET /pos/venues/:venueId/pricing-preview` | Preview the price grid before saving. | Onboarding wizard |
| `POST /me/uploads`, `POST /pos/venues/:venueId/uploads` | Upload photos (venue, court, profile). | Onboarding wizard |

## 3. Staff

| API | Why | Used on |
|---|---|---|
| `GET /pos/venues/:venueId/staff` | List staff and their roles. | Venue settings |
| `POST /pos/venues/:venueId/staff/invitations` | Owner invites a Manager/Front Desk by email. | Venue settings |
| `DELETE /pos/venues/:venueId/staff/:membershipId` | Remove a staff member (immediate token revocation). | Venue settings |

## 4. Live POS grid (the main operating screen)

| API | Why | Used on |
|---|---|---|
| `GET /pos/venues/:venueId/grid?date=` | The hour-by-hour court grid: who's booked, held, walked-in, blocked. Never cached — always live. | **Live POS** |
| `GET /pos/venues/:venueId/day-summary?date=` | The four header tiles (booked/total hours, cash today, still to collect, cash in drawer), the "Arriving next" rail, and `bookingsToday{total,arrived,upcoming}`. Computed from the cash ledger + slots + bookings, server-side. | **Live POS** header, **Home** dashboard stat tiles |
| `POST /pos/venues/:venueId/walkins` | Record a walk-in: pick hour(s), name, phone, `method` (`CASH`/`BANK_TRANSFER`/`FREE`). `CASH` posts a `WALKIN_CASH` ledger credit; `FREE` comps the full price (owes nothing, no ledger entry); `BANK_TRANSFER` marks paid but never touches the physical drawer. | **Live POS** → "+ New walk-in" |
| `POST /pos/venues/:venueId/bookings/manual` | Same as a walk-in, for a phone/WhatsApp booking; has a `payLater` flag that leaves the balance open. | **Bookings** → "+ Phone booking" |
| `POST .../bookings/:id/collect-balance` | Collect cash owed on a booking; posts a `CASH_COLLECTED` ledger credit. | **Bookings** detail panel → "Collect Rs X" |
| `POST /pos/venues/:venueId/check-in`, `POST .../bookings/:id/check-in` | Check a player in, by QR token, booking ref, or booking id. | **Bookings** detail panel → "Check in" |
| `POST .../bookings/:id/no-show` | Mark a booking as a no-show. | **Bookings** detail panel → "Mark no-show" |

## 5. Bookings page (list + detail)

| API | Why | Used on |
|---|---|---|
| `GET /pos/venues/:venueId/bookings` | The bookings table. Supports `date` (exact day) or `range=today\|tomorrow\|week\|all`, `source=APP,WALKIN,MANUAL,TOURNAMENT`, free-text `q`. Response `meta.counts = {all, online, walkin}` feeds the filter-chip badges. | **Bookings** list, tab counts |
| `GET /pos/venues/:venueId/bookings/:id` | One booking's full detail (customer, money breakdown, status). | **Bookings** right-hand detail panel |
| `POST .../bookings/:id/cancel` | Manager/Owner cancels a booking. Optional `cashRefundedMinor` (only on this staff route — never the player's own cancel endpoint) records cash physically handed back, posting a `REFUND_OUT` ledger debit. | **Bookings** detail panel → "Cancel booking" |

## 6. Blocks and the Rain Lock / Emergency Close

| API | Why | Used on |
|---|---|---|
| `POST/DELETE /pos/venues/:venueId/blocks` | Block or free specific hours (maintenance, private event) without touching confirmed bookings. | Court schedule editing |
| `POST .../outage-lock/preview` | Preview impact before closing the ground: hours blocked, app bookings affected, distinct players, walk-ins needing a phone call. | **Rain Lock** screen, step 1 |
| `POST .../outage-lock` | Execute it: blocks the window, cancels every affected app booking (full refund), locks new sales for that window. | **Rain Lock** → "Close now" |
| `GET .../outage-locks`, `GET .../outage-lock/:id` | List / inspect outage locks (progress, failures). | Rain Lock history |
| `DELETE .../outage-lock/:id` | Release an outage lock early. | Rain Lock screen |

## 7. Settings and the blocklist

| API | Why | Used on |
|---|---|---|
| `GET/PATCH /pos/venues/:venueId/booking-settings` | Read/change venue-level POS settings (e.g. `payAtVenueEnabled`, the pilot "pay at venue" mode). | Venue settings |
| `GET/POST /pos/venues/:venueId/blocklist`, `DELETE .../blocklist/:phone` | Block/unblock a phone number from booking at this venue. | Venue settings |

## 8. Cash drawer and daily closing ("Close Today's Cash")

All built on `ledger_entries` / `daily_closings` — tables from the Phase 3 design, but **only the cash entry types are used** (`WALKIN_CASH`, `CASH_COLLECTED`, `REFUND_OUT`). There is no payment gateway yet, so online/card money, commission and payouts are **not** computed anywhere — see the note at the bottom.

| API | Why | Used on |
|---|---|---|
| `GET /pos/venues/:venueId/day-summary?date=` | Same endpoint as §4 — also gives the `expected` breakdown (walk-in cash / balances collected / cash refunds) shown before closing. | **Close Today's Cash**, top summary |
| `POST /pos/venues/:venueId/closings` | Close the day: staff enters `countedCashMinor`; the server computes `expected` and `variance` from the ledger (never trusts a client number). 409 if already closed today. | **Close Today's Cash** → "Close the day & make receipt" |
| `GET /pos/venues/:venueId/closings/:date` | Read a day's closing record (or `null` if not closed yet). | Close Today's Cash (checks if already closed), closing history |
| `POST .../closings/:date/reopen` | **Owner only.** Reopen a closed day with a reason (audited). | Venue settings / closing history |

## 9. My Grounds dashboard

| API | Why | Used on |
|---|---|---|
| `GET /me/venues` | The ground cards: name, address, `verificationStatus` (live/under review/draft), `courtCount`, `pendingChangeCount`. | **My Grounds** |
| `GET /pos/venues/:venueId/occupancy?days=` | Rolling N-day (default 7) booked/total hours and a 0–100% figure. Owner/Manager only. | **My Grounds** card → "X% booked this week" |

## 10. Home dashboard

The Home screen is scoped to whichever ground is selected (same selector as Live POS) and is built entirely from endpoints already listed above — no separate "home" API:

| Tile | Backed by |
|---|---|
| Bookings today (arrived / still to come) | `GET /day-summary` → `bookingsToday` |
| Earned today (cash) | `GET /day-summary` → `cashTodayMinor` |
| Still to collect | `GET /day-summary` → `stillToCollectMinor` / `stillToCollectBookingCount` |
| Arriving tonight | `GET /day-summary` → `arrivingNext` |
| "Venue under review" banner | `GET /me/venues` → `verificationStatus` + `pendingChangeCount` |
| "At the counter" quick actions | Just navigation to the Rain Lock (§6) and Close Cash (§8) screens, or `POST /venues` for "Add a new ground" |

### What the Home/money screens can't show yet

The mock UI shows an **"online" revenue split** (e.g. "Cash 76,300 · online 52,800") and a **"Next payout"** card. Neither can be built honestly right now: there is no payment gateway in this codebase, so no real online money ever moves, and payouts are computed from online revenue minus commission. The `payments`, `refunds`, and `payouts` tables exist in the database (migrated ahead of time from the full design) but have no application code writing to them. Until that's built:
- online revenue should read **0** or be hidden, not fabricated
- the payout card should be hidden, not fabricated

This is the one piece of the four screens genuinely blocked on a future phase (gateway integration), not on missing wiring.
