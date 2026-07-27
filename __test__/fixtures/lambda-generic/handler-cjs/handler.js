// The CJS shape of the same handler, in a subdirectory so the handler string
// exercises the RIC's module-root prefix ('handler-cjs/handler.handler').
// The sibling package.json pins "type": "commonjs" (the suite's own
// package.json says "module", which would otherwise reach down here), so
// `.js` is CommonJS — the tap reaches it as a `module.exports` property.
exports.handler = async (event) => `hi:${(event && event.who) || 'lambda'}`
