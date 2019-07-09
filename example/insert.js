const dht = require('../')
const crypto = require('crypto')

// Set ephemeral: true as we are not part of the network.
const node = dht({ ephemeral: true, bootstrap: ['localhost:10001'] })
const val = Buffer.from(process.argv[2])

node.update('values', sha256(val), val, function (err, res) {
  if (err) throw err
  console.log('Inserted', sha256(val).toString('hex'))
})

function sha256 (val) {
  return crypto.createHash('sha256').update(val).digest()
}
