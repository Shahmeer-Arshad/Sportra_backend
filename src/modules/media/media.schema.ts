export const KINDS = ['venue', 'court'] as const

export const uploadQuery = {
  type: 'object',
  properties: { kind: { type: 'string', enum: [...KINDS], default: 'venue' } },
}
export const uploadParams = {
  type: 'object',
  required: ['venueId'],
  properties: { venueId: { type: 'string', format: 'uuid' } },
}
