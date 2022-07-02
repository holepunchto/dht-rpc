import DHT from '../index.js'
import crypto from 'crypto'

const GET = 1

const hex = process.argv[2]
const node = new DHT({ ephemeral: true, bootstrap: ['localhost:10001'] })
await node.ready()

const q = node.query({ target: Buffer.from(hex, 'hex'), command: GET }, { commit: true })

for await (const data of q) {
  if (data.value && sha256(data.value).toString('hex') === hex) {
    // We found the value! Destroy the query stream as there is no need to continue.
    console.log(hex, '-->', data.value.toString())
    break
  }
}

console.log('(query finished)')

function sha256 (val) {
  return crypto.createHash('sha256').update(val).digest()
}
