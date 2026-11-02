/** Pure checks on an uploaded file. The first bytes decide the type, not the client's header. */
export type ImageType = 'jpeg' | 'png' | 'webp'

export function sniffImage(b: Buffer): ImageType | null {
  if (b.length < 12) return null
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'png'
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  return null
}

/** Cloudinary folders (relative to the root folder) for the two upload entry points. */
export const venueFolder = (venueId: string, kind: string) => `venues/${venueId}/${kind}`
export const userFolder = (userId: string, kind: string) => `users/${userId}/${kind}`
