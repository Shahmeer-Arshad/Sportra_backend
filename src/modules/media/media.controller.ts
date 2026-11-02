import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { env } from '../../config/env'
import { BadRequestError } from '../../utils/errors'
import { successResponse } from '../../utils/response'
import { userFolder, venueFolder } from './media.domain'
import { createMediaService } from './media.service'

type Req = FastifyRequest

/** HTTP layer only: reads the multipart file, calls the service, wraps the response. */
export function createMediaController(app: FastifyInstance) {
  const svc = createMediaService(app.cloudinary, env.CLOUDINARY_FOLDER)

  async function store(req: Req, reply: FastifyReply, folder: string) {
    const part = await req.file()
    if (!part) throw new BadRequestError('Send the photo in a "file" field', 'FILE_REQUIRED')
    // toBuffer throws FST_REQ_FILE_TOO_LARGE past the size limit (mapped to 413 in media.routes)
    const buf = await part.toBuffer()
    const image = await svc.uploadImage(folder, buf, part.filename)
    return reply.status(201).send(successResponse(image, 'Photo uploaded'))
  }

  return {
    uploadImage: async (req: Req, reply: FastifyReply) => {
      const { venueId } = req.params as { venueId: string }
      const { kind = 'venue' } = req.query as { kind?: string }
      return store(req, reply, venueFolder(venueId, kind))
    },
    uploadMyImage: async (req: Req, reply: FastifyReply) => {
      const { kind = 'avatar' } = req.query as { kind?: string }
      return store(req, reply, userFolder(req.user.sub, kind))
    },
  }
}
