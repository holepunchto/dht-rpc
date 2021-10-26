const sodium = require('sodium-universal')
const c = require('compact-encoding')
const net = require('compact-encoding-net')

const ipv4 = net.ipv4Address

module.exports = { id, ipv4, ipv4Array: c.array(ipv4) }

const addr = Buffer.alloc(6)

function id (ip, port, out = Buffer.allocUnsafe(32)) {
  ipv4.encode(
    { start: 0, end: 6, buffer: addr },
    { host: ip, port }
  )
  sodium.crypto_generichash(out, addr)
  return out
}
