// Internal path normalization shared by matching, format detection and the
// apply step. Callers hand us either a bundler module id (a file path, maybe
// with a `?query`) or a loader-hook file URL — everything downstream wants a
// clean, forward-slash absolute path.
import { fileURLToPath } from 'node:url'

function toPath(idOrUrl: string): string {
  return idOrUrl.startsWith('file:') ? fileURLToPath(idOrUrl) : idOrUrl
}

export function cleanPath(idOrUrl: string): string {
  return toPath(idOrUrl)
    .replace(/[?#].*$/, '')
    .replaceAll('\\', '/')
}
