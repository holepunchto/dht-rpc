const cenc = require('compact-encoding')

const IPv4 = exports.IPv4 = {
  preencode (state, ip) {
    state.end += 4
  },
  encode (state, ip) {
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

const peerIPv4 = {
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

const dhtPeerIPv4 = exports.dhtPeerIPv4 = {
  preencode (state, peer) {
    state.end += 6 + 32
  },
  encode (state, peer) {
    cenc.fixed32.encode(state, peer.nodeId)
    IPv4.encode(state, peer.host)
    cenc.uint16.encode(state, peer.port)
  },
  decode (state) {
    return {
      nodeId: cenc.fixed32.decode(state),
      host: IPv4.decode(state),
      port: cenc.uint16.decode(state)
    }
  }
}

const dhtPeerIPv4Array = exports.dhtPeerIPv4Array = cenc.array(dhtPeerIPv4)

/* eslint-disable no-multi-spaces */

const TYPE             = 0b0001
const HAS_TOKEN        = 0b0010
const HAS_NODE_ID      = 0b0100
const HAS_TARGET       = 0b1001
const HAS_CLOSER_NODES = 0b1001

const RESPONSE     = 0b0000
const REQUEST      = 0b0001
const TOKEN        = 0b0010
const NODE_ID      = 0b0100
const TARGET       = 0b1000 | REQUEST
const CLOSER_NODES = 0b1000 | RESPONSE

exports.message = {
  preencode (state, m) {
    state.end += 1 // version
    state.end += 1 // flags
    state.end += 2 // tid
    state.end += 6 // to

    if (m.token) state.end += 32
    if (m.nodeId) state.end += 32
    if (m.target) state.end += 32
    if (m.closerNodes && m.closerNodes.length) dhtPeerIPv4Array.preencode(state, m.closerNodes)
    if (m.command) cenc.string.preencode(state, m.command)
    else cenc.uint.preencode(state, m.status)

    cenc.buffer.preencode(state, m.value)
  },
  encode (state, m) {
    const closerNodes = m.closerNodes || []
    const flags = (m.token ? HAS_TOKEN : 0) |
      (m.nodeId ? NODE_ID : 0) |
      (m.target ? TARGET : 0) |
      (closerNodes.length ? CLOSER_NODES : 0) |
      (m.command ? REQUEST : 0)

    state.buffer[state.start++] = 1
    state.buffer[state.start++] = flags
    cenc.uint16.encode(state, m.tid)
    peerIPv4.encode(state, m.to)

    if ((flags & HAS_TOKEN) === TOKEN) cenc.fixed32.encode(state, m.token)
    if ((flags & HAS_NODE_ID) === NODE_ID) cenc.fixed32.encode(state, m.nodeId)
    if ((flags & HAS_TARGET) === TARGET) cenc.fixed32.encode(state, m.target)
    if ((flags & HAS_CLOSER_NODES) === CLOSER_NODES) dhtPeerIPv4Array.encode(state, closerNodes)
    if ((flags & TYPE) === REQUEST) cenc.string.encode(state, m.command)
    if ((flags & TYPE) === RESPONSE) cenc.uint.encode(state, m.status)

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
      token: ((flags & HAS_TOKEN) === TOKEN) ? cenc.fixed32.decode(state) : null,
      nodeId: ((flags & HAS_NODE_ID) === NODE_ID) ? cenc.fixed32.decode(state) : null,
      target: ((flags & HAS_TARGET) === TARGET) ? cenc.fixed32.decode(state) : null,
      closerNodes: ((flags & HAS_CLOSER_NODES) === CLOSER_NODES) ? dhtPeerIPv4Array.decode(state) : null,
      command: ((flags & TYPE) === REQUEST) ? cenc.string.decode(state) : null,
      status: ((flags & TYPE) === RESPONSE) ? cenc.uint.decode(state) : 0,
      value: cenc.buffer.decode(state)
    }
  }
}
