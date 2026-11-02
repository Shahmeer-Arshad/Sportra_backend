import { Cloudinary } from '../../lib/cloudinary'
import { AppError, BadRequestError } from '../../utils/errors'
import { sniffImage } from './media.domain'

/** Checks the file, then stores it in Cloudinary under the folder the caller chose. */
export function createMediaService(cloud: Cloudinary, rootFolder: string) {
  return {
    async uploadImage(folder: string, file: Buffer, filename?: string) {
      if (!cloud.enabled) {
        throw new AppError('Photo uploads are not set up', 503, true, 'UPLOADS_NOT_CONFIGURED')
      }
      if (file.length === 0) throw new BadRequestError('The file is empty', 'EMPTY_FILE')
      if (!sniffImage(file)) {
        throw new BadRequestError('Only JPEG, PNG or WebP images are allowed', 'UNSUPPORTED_IMAGE')
      }
      try {
        return await cloud.upload(file, { folder: `${rootFolder}/${folder}`, filename })
      } catch {
        throw new AppError('Could not store the photo, try again', 502, true, 'UPLOAD_FAILED')
      }
    },
  }
}
export type MediaService = ReturnType<typeof createMediaService>
