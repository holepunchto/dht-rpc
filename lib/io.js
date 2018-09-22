const { TYPE, Message, Holepunch } = require('./messages')
const peers = require('ipv4-peers')

const ECANCELLED = new Error('Request cancelled')
const ETIMEDOUT = new Error('Request timed out')

ETIMEDOUT.code = 'ETIMEDOUT'
ECANCELLED.code = 'ECANCELLED'

const { QUERY, UPDATE, RESPONSE } = TYPE
const TRIES = 3

class IO {
  constructor (socket, ctx) {
    this.inflight = []
    this.socket = socket
    this.socket.on('message', this.onmessage.bind(this))

    this._rid = Math.floor(Math.random() * 65536)
    this._requests = new Array(65536)
    this._ctx = ctx
    this._pending = []
  }

  tick () {
    for (var i = this.inflight.length - 1; i >= 0; i--) {
      const req = this.inflight[i]

      if (req.timeout === 2 && ++req.tries < TRIES) {
        this.retry(req)
        continue
      }

      if (--req.timeout) {
        continue
      }

      this.cancel(req.rid, ETIMEDOUT)
    }
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
    const rid = req.message.command === '_holepunch' ? req.rid : this.rid()
    const punch = {
      rid,
      command: '_holepunch',
      value: Holepunch.encode({
        to: peers.encode([ req.peer ])
      })
    }

    this.send(Message.encode(punch), req.peer.referrer)
  }

  retry (req) {
    // retry message
    req.timeout = 4
    this.send(req.buffer, req.peer)
    // if referrer is avail, try holepunching automatically
    if (req.peer.referrer) this._holepunch(req)
  }

  onmessage (buf, rinfo) {
    const message = decode(buf)
    if (!message) return

    const peer = { host: rinfo.address, port: rinfo.port }

    if (message.type === RESPONSE) {
      this._ctx.onresponse(message, peer)
      this.finish(message.rid, null, message, peer)
      return
    }

    this._ctx.onrequest(message, peer)
  }

  request (request, peer, important, callback) {
    if (!callback) callback = noop
    if (!important && (this.inflight.length >= this._ctx.concurrency || this._pending.length)) {
      this._pending.push({ request, peer, callback })
      return
    }

    const req = this.queue(request, peer, callback)
    this.send(req.buffer, peer)

    // if sending holepunch cmd, forward right away
    if (request.command === '_holepunch') {
      this._holepunch(req)
    }
  }

  query (request, peer, important, callback) {
    request.type = QUERY
    this.request(request, peer, important, callback)
  }

  update (request, peer, important, callback) {
    request.type = UPDATE
    this.request(request, peer, important, callback)
  }

  response (response, peer) {
    response.type = RESPONSE
    this.send(Message.encode(response), peer)
  }

  send (buf, peer) {
    this.socket.send(buf, 0, buf.length, peer.port, peer.host)
  }

  destroy () {
    this.socket.close()

    const pending = this._pending
    this._pending = []

    for (const req of pending) req.callback(ECANCELLED)
    for (const req of this.inflight) this.cancel(req.rid)
  }

  rid () {
    const rid = this._rid++
    if (this._rid === 65536) this._rid = 0
    return rid
  }

  queue (message, peer, callback) {
    message.rid = this.rid()

    const buffer = Message.encode(message)
    const req = {
      rid: message.rid,
      index: this.inflight.length,
      callback,
      message,
      buffer,
      peer,
      timeout: 4,
      tries: 0
    }

    this.inflight.push(req)
    this._requests[req.rid] = req
    return req
  }

  cancel (rid, err) {
    this.finish(rid, err || ECANCELLED, null, null)
  }

  finish (rid, err, val, peer) {
    const req = this._requests[rid]
    if (!req) return

    this._requests[rid] = undefined
    const top = this.inflight[this.inflight.length - 1]
    this.inflight[top.index = req.index] = top
    this.inflight.pop()

    req.callback(err, val, peer, req.message, req.peer)

    while (this._pending.length && this.inflight.length < this._ctx.concurrency) {
      const { request, peer, callback } = this._pending.shift()
      this.send(this.queue(request, peer, callback).buffer, peer)
    }
  }
}

module.exports = IO

function noop () {}

function decode (buf) {
  try {
    return Message.decode(buf)
  } catch (err) {
    return null
  }
}
