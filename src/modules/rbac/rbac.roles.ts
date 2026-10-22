/**
 * WHICH ROLE HOLDS WHICH PERMISSIONS. This is the file to edit to change a role.
 * After editing run `npm run db:seed:rbac`; the database is made to match exactly (permissions you
 * remove from a role are taken away, new ones are added).
 *
 * `permissions` takes exact codes ('court.create') or a whole resource ('pos.*'). Codes come from
 * `rbac.api-map.ts`. A code that does not exist stops the seed with an error.
 * `scope`: PLATFORM = the account holds it everywhere; VENUE = granted per venue (user_roles.venue_id).
 *
 * Becoming a ground owner: sign up with signupIntent GROUND_OWNER (an admin can grant it later).
 * To add a role later (for example FRONT_DESK), add an entry here and seed.
 */
export interface RoleDef {
  name: string
  description: string
  scope: 'PLATFORM' | 'VENUE'
  permissions: readonly string[]
}

export const ROLES = {
  USER: {
    name: 'User',
    description: 'Every signed-up player',
    scope: 'PLATFORM',
    permissions: ['profile.*', 'session.*', 'booking.*', 'tournament.join', 'chat.use'],
  },

  GROUND_OWNER: {
    name: 'Ground owner',
    description: 'Owns a ground or venue',
    scope: 'PLATFORM', // account-level: "may own grounds". Which venues stays in venue_memberships
    permissions: [
      'venue.create',
      'venue.list_own',
      'venue.read',
      'venue.update',
      'venue.submit',
      'venue.verification_read',
      'court.*',
      'pricing.*',
      'staff.*',
      'pos.*',
    ],
  },

  TOURNAMENT_ORGANIZER: {
    name: 'Tournament organizer',
    description: 'Creates and runs tournaments (granted by an admin)',
    scope: 'PLATFORM',
    permissions: [
      'tournament.create',
      'tournament.update',
      'tournament.cancel',
      'tournament.manage_teams',
      'tournament.schedule',
      'tournament.score',
    ],
  },

  ADMIN: {
    name: 'Admin',
    description: 'Platform administrator',
    scope: 'PLATFORM',
    permissions: ['user.*', 'audit.*', 'venue_review.*', 'area.*', 'booking_admin.*', 'role.*'],
  },
} as const satisfies Record<string, RoleDef>
