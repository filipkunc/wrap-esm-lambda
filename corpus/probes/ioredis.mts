// ioredis probe: a command issued through the public API must cross the
// wrapped sendCommand. lazyConnect + no retries: the failed connect to a
// closed port is expected and irrelevant — the command enters sendCommand
// synchronously.
import { Redis } from 'ioredis'
import { report } from '../lib/probe-count.mts'

const redis = new Redis({
  host: '127.0.0.1',
  port: 1,
  lazyConnect: true,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
})
redis.get('corpus').catch(() => {})
redis.disconnect()

report(true)
