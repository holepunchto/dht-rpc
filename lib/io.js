const { Message, Holepunch, TYPE } = require('./messages')
const blake2b = require('blake2b-universal')
const sodium = require('sodium-native')
const peers = require('ipv4-peers')
const speedometer = require('speedometer')

const VERSION = 1
const QUERY = Symbol('QUERY')
const UPDATE = Symbol('UPDATE')

const ECANCELLED = new Error('Request cancelled')
const ETIMEDOUT = new Error('Request timed out')

ETIMEDOUT.code = 'ETIMEDOUT'
ECANCELLED.code = 'ECANCELLED'

const TRIES = 3

class IO {
  constructor (socket, id, ctx) {
    this.id = id
    this.socket = socket
    this.inflight = []

    this._ctx = ctx
    this._rid = (Math.random() * 65536) | 0
    this._requests = new Array(65536)
    this._pending = []
    this._secrets = [randomBytes(32), randomBytes(32)]
    this._ticking = false
    this._tickInterval = setInterval(this._ontick.bind(this), 750)
    this._rotateInterval = setInterval(this._onrotate.bind(this), 300000)
    this._speed = speedometer()

    socket.on('message', this._onmessage.bind(this))
  }

  _token (peer, i) {
    const out = Buffer.allocUnsafe(32)
    blake2b.batch(out, [
      this._secrets[i],
      Buffer.from(peer.host)
    ])
    return out
  }

  _free () {
    const rid = this._rid++
    if (this._rid === 65536) this._rid = 0
    return rid
  }

  /*

      R
     / \
    A   B

    A sent a message to B that failed

    It could be that the message got dropped
    or that it needs holepunching

    To retry

    resend(req, A -> B)
    fire_and_forget({ _holepunch, to: B }, A -> R)

    R.onholepunch { to: B } => fire_and_forget({ _holepunch, from: A }, R -> B)
    B.onholepunch { from: A } => fire_and_forget({ _holepunch }, B -> A)

    A and B is now holepunched and the session has been retried as well

  */

  _holepunch (req) {
    const rid = req.message.command === '_holepunch'
      ? req.rid
      : this._free()

    const punch = {
      version: VERSION,
      type: TYPE.QUERY,
      to: encodeIP(req.peer.referrer),
      id: req.message.id,
      rid,
      command: '_holepunch',
      value: Holepunch.encode({
        to: peers.encode([req.peer])
      })
    }

    this.send(Message.encode(punch), req.peer.referrer)
  }

  _retry (req) {
    req.timeout = 4
    this.send(req.buffer, req.peer)
    // if referrer is avail, try holepunching automatically
    if (req.peer.referrer) this._holepunch(req)
  }

  _onmessage (buf, rinfo) {
    if (!rinfo.port) return
    const message = decodeMessage(buf)
    if (!message) return
    if (message.id && message.id.length !== 32) return
    // Force eph if older version
    if (message.id && !(message.version >= VERSION)) message.id = null

    const peer = { port: rinfo.port, host: rinfo.address }

    switch (message.type) {
      case TYPE.RESPONSE: {
        this._ctx.onresponse(message, peer)
        this._finish(message.rid, null, message, peer)
        break
      }

      case TYPE.QUERY: {
        this._ctx.onrequest(QUERY, message, peer)
        break
      }

      case TYPE.UPDATE: {
        const rt = message.roundtripToken
        if (!rt || (!rt.equals(this._token(peer, 0)) && !rt.equals(this._token(peer, 1)))) return
        this._ctx.onrequest(UPDATE, message, peer)
        break
      }
    }
  }

  _saturated () {
    return this._speed(0) >= this._ctx.concurrencyRPS && this.inflight.length >= this._ctx.concurrency
  }

  _finish (rid, err, val, peer) {
    const req = this._requests[rid]
    if (!req) return
    if (req.holepunch) clearTimeout(req.holepunch)

    this._requests[rid] = undefined
    const top = this.inflight[this.inflight.length - 1]
    this.inflight[top.index = req.index] = top
    this.inflight.pop()

    if (val && req.peer.id) {
      if (!val.id || val.id.length !== 32 || !val.id.equals(req.peer.id)) {
        this._ctx.onbadid(req.peer)
      }
    }

    const type = req.message.type === TYPE.QUERY
      ? QUERY
      : UPDATE

    req.callback(err, val, peer, req.message, req.peer, type)

    while (this._pending.length && !this._saturated()) {
      const { message, peer, callback } = this._pending.shift()
      this._requestImmediately(message, peer, callback)
    }
  }

  _request (message, peer, callback) {
    // Should we wait to send?
    if (this._pending.length || this._saturated()) {
      this._pending.push({ message, peer, callback })
    } else {
      this._requestImmediately(message, peer, callback)
    }
  }

  _requestImmediately (message, peer, callback) {
    const rid = message.rid = this._free()
    const buffer = Message.encode(message)

    this._speed(1)

    const req = {
      rid,
      index: this.inflight.length,
      callback,
      message,
      buffer,
      peer,
      timeout: this._ticking ? 5 : 4, // if ticking this will be decremented after this fun call
      tries: 0,
      holepunch: null
    }

    if (req.peer.referrer && !req.peer.fastHolepunch) {
      req.peer.fastHolepunch = true
      req.holepunch = setTimeout(holepunchNT, 500, this, req)
    }

    this._requests[rid] = req
    this.inflight.push(req)
    this.send(buffer, peer)

    // if sending a holepunch cmd, forward it right away
    if (message.command === '_holepunch') this._holepunch(req)
  }

  _cancel (rid, err, peer) {
    this._finish(rid, err || ECANCELLED, null, peer)
  }

  _onrotate () {
    this._secrets[1] = this._secrets[0]
    this._secrets[0] = randomBytes(32)
  }

  _ontick () {
    this._ticking = true

    for (var i = 0; i < this.inflight.length; i++) {
      const req = this.inflight[i]

      if (req.timeout === 2 && ++req.tries < TRIES) {
        if (this._saturated()) req.tries--
        else this._retry(req)
        continue
      }

      if (--req.timeout) {
        continue
      }

      this._cancel(req.rid, ETIMEDOUT, req.peer)
      i-- // the cancel removes the entry so we need to dec i
    }

    this._ticking = false
  }

  send (buffer, peer) {
    if (this._ctx.destroyed) return
    this.socket.send(buffer, 0, buffer.length, peer.port, peer.host)
  }

  destroy () {
    clearInterval(this._rotateInterval)
    clearInterval(this._tickInterval)

    this.socket.close()

    const pending = this._pending
    this._pending = []

    for (const req of pending) req.callback(ECANCELLED, null, req.peer)
    for (const req of this.inflight) this._cancel(req.rid, null, req.peer)
  }

  response (request, value, closerNodes, peer) {
    const message = {
      version: VERSION,
      type: TYPE.RESPONSE,
      rid: request.rid,
      to: peers.encode([peer]),
      id: this.id,
      closerNodes,
      roundtripToken: this._token(peer, 0),
      value
    }
    this.send(Message.encode(message), peer)
  }

  error (request, error, closerNodes, peer, value) {
    const message = {
      version: VERSION,
      type: TYPE.RESPONSE,
      rid: request.rid,
      to: peers.encode([peer]),
      id: this.id,
      closerNodes,
      error: error.message,
      value
    }
    this.send(Message.encode(message), peer)
  }

  query (command, target, value, peer, callback) {
    if (!callback) callback = noop

    this._request({
      version: VERSION,
      type: TYPE.QUERY,
      rid: 0,
      to: encodeIP(peer),
      id: this.id,
      target,
      command,
      value
    }, peer, callback)
  }

  queryImmediately (command, target, value, peer, callback) {
    if (!callback) callback = noop

    this._requestImmediately({
      version: VERSION,
      type: TYPE.QUERY,
      rid: 0,
      to: encodeIP(peer),
      id: this.id,
      target,
      command,
      value
    }, peer, callback)
  }

  update (command, target, value, peer, callback) {
    if (!callback) callback = noop

    this._request({
      version: VERSION,
      type: TYPE.UPDATE,
      rid: 0,
      to: encodeIP(peer),
      id: this.id,
      roundtripToken: peer.roundtripToken,
      target,
      command,
      value
    }, peer, callback)
  }
}

IO.QUERY = QUERY
IO.UPDATE = UPDATE
IO.VERSION = VERSION

module.exports = IO

function noop () {}

function holepunchNT (io, req) {
  io._holepunch(req)
}

function decodeMessage (buf) {
  try {
    return Message.decode(buf)
  } catch (err) {
    return null
  }
}

function randomBytes (n) {
  const buf = Buffer.allocUnsafe(32)
  sodium.randombytes_buf(buf)
  return buf
}

function encodeIP (peer) {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(peer.host) ? peers.encode([peer]) : null
}
