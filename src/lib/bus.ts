import amqp from 'amqplib'

export const EXCHANGE = 'platform.events'

export interface PublishOptions {
  messageId: string
  headers?: Record<string, unknown>
}

/** What the outbox relay needs from a message broker. */
export interface Bus {
  publishConfirmed(routingKey: string, payload: unknown, opts: PublishOptions): Promise<void>
  close(): Promise<void>
}

/** RabbitMQ bus: topic exchange `platform.events`, durable, persistent messages, publisher confirms. */
export async function createAmqpBus(url: string): Promise<Bus> {
  const conn = await amqp.connect(url)
  const ch = await conn.createConfirmChannel()
  await ch.assertExchange(EXCHANGE, 'topic', { durable: true })

  return {
    async publishConfirmed(routingKey, payload, { messageId, headers }) {
      await new Promise<void>((resolve, reject) => {
        ch.publish(
          EXCHANGE,
          routingKey,
          Buffer.from(JSON.stringify(payload)),
          { messageId, persistent: true, contentType: 'application/json', headers },
          (err) => (err ? reject(err) : resolve()),
        )
      })
    },
    async close() {
      await ch.close().catch(() => undefined)
      await conn.close().catch(() => undefined)
    },
  }
}
