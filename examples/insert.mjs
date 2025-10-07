import DHT from '../index.js'
import crypto from 'crypto'

const INSERT = 0

// Set ephemeral: true as we are not part of the network.
const node = new DHT({ ephemeral: true, bootstrap: ['localhost:10001'] })
const val = Buffer.from(process.argv[2])

const q = node.query({ target: sha256(val), command: INSERT }, { commit })
await q.finished()
console.log('Inserted', sha256(val).toString('hex'))

async function commit(reply) {
  await node.request(
    { token: reply.token, target: sha256(val), command: INSERT, value: val },
    reply.from
  )
}

function sha256(val) {
  return crypto.createHash('sha256').update(val).digest()
}
