import nodemailer from 'nodemailer'

export interface Mail {
  to: string
  subject: string
  text: string
}

export interface Mailer {
  send(mail: Mail): Promise<void>
}

/** In tests, mail is kept here so tests can read OTP codes. */
export const testMailbox: Mail[] = []

export function createMailer(opts: {
  from: string
  host: string
  port: number
  user?: string
  pass?: string
  capture: boolean
}): Mailer {
  if (opts.capture) {
    return {
      async send(mail) {
        testMailbox.push(mail)
      },
    }
  }
  const authed = Boolean(opts.user && opts.pass)
  const transport = nodemailer.createTransport({
    host: opts.host,
    port: opts.port,
    secure: opts.port === 465, // implicit TLS on 465; 587 upgrades with STARTTLS
    requireTLS: authed && opts.port !== 465,
    auth: authed ? { user: opts.user, pass: opts.pass } : undefined,
  })
  return {
    async send(mail) {
      await transport.sendMail({ from: opts.from, ...mail })
    },
  }
}
