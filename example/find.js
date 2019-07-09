const dht = require('../')
const crypto = require('crypto')

const hex = process.argv[2]
const node = dht({ ephemeral: true, bootstrap: ['localhost:10001'] })

node.query('values', Buffer.from(hex, 'hex'))
  .on('data', function (data) {
    if (data.value && sha256(data.value).toString('hex') === hex) {
      // We found the value! Destroy the query stream as there is no need to continue.
      console.log(hex, '-->', data.value.toString())
      this.destroy()
    }
  })
  .on('end', function () {
    console.log('(query finished)')
  })

function sha256 (val) {
  return crypto.createHash('sha256').update(val).digest()
}
