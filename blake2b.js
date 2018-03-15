var sodium = require('sodium-universal')

blake2b.batch = blake2bBatch
module.exports = blake2b

function blake2b (buf) {
  var out = Buffer.allocUnsafe(32)
  sodium.crypto_generichash(out, buf)
  return out
}

function blake2bBatch (batch) {
  var out = Buffer.allocUnsafe(32)
  sodium.crypto_generichash_batch(out, batch)
  return out
}
