// Consumes the bare-star barrel the way an ordinary app would: the names
// come through `export * from "@fake/star-pkg"` / `"@fake/star-plain"`.
import { StarPkg, plainGreet } from '@fake/shapes/star-bare.js'

console.log([new StarPkg().greet(), plainGreet('p')].join(' '))
