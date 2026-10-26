/**
 * EVERY API ENDPOINT AND THE PERMISSION IT NEEDS. One row per route:
 *   [method, path, permission, description]
 * `PUBLIC` = no login needed. To protect an endpoint differently, change its permission code here;
 * the code is created in the database on the next `npm run db:seed:rbac`. Which role holds which
 * permission lives in `rbac.roles.ts`. tests/rbac.test.ts fails if a route exists in the app but
 * not in this list (or the other way round).
 *
 * Permission codes look like `resource.action`. A permission used by several rows (the
 * description of its first row is stored) is one permission.
 */
export const PUBLIC = 'PUBLIC'
type Row = readonly [method: string, path: string, permission: string, description: string]

const V = '/api/v1/pos/venues/:venueId'

export const API_MAP: readonly Row[] = [
  // ───────────── health & docs ─────────────
  ['GET', '/health', PUBLIC, 'Health check'],
  ['GET', '/healthz', PUBLIC, 'Liveness probe'],
  ['GET', '/readyz', PUBLIC, 'Readiness probe'],

  // ───────────── auth (no login yet) ─────────────
  ['POST', '/api/v1/public/auth/register', PUBLIC, 'Sign up'],
  ['POST', '/api/v1/public/auth/verify-email', PUBLIC, 'Verify email code'],
  ['POST', '/api/v1/public/auth/login', PUBLIC, 'Log in'],
  ['POST', '/api/v1/public/auth/login/verify-otp', PUBLIC, 'Finish login with OTP'],
  ['POST', '/api/v1/public/auth/otp/request', PUBLIC, 'Request an OTP'],
  ['POST', '/api/v1/public/auth/otp/verify', PUBLIC, 'Verify an OTP'],
  ['POST', '/api/v1/public/auth/password/forgot', PUBLIC, 'Start password reset'],
  ['POST', '/api/v1/public/auth/password/reset', PUBLIC, 'Finish password reset'],
  ['POST', '/api/v1/public/auth/refresh', PUBLIC, 'Refresh access token'],
  ['POST', '/api/v1/public/auth/logout', PUBLIC, 'Log out'],
  ['POST', '/api/v1/public/auth/staff-invitations/accept', PUBLIC, 'Accept a staff invitation'],

  // ───────────── public discovery ─────────────
  ['GET', '/api/v1/public/venues/search', PUBLIC, 'Search venues'],
  ['GET', '/api/v1/public/venues/:idOrSlug', PUBLIC, 'Public venue page'],
  ['GET', '/api/v1/public/areas', PUBLIC, 'List areas'],
  ['GET', '/api/v1/public/meta/filters', PUBLIC, 'Search filter options'],
  ['GET', '/api/v1/public/venues/:idOrSlug/availability', PUBLIC, 'Public availability grid'],
  ['GET', '/api/v1/public/invites/:token', PUBLIC, 'View a booking invite'],
  ['POST', '/api/v1/public/invites/:token/rsvp', PUBLIC, 'Reply to a booking invite'],

  // ───────────── my account ─────────────
  ['GET', '/api/v1/me', 'profile.read', 'See my profile'],
  ['PATCH', '/api/v1/me', 'profile.update', 'Edit my profile'],
  ['POST', '/api/v1/me/whatsapp-consent', 'profile.consent', 'Change WhatsApp consent'],
  ['POST', '/api/v1/me/email-change', 'profile.email_change', 'Start an email change'],
  ['POST', '/api/v1/me/email-change/confirm', 'profile.email_change', 'Confirm an email change'],
  ['GET', '/api/v1/me/sessions', 'session.read', 'List my sessions'],
  ['POST', '/api/v1/me/logout-all', 'session.revoke', 'Log out everywhere'],
  ['GET', '/api/v1/me/venues', 'venue.list_own', 'List my venues'],
  ['GET', '/api/v1/me/bookings', 'booking.list_own', 'List my bookings'],

  // ───────────── player bookings ─────────────
  ['POST', '/api/v1/bookings/holds', 'booking.hold', 'Hold slots'],
  ['DELETE', '/api/v1/bookings/:id/hold', 'booking.release_hold', 'Release my hold'],
  ['POST', '/api/v1/bookings/:id/confirm-pay-at-venue', 'booking.confirm', 'Confirm, pay at venue'],
  ['GET', '/api/v1/bookings/:id', 'booking.read_own', 'See my booking'],
  ['GET', '/api/v1/bookings/:id/pass', 'booking.pass', 'Get my QR pass'],
  [
    'GET',
    '/api/v1/bookings/:id/cancel-preview',
    'booking.cancel_preview',
    'Preview a cancellation',
  ],
  ['POST', '/api/v1/bookings/:id/cancel', 'booking.cancel_own', 'Cancel my booking'],
  ['POST', '/api/v1/bookings/:id/invites', 'booking.invite_create', 'Create a booking invite'],
  ['GET', '/api/v1/bookings/:id/invites', 'booking.invite_read', 'List booking invites'],
  ['DELETE', '/api/v1/bookings/:id/invites/:inviteId', 'booking.invite_revoke', 'Revoke an invite'],
  ['PATCH', '/api/v1/bookings/:id/headcount', 'booking.headcount', 'Set headcount'],

  // ───────────── venue setup (ground owner) ─────────────
  ['POST', '/api/v1/venues', 'venue.create', 'Create a venue'],
  ['GET', `${V}`, 'venue.read', 'See venue details'],
  ['PATCH', `${V}`, 'venue.update', 'Edit venue details'],
  ['POST', `${V}/submit`, 'venue.submit', 'Submit venue for review'],
  ['POST', `${V}/uploads`, 'venue.update', 'Upload a photo (returns its link)'],
  ['GET', `${V}/verification`, 'venue.verification_read', 'See verification status'],
  ['GET', `${V}/courts`, 'court.read', 'List courts'],
  ['POST', `${V}/courts`, 'court.create', 'Add a court'],
  ['PATCH', `${V}/courts/:courtId`, 'court.update', 'Edit a court'],
  ['GET', `${V}/pricing-rules`, 'pricing.read', 'List pricing rules'],
  ['POST', `${V}/pricing-rules`, 'pricing.create', 'Add a pricing rule'],
  ['DELETE', `${V}/pricing-rules/:ruleId`, 'pricing.delete', 'Delete a pricing rule'],
  ['GET', `${V}/pricing-preview`, 'pricing.preview', 'Preview prices'],

  // ───────────── venue staff ─────────────
  ['GET', `${V}/staff`, 'staff.read', 'List venue staff'],
  ['POST', `${V}/staff/invitations`, 'staff.invite', 'Invite venue staff'],
  ['DELETE', `${V}/staff/:membershipId`, 'staff.remove', 'Remove venue staff'],

  // ───────────── point of sale ─────────────
  ['GET', `${V}/grid`, 'pos.grid_read', 'Live court grid'],
  ['POST', `${V}/walkins`, 'pos.walkin', 'Book a walk-in'],
  ['POST', `${V}/bookings/manual`, 'pos.booking_create', 'Create a manual booking'],
  ['GET', `${V}/bookings`, 'pos.booking_list', 'List the day bookings'],
  ['GET', `${V}/bookings/:id`, 'pos.booking_read', 'See a venue booking'],
  ['POST', `${V}/check-in`, 'pos.check_in', 'Check in by QR'],
  ['POST', `${V}/bookings/:id/check-in`, 'pos.check_in', 'Check in a booking'],
  ['POST', `${V}/bookings/:id/collect-balance`, 'pos.collect_balance', 'Collect the balance'],
  ['POST', `${V}/bookings/:id/no-show`, 'pos.no_show', 'Mark a no-show'],
  ['POST', `${V}/bookings/:id/cancel`, 'pos.booking_cancel', 'Cancel a venue booking'],
  ['POST', `${V}/blocks`, 'pos.block_create', 'Block slots'],
  ['DELETE', `${V}/blocks`, 'pos.block_delete', 'Unblock slots'],
  ['POST', `${V}/outage-lock/preview`, 'pos.outage_preview', 'Preview an outage lock'],
  ['POST', `${V}/outage-lock`, 'pos.outage_create', 'Start an outage lock'],
  ['GET', `${V}/outage-locks`, 'pos.outage_read', 'List outage locks'],
  ['GET', `${V}/outage-lock/:id`, 'pos.outage_read', 'See an outage lock'],
  ['DELETE', `${V}/outage-lock/:id`, 'pos.outage_release', 'Release an outage lock'],
  ['GET', `${V}/booking-settings`, 'pos.settings_read', 'See booking settings'],
  ['PATCH', `${V}/booking-settings`, 'pos.settings_update', 'Change booking settings'],
  ['GET', `${V}/blocklist`, 'pos.blocklist_read', 'List blocked phones'],
  ['POST', `${V}/blocklist`, 'pos.blocklist_add', 'Block a phone'],
  ['DELETE', `${V}/blocklist/:phone`, 'pos.blocklist_remove', 'Unblock a phone'],

  // ───────────── admin ─────────────
  ['GET', '/api/v1/admin/users', 'user.read', 'List users'],
  ['POST', '/api/v1/admin/users/:id/suspend', 'user.suspend', 'Suspend a user'],
  ['POST', '/api/v1/admin/users/:id/unsuspend', 'user.unsuspend', 'Unsuspend a user'],
  ['POST', '/api/v1/admin/users/:id/force-logout', 'user.force_logout', 'Force a user to log out'],
  ['GET', '/api/v1/admin/audit-logs', 'audit.read', 'Read the audit log'],
  ['GET', '/api/v1/admin/venues', 'venue_review.list', 'List venues to review'],
  ['GET', '/api/v1/admin/venues/:id', 'venue_review.read', 'See a venue under review'],
  ['POST', '/api/v1/admin/venues/:id/open-review', 'venue_review.open', 'Open a venue review'],
  ['POST', '/api/v1/admin/venues/:id/review', 'venue_review.decide', 'Approve or reject a venue'],
  ['POST', '/api/v1/admin/venues/:id/suspend', 'venue_review.suspend', 'Suspend a venue'],
  ['POST', '/api/v1/admin/venues/:id/reinstate', 'venue_review.reinstate', 'Reinstate a venue'],
  ['POST', '/api/v1/admin/areas', 'area.create', 'Create an area'],
  ['PATCH', '/api/v1/admin/areas/:id', 'area.update', 'Edit an area'],
  ['DELETE', '/api/v1/admin/areas/:id', 'area.delete', 'Delete an area'],
  ['GET', '/api/v1/admin/bookings', 'booking_admin.search', 'Search all bookings'],
  ['GET', '/api/v1/admin/bookings/:id', 'booking_admin.read', 'See any booking'],
  ['POST', '/api/v1/admin/bookings/:id/cancel', 'booking_admin.cancel', 'Cancel any booking'],
  ['POST', '/api/v1/admin/slots/unblock', 'booking_admin.unblock', 'Force-unblock slots'],
  ['GET', '/api/v1/admin/outage-locks', 'booking_admin.outages', 'List all outage locks'],
  ['GET', '/api/v1/admin/abuse-flags', 'booking_admin.abuse', 'See abuse flags'],
  ['GET', '/api/v1/admin/booking-health', 'booking_admin.health', 'Booking health numbers'],
  ['GET', '/api/v1/admin/venues/:id/grid', 'booking_admin.grid', 'Live grid of any venue'],

  // ───────────── realtime ─────────────
  ['GET', '/api/v1/realtime/stream', PUBLIC, 'Live updates over SSE (checks its own token)'],
]

/**
 * Permissions with no endpoint yet (later phases), so roles can already hold them.
 * Same shape: [permission, description].
 */
export const PLANNED_PERMISSIONS: readonly (readonly [string, string])[] = [
  ['tournament.join', 'Register for a tournament'],
  ['tournament.create', 'Create a tournament'],
  ['tournament.update', 'Edit a tournament'],
  ['tournament.cancel', 'Cancel a tournament'],
  ['tournament.manage_teams', 'Accept or remove teams'],
  ['tournament.schedule', 'Build tournament fixtures'],
  ['tournament.score', 'Enter tournament scores'],
  ['chat.use', 'Use chat'],
  ['role.read', 'See roles and who holds them'],
  ['role.assign', 'Give a role to a user'],
  ['role.revoke', 'Take a role from a user'],
]
