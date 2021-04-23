const DHT = require('../')
const crypto = require('crypto')

// Set ephemeral: true as we are not part of the network.
const node = new DHT({ ephemeral: true, bootstrap: ['localhost:10001'] })
const val = Buffer.from(process.argv[2])

run()

async function run () {
  const q = node.query(sha256(val), 'values')
  await q.finished()
  await q.commit('values', val)
  console.log('Inserted', sha256(val).toString('hex'))
}

function sha256 (val) {
  return crypto.createHash('sha256').update(val).digest()
}
