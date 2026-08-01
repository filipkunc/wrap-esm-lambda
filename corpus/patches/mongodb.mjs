// mongodb: prototype mutation on the driver's front-door class, tapped at
// its defining module (lib/mongo_client.js), not the barrel.
const bump = () => {
  const k = Symbol.for('wrap-esm-lambda-corpus.probe')
  globalThis[k] = (globalThis[k] ?? 0) + 1
}

export function patchMongodb({ MongoClient }) {
  const orig = MongoClient.prototype.db
  MongoClient.prototype.db = function (...args) {
    bump()
    return orig.apply(this, args)
  }
}
