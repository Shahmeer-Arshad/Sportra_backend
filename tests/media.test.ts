import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { FastifyInstance } from 'fastify'
import { makeApp, call, nextIp, signupVerified, buildDraftVenue, cleanupTestData } from './helpers'
import { testUploads } from '../src/lib/cloudinary'

let app: FastifyInstance
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
])

beforeAll(async () => {
  app = await makeApp()
  await cleanupTestData(app.prisma)
})
afterAll(async () => {
  await cleanupTestData(app.prisma)
  await app.close()
})

/** Builds a multipart/form-data body by hand so app.inject can send a real file. */
function multipartBody(file: Buffer, filename = 'court.png', field = 'file') {
  const boundary = '----sportratest'
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return {
    payload: Buffer.concat([head, file, tail]),
    'content-type': `multipart/form-data; boundary=${boundary}`,
  }
}

const upload = (
  venueId: string,
  token: string | undefined,
  file: Buffer,
  query = '',
  name?: string,
) => {
  const { payload, 'content-type': ct } = multipartBody(file, name)
  return app.inject({
    method: 'POST',
    url: `/api/v1/pos/venues/${venueId}/uploads${query}`,
    payload,
    headers: { 'content-type': ct, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    remoteAddress: nextIp(),
  })
}

describe('photo upload', () => {
  it('uploads an image and returns a link the owner can save on the venue and a court', async () => {
    const owner = await signupVerified(app)
    const v = await buildDraftVenue(app, owner)
    const before = testUploads.length

    const res = await upload(v.venueId, owner.accessToken, PNG, '?kind=venue')
    expect(res.statusCode).toBe(201)
    const img = res.json().data
    expect(img.url).toMatch(/^https:\/\/res\.cloudinary\.com\//)
    expect(img.publicId).toContain(`venues/${v.venueId}/venue`)
    expect(testUploads.length).toBe(before + 1)

    const patch = await call(app, 'PATCH', `/api/v1/pos/venues/${v.venueId}`, owner.accessToken, {
      photos: [img.url],
    })
    expect(patch.statusCode).toBe(200)
    expect(patch.json().data.photos).toEqual([img.url])

    const court = await upload(v.venueId, owner.accessToken, PNG, '?kind=court')
    expect(court.json().data.publicId).toContain(`venues/${v.venueId}/court`)
  })

  it('needs a login and a role on that venue', async () => {
    const owner = await signupVerified(app)
    const v = await buildDraftVenue(app, owner)
    expect((await upload(v.venueId, undefined, PNG)).statusCode).toBe(401)
    const stranger = await signupVerified(app)
    expect((await upload(v.venueId, stranger.accessToken, PNG)).statusCode).toBe(403)
  })

  it('rejects files that are not JPEG, PNG or WebP, even if named .png', async () => {
    const owner = await signupVerified(app)
    const v = await buildDraftVenue(app, owner)
    const res = await upload(
      v.venueId,
      owner.accessToken,
      Buffer.from('<?php echo 1; ?> not an image'),
      '',
      'x.png',
    )
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('UNSUPPORTED_IMAGE')
  })

  it('rejects an empty request, a bad kind and an oversize file', async () => {
    const owner = await signupVerified(app)
    const v = await buildDraftVenue(app, owner)
    const none = await app.inject({
      method: 'POST',
      url: `/api/v1/pos/venues/${v.venueId}/uploads`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'content-type': 'application/json' },
      payload: '{}',
      remoteAddress: nextIp(),
    })
    expect(none.statusCode).toBe(400)
    expect((await upload(v.venueId, owner.accessToken, PNG, '?kind=logo')).statusCode).toBe(400)
    const big = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024, 2)])
    const tooBig = await upload(v.venueId, owner.accessToken, big)
    expect(tooBig.statusCode).toBe(413)
    expect(tooBig.json().code).toBe('FILE_TOO_LARGE')
  })

  it('only accepts https photo links on the venue', async () => {
    const owner = await signupVerified(app)
    const v = await buildDraftVenue(app, owner)
    const bad = await call(app, 'PATCH', `/api/v1/pos/venues/${v.venueId}`, owner.accessToken, {
      photos: ['http://example.com/a.jpg'],
    })
    expect(bad.statusCode).toBe(400)
  })
})
