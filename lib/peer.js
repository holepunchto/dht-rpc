const sodium = require('sodium-universal')
const c = require('compact-encoding')
const b4a = require('b4a')

const ipv4 = {
  ...c.ipv4Address,
  decode(state) {
    const ip = c.ipv4Address.decode(state)
    return {
      id: null, // populated by the callee
      host: ip.host,
      port: ip.port
    }
  }
}

module.exports = { id, randomIdInRow, ipv4, ipv4Array: c.array(ipv4) }

function id(host, port, out = b4a.allocUnsafeSlow(32)) {
  const addr = out.subarray(0, 6)
  ipv4.encode({ start: 0, end: 6, buffer: addr }, { host, port })
  sodium.crypto_generichash(out, addr)
  return out
}

// Random id that lands in row `row` of a routing table whose id is `selfId`:
// it shares the first `row` bits with selfId (MSB-first, as in
// kademlia-routing-table's _diff), has bit `row` flipped, and random bits
// after that.
function randomIdInRow(selfId, row) {
  const out = b4a.alloc(selfId.length)
  sodium.randombytes_buf(out)

  const byte = row >> 3
  const bit = 0x80 >> (row & 7) // bit to be flipped in this byte
  const high = (0xff00 >> (row & 7)) & 0xff // bits before `row` within this byte

  out.set(selfId.subarray(0, byte), 0)
  out[byte] =
    (selfId[byte] & high) | // first bits are the same
    (~selfId[byte] & bit) | // flip bit
    (out[byte] & (bit - 1)) // random

  return out
}
