// Prints the patched builtin's raw value — the hybrid double-patch guard
// test counts the 'patched:' prefixes: exactly one means the build-time
// wrapper and the runtime preload composed without wrapping twice.
import { hostname } from 'node:os'

console.log(hostname())
