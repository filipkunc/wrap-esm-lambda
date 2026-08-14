// Reports what the synthetic require() handed to this module actually
// carries — the #62786 regression class: CJS served through the ESM loader
// with a hook-provided source lost require.extensions (breaking pirates,
// ts-node, Next's require hook, which read it at module top level).
module.exports = {
  hasExtensions: typeof require.extensions !== 'undefined',
  hasCache: typeof require.cache !== 'undefined',
}
