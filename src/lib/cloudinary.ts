import { createHash } from 'node:crypto'

export interface UploadedImage {
  url: string
  publicId: string
  width: number
  height: number
  bytes: number
  format: string
}

export interface Cloudinary {
  /** False when the credentials are not set; uploads then answer 503. */
  enabled: boolean
  upload(file: Buffer, opts: { folder: string; filename?: string }): Promise<UploadedImage>
}

/** Cloudinary signs the sorted `key=value` pairs plus the API secret with SHA-1. */
export const signParams = (params: Record<string, string>, secret: string) =>
  createHash('sha1')
    .update(
      Object.keys(params)
        .sort()
        .map((k) => `${k}=${params[k]}`)
        .join('&') + secret,
    )
    .digest('hex')

/**
 * Signed upload through Cloudinary's REST API (no SDK). In tests nothing leaves the process: the
 * "upload" returns a fake link and the files are kept in `testUploads`.
 */
export const testUploads: Array<{ folder: string; bytes: number }> = []

export function createCloudinary(opts: {
  cloudName?: string
  apiKey?: string
  apiSecret?: string
  capture: boolean
}): Cloudinary {
  if (opts.capture) {
    return {
      enabled: true,
      async upload(file, { folder }) {
        testUploads.push({ folder, bytes: file.length })
        const publicId = `${folder}/test-${testUploads.length}`
        return {
          url: `https://res.cloudinary.com/test/image/upload/${publicId}.png`,
          publicId,
          width: 1,
          height: 1,
          bytes: file.length,
          format: 'png',
        }
      },
    }
  }
  const { cloudName, apiKey, apiSecret } = opts
  if (!cloudName || !apiKey || !apiSecret) {
    return {
      enabled: false,
      async upload() {
        throw new Error('Cloudinary is not configured')
      },
    }
  }
  return {
    enabled: true,
    async upload(file, { folder, filename }) {
      const timestamp = String(Math.floor(Date.now() / 1000))
      const signed = { folder, timestamp }
      const form = new FormData()
      form.set('file', new Blob([new Uint8Array(file)]), filename ?? 'upload')
      form.set('api_key', apiKey)
      form.set('timestamp', timestamp)
      form.set('folder', folder)
      form.set('signature', signParams(signed, apiSecret))
      const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(20_000),
      })
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.error?.message ?? `Cloudinary answered ${res.status}`)
      return {
        url: json.secure_url,
        publicId: json.public_id,
        width: json.width,
        height: json.height,
        bytes: json.bytes,
        format: json.format,
      }
    },
  }
}
