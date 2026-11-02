export const KINDS = ['venue', 'court'] as const
export const USER_KINDS = ['avatar', 'venue', 'court'] as const

export const uploadQuery = {
  type: 'object',
  properties: { kind: { type: 'string', enum: [...KINDS], default: 'venue' } },
}
export const uploadParams = {
  type: 'object',
  required: ['venueId'],
  properties: { venueId: { type: 'string', format: 'uuid' } },
}
export const userUploadQuery = {
  type: 'object',
  properties: { kind: { type: 'string', enum: [...USER_KINDS], default: 'avatar' } },
}
