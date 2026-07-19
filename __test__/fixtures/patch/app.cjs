'use strict'
const { Client } = require('@fake/smithy-client')

new Client().send('hello').then((result) => console.log(result))
