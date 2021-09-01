const sodium = require('sodium-universal')
const c = require('compact-encoding')

const addr = Buffer.alloc(6)
let i = 0

const ipv4 = {
  preencode (state, p) {
    state.end += 6
  },
  encode (state, p) {
    i = 0
    state.buffer[state.start++] = num(p.host)
    state.buffer[state.start++] = num(p.host)
    state.buffer[state.start++] = num(p.host)
    state.buffer[state.start++] = num(p.host)
    state.buffer[state.start++] = p.port
    state.buffer[state.start++] = p.port >>> 8
  },
  decode (state) {
    if (state.end - state.start < 6) throw new Error('Out of bounds')
    return {
      id: null, // populated elsewhere
      host: state.buffer[state.start++] + '.' + state.buffer[state.start++] + '.' + state.buffer[state.start++] + '.' + state.buffer[state.start++],
      port: state.buffer[state.start++] + 256 * state.buffer[state.start++]
    }
  }
}

module.exports = { id, ipv4, ipv4Array: c.array(ipv4) }

function num (ip) {
  let n = 0
  let c = 0
  while (i < ip.length && (c = ip.charCodeAt(i++)) !== 46) n = n * 10 + (c - 48)
  return n
}

function id (ip, port, out = Buffer.allocUnsafe(32)) {
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
