import { Client } from '@fake/smithy-client'

console.log(await new Client().send('hello'))
