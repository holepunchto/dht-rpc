const sodium = require('sodium-universal')

const addr = Buffer.alloc(6)
let i = 0

module.exports = hash

function num (ip) {
  let n = 0
  let c = 0
  while (i < ip.length && (c = ip.charCodeAt(i++)) !== 46) n = n * 10 + (c - 48)
  return n
}

function hash (ip, port, out = Buffer.allocUnsafe(32)) {
  i = 0
  addr[0] = num(ip)
  addr[1] = num(ip)
  addr[2] = num(ip)
  addr[3] = num(ip)
  addr[4] = port
  addr[5] = port >>> 8
  sodium.crypto_generichash(out, addr)
  return out
}
