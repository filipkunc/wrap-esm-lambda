// mongodb: prototype mutation on the driver's front-door class, tapped at
// its defining module (lib/mongo_client.js), not the barrel.
import { bump } from './bump.mts'

type AnyFn = (this: unknown, ...args: unknown[]) => unknown

export function patchMongodb({ MongoClient }: { MongoClient: typeof import('mongodb').MongoClient }): void {
  const orig = MongoClient.prototype.db as unknown as AnyFn
  ;(MongoClient.prototype as unknown as Record<string, AnyFn>).db = function (...args) {
    bump()
    return orig.apply(this, args)
  }
}
