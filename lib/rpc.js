const dgram = require('dgram')
const { message } = require('./messages')

module.exports = class RPC {
  constructor (opts = {}) {
    this._pendingSends = []
    this._tid = (Math.random() * 65536) | 0
    this._drainInterval = null
    this._tick = 0
    this._w = 0
    this._win = [0, 0, 0, 0]

    this.maxWindow = opts.maxWindow || 80 // ~100 per second burst, ~80 per second avg
    this.maxRetries = 3
    this.destroyed = false
    this.inflight = []
    this.onrequest = opts.onrequest || noop
    this.onresponse = opts.onresponse || noop
    this.onwarning = opts.onwarning || noop
    this.socket = opts.socket || dgram.createSocket('udp4')
    this.socket.on('message', this.onmessage.bind(this))
  }

  get inflightRequests () {
    return this.inflight.length
  }

  send (m, socket = this.socket) {
    const state = { start: 0, end: 0, buffer: null }

    message.preencode(state, m)
    state.buffer = Buffer.allocUnsafe(state.end)
    message.encode(state, m)

    this._send(socket, state.buffer, m.to)
  }

  reply (req, reply, socket = this.socket) {
    reply.tid = req.tid
    reply.to = req.from
    this.send(reply, socket)
  }

  address () {
    return this.socket.address()
  }

  bind (port) {
    return new Promise((resolve, reject) => {
      const s = this.socket

      if (s.listen) {
        s.listen(port)
      } else {
        s.bind(port)
      }

      s.on('listening', onlistening)
      s.on('error', onerror)

      function onlistening () {
        s.removeListener('listening', onlistening)
        s.removeListener('error', onerror)
        resolve()
      }

      function onerror (err) {
        s.removeListener('listening', onlistening)
        s.removeListener('error', onerror)
        reject(err)
      }
    })
  }

  destroy () {
    if (this.destroyed) return
    this.unwrap(true)
    this.socket.close()
  }

  unwrap (closing = false) {
    if (this.destroyed) return
    this.destroyed = true

    clearInterval(this._drainInterval)
    this.socket.removeAllListeners()

    for (const req of this.inflight) {
      req.reject(new Error('RPC socket destroyed'))
    }

    this.inflight = []
    return this.socket
  }

  request (m, opts) {
    if (this.destroyed) return Promise.reject(new Error('RPC socket destroyed'))

    if (this._drainInterval === null) {
      this._drainInterval = setInterval(this._drain.bind(this), 750)
      if (this._drainInterval.unref) this._drainInterval.unref()
    }

    m.tid = this._tid++
    if (this._tid === 65536) this._tid = 0

    const state = { start: 0, end: 0, buffer: null }

    message.preencode(state, m)
    state.buffer = Buffer.allocUnsafe(state.end)
    message.encode(state, m)

    return new Promise((resolve, reject) => {
      const total = this._win[0] + this._win[1] + this._win[2] + this._win[3]
      const req = {
        socket: (opts && opts.socket) || this.socket,
        timeout: 2,
        expectOk: !!(opts && opts.expectOk !== false),
        tries: (opts && opts.retry === false) ? this.maxRetries : 0,
        tid: m.tid,
        buffer: state.buffer,
        to: m.to,
        resolve,
        reject
      }

      this.inflight.push(req)

      if (total < 2 * this.maxWindow && this._win[this._w] < this.maxWindow) {
        this._win[this._w]++
        req.tries++
        this._send(req.socket, req.buffer, req.to)
      }
    })
  }

  onmessage (buffer, rinfo) {
    const from = { host: rinfo.address, port: rinfo.port }
    if (!from.port) return
    if (buffer.byteLength <= 1) return

    const state = { start: 0, end: buffer.byteLength, buffer }
    let m = null

    try {
      m = message.decode(state)
    } catch (err) {
      this.onwarning(err)
      return
    }

    m.from = from

    if (m.command !== null) { // request
      if (this.onrequest === noop) return
      this.onrequest(m, this)
      return
    }

    const req = this._dequeue(m.tid)

    if (req === null) return
    if (m.id && (req.to.port !== from.port || req.to.host !== from.host)) m.id = null

    // decrement the inflight window as this is an "ack"
    if (this._win[this._w] > 0) this._win[this._w]--
    this.onresponse(m, this)

    if (m.status === 0 || req.expectOk === false) {
      req.resolve(m)
    } else {
      req.reject(createStatusError(m.status))
    }
  }

  _send (socket, buf, addr) {
    if (this.destroyed) return
    socket.send(buf, 0, buf.byteLength, addr.port, addr.host)
  }

  _dequeue (tid) {
    for (let i = 0; i < this.inflight.length; i++) {
      const req = this.inflight[i]

      if (req.tid === tid) {
        if (i === this.inflight.length - 1) this.inflight.pop()
        else this.inflight[i] = this.inflight.pop()
        return req
      }
    }

    return null
  }

  _drain () {
    let total = this._win[0] + this._win[1] + this._win[2] + this._win[3]

    for (let i = 0; i < this.inflight.length; i++) {
      const req = this.inflight[i]

      if (req.tries > 0 && --req.timeout >= 0) continue
      req.timeout = 2

      if (req.tries++ > this.maxRetries) {
        if (i === this.inflight.length - 1) this.inflight.pop()
        else this.inflight[i] = this.inflight.pop()
        req.reject(createTimeoutError())
        continue
      }

      if (total >= 2 * this.maxWindow || this._win[this._w] >= this.maxWindow) {
        req.tries--
        continue
      }

      total++
      this._win[this._w]++
      this._send(req.socket, req.buffer, req.to)
    }

    this._w = (this._w + 1) & 3
    this._win[this._w] = 0 // clear oldest
  }
}

function createTimeoutError () {
  const err = new Error('Request timed out')
  err.status = 0
  return err
}

function createStatusError (status) {
  const err = new Error('Request failed with status ' + status)
  err.status = status
  return err
}

function noop () {}
