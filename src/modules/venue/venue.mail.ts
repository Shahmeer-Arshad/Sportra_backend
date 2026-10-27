import { SuspensionMode } from './venue.domain'

export interface Mail {
  subject: string
  text: string
}

const sign = '\n\nSportra team'
const noteBlock = (note?: string | null) =>
  note?.trim() ? `\n\nNote from the reviewer:\n${note.trim()}` : ''

/** Plain-text emails to the venue owner for every review decision (pure). */
export const venueMails = {
  submitted: (name: string): Mail => ({
    subject: `We received "${name}" for review`,
    text: `Your venue "${name}" is in the review queue. We will email you when a decision is made.${sign}`,
  }),
  approved: (name: string): Mail => ({
    subject: `"${name}" is approved`,
    text: `Good news: "${name}" is approved. Players can now find and book it.${sign}`,
  }),
  changesRequested: (name: string, note?: string | null): Mail => ({
    subject: `Changes needed for "${name}"`,
    text: `We reviewed "${name}" and need a few changes before we can approve it.${noteBlock(note)}\n\nEdit the venue and submit it again from your portal.${sign}`,
  }),
  rejected: (name: string, note?: string | null): Mail => ({
    subject: `"${name}" was not approved`,
    text: `We could not approve "${name}".${noteBlock(note)}\n\nYou can copy it as a new draft from your portal, fix the problems and apply again.${sign}`,
  }),
  suspended: (name: string, mode: SuspensionMode, note?: string | null): Mail => ({
    subject: `"${name}" has been suspended`,
    text:
      (mode === 'STOP_ALL'
        ? `"${name}" has been suspended. Online bookings are closed, upcoming bookings are being cancelled and refunded, and the point of sale is locked.`
        : `"${name}" has been paused. Players cannot book online for now. Your point of sale and existing bookings are not affected.`) +
      noteBlock(note) +
      sign,
  }),
  reinstated: (name: string, note?: string | null): Mail => ({
    subject: `"${name}" is live again`,
    text: `"${name}" is reinstated and open for bookings again.${noteBlock(note)}${sign}`,
  }),
  changeDecided: (
    name: string,
    summary: string,
    approved: boolean,
    note?: string | null,
  ): Mail => ({
    subject: approved
      ? `Your change to "${name}" is live`
      : `Your change to "${name}" was not approved`,
    text: `${approved ? 'Approved and applied' : 'Not approved'}: ${summary}.${noteBlock(note)}${sign}`,
  }),
}
