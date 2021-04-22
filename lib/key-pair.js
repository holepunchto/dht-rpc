const sodium = require('sodium-universal')

module.exports = function createKeyPair (seed) {
  const publicKey = Buffer.alloc(32)
  const secretKey = Buffer.alloc(32)

  if (seed) sodium.crypto_kx_seed_keypair(publicKey, secretKey, seed)
  else sodium.crypto_kx_keypair(publicKey, secretKey)

  return { publicKey, secretKey }
}
