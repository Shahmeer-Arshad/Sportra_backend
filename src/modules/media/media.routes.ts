import multipart from '@fastify/multipart'
import { FastifyInstance } from 'fastify'
import { env } from '../../config/env'
import { authenticate, requireVenueRole } from '../../hooks/auth.hook'
import { AppError } from '../../utils/errors'
import { createMediaController } from './media.controller'
import * as S from './media.schema'

const sec = [{ bearerAuth: [] }]
const uploadLimit = { rateLimit: { max: 30, timeWindow: '1 minute' } }

export async function mediaRoutes(app: FastifyInstance) {
  const c = createMediaController(app)

  // ───────────── Owner / manager: POST /pos/venues/:venueId/uploads ─────────────
  await app.register(
    async (pos) => {
      pos.addHook('onRequest', authenticate)
      await pos.register(multipart, {
        limits: { fileSize: env.UPLOAD_MAX_MB * 1024 * 1024, files: 1, fields: 0 },
      })
      pos.setErrorHandler((err: any, req, reply) => {
        if (err?.code === 'FST_REQ_FILE_TOO_LARGE' || err?.code === 'FST_FILES_LIMIT') {
          err = new AppError(
            `The photo is larger than ${env.UPLOAD_MAX_MB} MB`,
            413,
            true,
            'FILE_TOO_LARGE',
          )
        } else if (err?.code?.startsWith?.('FST_') && err.code.includes('MULTIPART')) {
          err = new AppError('Send the photo as multipart/form-data', 400, true, 'NOT_MULTIPART')
        }
        // hand over to the app-wide handler
        return app.errorHandler(err, req, reply)
      })

      pos.post(
        '/uploads',
        {
          onRequest: [requireVenueRole('OWNER', 'MANAGER')],
          config: uploadLimit,
          schema: {
            tags: ['Media'],
            security: sec,
            consumes: ['multipart/form-data'],
            params: S.uploadParams,
            querystring: S.uploadQuery,
          },
        },
        c.uploadImage,
      )
    },
    { prefix: '/api/v1/pos/venues/:venueId' },
  )
}
