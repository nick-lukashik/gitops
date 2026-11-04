// The other half of check-rabbitmq.sh: the broker against what the services do
// at startup. CONSUMERS and the rules below come from the services:
// src/common/messaging/topology.ts (the same in each) and their consumers. A new
// queue goes here and into platform/data/stores/rabbitmq-topology.json.
//   publish: events go out before any consumer has started
//   consume: every consumer declares its queues on top of the definitions, gets its events
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect } from 'amqplib'

const RETRY_DELAYS_MS = [5_000, 30_000, 120_000]

const CONSUMERS = [
  {
    queue: 'id-api.subscriptions',
    bindings: [['pay.events', 'pay.subscription.changed.v1']],
  },
  {
    queue: 'notifications-api.events',
    bindings: [
      ['id.events', 'id.user.registered.v1'],
      ['pay.events', 'pay.payment.succeeded.v1'],
      ['wallet.events', 'wallet.credit.posted.v1'],
    ],
  },
  {
    queue: 'wallet-api.payments',
    bindings: [['pay.events', 'pay.payment.succeeded.v1']],
  },
]

const quorum = { 'x-queue-type': 'quorum' }
const atLeastOnce = deadLetterRoutingKey => ({
  ...quorum,
  'x-dead-letter-strategy': 'at-least-once',
  'x-overflow': 'reject-publish',
  'x-dead-letter-exchange': '',
  'x-dead-letter-routing-key': deadLetterRoutingKey,
})

/** queueDeclarations of topology.ts: the DLQ, the main queue, one retry queue per delay. */
const declarations = queue => [
  { name: `${queue}.dlq`, arguments: quorum },
  { name: queue, arguments: atLeastOnce(`${queue}.dlq`) },
  ...RETRY_DELAYS_MS.map((delay, tier) => ({
    name: `${queue}.retry.${tier}`,
    arguments: { ...atLeastOnce(queue), 'x-message-ttl': delay },
  })),
]

const fail = message => {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

/** Key order means nothing in the file or to the broker. */
const canonical = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))))

function checkFile(dir) {
  const topology = readdirSync(dir)
    .map(file => JSON.parse(readFileSync(join(dir, file), 'utf8')))
    .find(definitions => definitions.queues)
  if (!topology) fail(`no queues in the definitions of ${dir}`)
  const expected = CONSUMERS.flatMap(({ queue }) => declarations(queue))
  const lines = (name, args) => `${name} ${canonical(args)}`
  const want = expected.map(queue => lines(queue.name, queue.arguments)).sort()
  const have = topology.queues.map(queue => lines(queue.name, queue.arguments)).sort()
  for (const line of want) if (!have.includes(line)) fail(`the definitions lack the queue ${line}`)
  for (const line of have) if (!want.includes(line)) fail(`no service declares the queue ${line}`)
  for (const queue of topology.queues)
    if (queue.durable !== true || queue.auto_delete !== false || queue.vhost !== '/')
      fail(`the queue ${queue.name} must be durable, not auto-delete, in vhost /`)
  const wantBindings = CONSUMERS.flatMap(({ queue, bindings }) =>
    bindings.map(([exchange, key]) => `${exchange} ${key} ${queue}`),
  ).sort()
  const haveBindings = topology.bindings.map(b => `${b.source} ${b.routing_key} ${b.destination}`).sort()
  if (wantBindings.join() !== haveBindings.join())
    fail(`bindings differ\nwant ${wantBindings.join('\n     ')}\nhave ${haveBindings.join('\n     ')}`)
}

async function publish(connection) {
  const channel = await connection.createConfirmChannel()
  const returned = []
  channel.on('return', message => returned.push(message.fields.routingKey))
  const events = new Set(CONSUMERS.flatMap(({ bindings }) => bindings.map(binding => binding.join(' '))))
  for (const event of events) {
    const [exchange, routingKey] = event.split(' ')
    channel.publish(exchange, routingKey, Buffer.from('{}'), { mandatory: true, persistent: true })
  }
  await channel.waitForConfirms()
  if (returned.length > 0) fail(`no queue took ${returned.join(', ')}`)
}

/** The calls of RabbitMq.startConsumer in the services, in their order; then its events arrive. */
async function consume(connection) {
  for (const { queue, bindings } of CONSUMERS) {
    const channel = await connection.createConfirmChannel()
    channel.on('error', error => fail(`${queue}: ${error.message}`))
    for (const declaration of declarations(queue))
      await channel.assertQueue(declaration.name, { durable: true, arguments: declaration.arguments })
    for (const [exchange, routingKey] of bindings) {
      await channel.assertExchange(exchange, 'topic', { durable: true })
      await channel.bindQueue(queue, exchange, routingKey)
    }
    await channel.prefetch(16)
    const received = await new Promise(resolve => {
      let count = 0
      const timer = setTimeout(() => resolve(count), 10_000)
      channel.consume(queue, message => {
        channel.ack(message)
        count += 1
        if (count === bindings.length) {
          clearTimeout(timer)
          resolve(count)
        }
      })
    })
    if (received !== bindings.length) fail(`${queue} got ${received} of its ${bindings.length} events`)
    await channel.close()
  }
}

const [dir, phase] = process.argv.slice(2)
checkFile(dir)
const connection = await connect('amqp://check:check@localhost:5672')
connection.on('error', error => fail(error.message))
await (phase === 'publish' ? publish : consume)(connection)
await connection.close()
