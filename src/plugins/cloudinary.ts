import { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { env } from '../config/env'
import { Cloudinary, createCloudinary } from '../lib/cloudinary'

declare module 'fastify' {
  interface FastifyInstance {
    cloudinary: Cloudinary
  }
}

const cloudinaryPlugin = fp(async (app: FastifyInstance) => {
  app.decorate(
    'cloudinary',
    createCloudinary({
      cloudName: env.CLOUDINARY_CLOUD_NAME || undefined,
      apiKey: env.CLOUDINARY_API_KEY || undefined,
      apiSecret: env.CLOUDINARY_API_SECRET || undefined,
      capture: env.NODE_ENV === 'test',
    }),
  )
})

export default cloudinaryPlugin
