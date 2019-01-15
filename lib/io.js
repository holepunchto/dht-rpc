const { Message, Holepunch, TYPE } = require('./messages')
const blake2b = require('./blake2b')
const peers = require('ipv4-peers')
const sodium = require('sodium-universal')

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
    this._olderSecret = randomBytes(32)
    this._newerSecret = randomBytes(32)
    this._tickInterval = setInterval(this._ontick.bind(this), 250)
    this._rotateInterval = setInterval(this._onrotate.bind(this), 300000)

    socket.on('message', this._onmessage.bind(this))
  }

  _token (peer, secret) {
    return blake2b.batch([
      secret,
      Buffer.from(peer.host)
    ])
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
      type: req.message.type,
      rid,
      command: '_holepunch',
      value: Holepunch.encode({
        to: peers.encode([ req.peer ])
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
    const message = decodeMessage(buf)
    if (!message) return

    const peer = { port: rinfo.port, host: rinfo.address }

    switch (message.type) {
      case TYPE.RESPONSE:
        this._ctx.onresponse(message, peer)
        this._finish(message.rid, null, message, peer)
        break

      case TYPE.QUERY:
        this._ctx.onrequest(QUERY, message, peer)
        break

      case TYPE.UPDATE:
        const rt = message.roundtripToken
        if (!rt || (!rt.equals(this._token(peer, this._olderSecret)) && !rt.equals(this._token(peer, this._newerSecret)))) return
        this._ctx.onrequest(UPDATE, message, peer)
        break
    }
  }

  _finish (rid, err, val, peer) {
    const req = this._requests[rid]
    if (!req) return

    this._requests[rid] = undefined
    const top = this.inflight[this.inflight.length - 1]
    this.inflight[top.index = req.index] = top
    this.inflight.pop()

    const type = req.message.type === TYPE.QUERY
      ? QUERY
      : UPDATE

    req.callback(err, val, peer, req.message, req.peer, type)

    while (this._pending.length && this.inflight.length < this._ctx.concurrency) {
      const { message, peer, callback } = this._pending.shift()
      this._requestImmediately(message, peer, callback)
    }
  }

  _request (message, peer, callback) {
    // Should we wait to send?
    if (this._pending.length || (this.inflight.length >= this._ctx.concurrency)) {
      this._pending.push({ message, peer, callback })
    } else {
      this._requestImmediately(message, peer, callback)
    }
  }

  _requestImmediately (message, peer, callback) {
    const rid = message.rid = this._free()
    const buffer = Message.encode(message)

    const req = {
      rid,
      index: this.inflight.length,
      callback,
      message,
      buffer,
      peer,
      timeout: 4,
      tries: 0
    }

    this._requests[rid] = req
    this.inflight.push(req)
    this.send(buffer, peer)

    // if sending a holepunch cmd, forward it right away
    if (message.command === '_holepunch') this._holepunch(req)
  }

  _cancel (rid, err) {
    this._finish(rid, err || ECANCELLED, null, null)
  }

  _onrotate () {
    this._olderSecret = this._newerSecret
    this._newerSecret = randomBytes(32)
  }

  _ontick () {
    for (var i = this.inflight.length - 1; i >= 0; i--) {
      const req = this.inflight[i]

      if (req.timeout === 2 && ++req.tries < TRIES) {
        this._retry(req)
        continue
      }

      if (--req.timeout) {
        continue
      }

      this._cancel(req.rid, ETIMEDOUT)
    }
  }

  send (buffer, peer) {
    this.socket.send(buffer, 0, buffer.length, peer.port, peer.host)
  }

  destroy () {
    clearInterval(this._rotateInterval)
    clearInterval(this._tickInterval)

    this.socket.close()

    const pending = this._pending
    this._pending = []

    for (const req of pending) req.callback(ECANCELLED)
    for (const req of this.inflight) this._cancel(req.rid)
  }

  response (request, value, closerNodes, peer) {
    const message = {
      type: TYPE.RESPONSE,
      rid: request.rid,
      id: this.id,
      closerNodes,
      roundtripToken: this._token(peer, this._newerSecret),
      value
    }

    this.send(Message.encode(message), peer)
  }

  error (request, error, closerNodes, peer) {
    const message = {
      type: TYPE.RESPONSE,
      rid: request.rid,
      id: this.id,
      closerNodes,
      error: error.message
    }

    this.send(Message.encode(message), peer)
  }

  query (command, target, value, peer, callback) {
    if (!callback) callback = noop

    this._request({
      type: TYPE.QUERY,
      rid: 0,
      id: this.id,
      target,
      command,
      value
    }, peer, callback)
  }

  queryImmediately (command, target, value, peer, callback) {
    if (!callback) callback = noop

    this._requestImmediately({
      type: TYPE.QUERY,
      rid: 0,
      id: this.id,
      target,
      command,
      value
    }, peer, callback)
  }

  update (command, target, value, peer, callback) {
    if (!callback) callback = noop

    this._request({
      type: TYPE.UPDATE,
      rid: 0,
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

module.exports = IO

function noop () {}

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
