const cenc = require('compact-encoding')

const IPv4 = exports.IPv4 = {
  preencode (state, ip) {
    state.end += 4
  },
  encode (state, ip) { // TODO: move over fast parser from ./id.js
    const nums = ip.split('.')
    state.buffer[state.start++] = Number(nums[0]) || 0
    state.buffer[state.start++] = Number(nums[1]) || 0
    state.buffer[state.start++] = Number(nums[2]) || 0
    state.buffer[state.start++] = Number(nums[3]) || 0
  },
  decode (state) {
    if (state.end - state.start < 4) throw new Error('Out of bounds')
    return state.buffer[state.start++] + '.' + state.buffer[state.start++] + '.' + state.buffer[state.start++] + '.' + state.buffer[state.start++]
  }
}

const peerIPv4 = exports.peerIPv4 = {
  preencode (state, peer) {
    state.end += 6
  },
  encode (state, peer) {
    IPv4.encode(state, peer.host)
    cenc.uint16.encode(state, peer.port)
  },
  decode (state) {
    return {
      host: IPv4.decode(state),
      port: cenc.uint16.decode(state)
    }
  }
}

const peerIPv4Array = exports.peerIPv4Array = cenc.array(peerIPv4)

const IS_REQUEST = 0b0001
const HAS_ID = 0b0010
const HAS_TOKEN = 0b0100
const ROUTE_INFO = 0b1000 | IS_REQUEST
const HAS_TARGET = ROUTE_INFO | IS_REQUEST
const HAS_CLOSER_NODES = ROUTE_INFO ^ IS_REQUEST

exports.message = {
  preencode (state, m) {
    state.end += 1 // version
    state.end += 1 // flags
    state.end += 2 // tid
    state.end += 6 // to

    if (m.id) state.end += 32
    if (m.token) state.end += 32
    if (m.target) state.end += 32
    if (m.closerNodes && m.closerNodes.length) peerIPv4Array.preencode(state, m.closerNodes)
    if (m.command) cenc.string.preencode(state, m.command)
    else cenc.uint.preencode(state, m.status)

    cenc.buffer.preencode(state, m.value)
  },
  encode (state, m) {
    const closerNodes = m.closerNodes || []
    const flags = (m.id ? HAS_ID : 0) |
      (m.token ? HAS_TOKEN : 0) |
      (closerNodes.length ? HAS_CLOSER_NODES : 0) |
      (m.target ? HAS_TARGET : 0) |
      (m.command ? IS_REQUEST : 0)

    state.buffer[state.start++] = 1
    state.buffer[state.start++] = flags

    cenc.uint16.encode(state, m.tid)
    peerIPv4.encode(state, m.to)

    if ((flags & HAS_ID) === HAS_ID) cenc.fixed32.encode(state, m.id)
    if ((flags & HAS_TOKEN) === HAS_TOKEN) cenc.fixed32.encode(state, m.token)
    if ((flags & ROUTE_INFO) === HAS_TARGET) cenc.fixed32.encode(state, m.target)
    if ((flags & ROUTE_INFO) === HAS_CLOSER_NODES) peerIPv4Array.encode(state, closerNodes)
    if ((flags & IS_REQUEST) === IS_REQUEST) cenc.string.encode(state, m.command)
    if ((flags & IS_REQUEST) === 0) cenc.uint.encode(state, m.status)

    cenc.buffer.encode(state, m.value)
  },
  decode (state) {
    const version = state.buffer[state.start++]

    if (version !== 1) {
      throw new Error('Incompatible version')
    }

    const flags = cenc.uint.decode(state)

    return {
      version: 1,
      tid: cenc.uint16.decode(state),
      from: null, // populated in caller
      to: peerIPv4.decode(state),
      id: (flags & HAS_ID) === HAS_ID ? cenc.fixed32.decode(state) : null,
      token: (flags & HAS_TOKEN) === HAS_TOKEN ? cenc.fixed32.decode(state) : null,
      target: ((flags & ROUTE_INFO) === HAS_TARGET) ? cenc.fixed32.decode(state) : null,
      closerNodes: ((flags & ROUTE_INFO) === HAS_CLOSER_NODES) ? peerIPv4Array.decode(state) : null,
      command: ((flags & IS_REQUEST) === IS_REQUEST) ? cenc.string.decode(state) : null,
      status: ((flags & IS_REQUEST) === 0) ? cenc.uint.decode(state) : 0,
      value: cenc.buffer.decode(state)
    }
  }
}
