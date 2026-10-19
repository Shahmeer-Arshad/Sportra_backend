const body = { type: 'object', additionalProperties: true }

export const liveness = { tags: ['Health'], response: { 200: body } }
export const readiness = { tags: ['Health'], response: { 200: body, 503: body } }
