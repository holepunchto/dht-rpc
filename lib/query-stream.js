const { Readable } = require('stream')
const peers = require('ipv4-peers')
const nodes = peers.idLength(32)
const QueryTable = require('./query-table')

const BOOTSTRAPPING = Symbol('BOOTSTRAPPING')
const MOVING_CLOSER = Symbol('MOVING_CLOSER')
const UPDATING = Symbol('UPDATING')
const FINALIZED = Symbol('FINALIZED')

class QueryStream extends Readable {
  constructor (node, command, target, value, opts) {
    if (!opts) opts = {}
    if (!opts.concurrency) opts.concurrency = opts.highWaterMark || node.concurrency

    super({
      objectMode: true
    })

    const cmd = node._commands.get(command)

    this.command = command
    this.target = target
    this.value = (cmd && value) ? cmd.inputEncoding.encode(value) : (value || null)
    this.update = !!opts.update
    this.query = !!opts.query || !opts.update
    this.destroyed = false
    this.inflight = 0
    this.responses = 0
    this.errors = 0
    this.updates = 0
    this.table = opts.table || new QueryTable(node.id, target)

    node.inflightQueries++

    this._status = opts.table ? MOVING_CLOSER : BOOTSTRAPPING
    this._node = node
    this._concurrency = opts.concurrency
    this._callback = this._onresponse.bind(this)
    this._map = identity
    this._outputEncoding = cmd ? cmd.outputEncoding : null
  }

  map (fn) {
    this._map = fn
    return this
  }

  _onresponse (err, message, peer, request, to, type) {
    this.inflight--
    if (err && to && to.id) {
      // Request, including retries, failed completely
      // Remove the "to" node.
      const node = this._node.bucket.get(to.id)
      if (node) this._node._removeNode(node)
    }

    if (this._status === FINALIZED) {
      if (!this.inflight) {
        if (this.destroyed) this.emit('close')
        else this.destroy()
      }
      return
    }

    if (err) {
      this.errors++
      this.emit('warning', err)
      this._readMaybe()
      return
    }

    this.responses++
    this.emit('response')
    this.table.addVerified(message, peer)

    if (this._status === MOVING_CLOSER) {
      const candidates = decodeNodes(message.closerNodes)
      for (var i = 0; i < candidates.length; i++) {
        this.table.addUnverified(candidates[i], peer)
      }
    } else if (this._status === UPDATING) {
      this.updates++
    }

    if (message.error) {
      const { value } = message
      const proof = value && this._decodeOutput(value)
      this.emit('warning', new Error(message.error), proof)
      this._readMaybe()
      return
    }

    if (!this.query && this._status === MOVING_CLOSER) {
      this._readMaybe()
      return
    }

    const value = this._outputEncoding
      ? this._decodeOutput(message.value)
      : message.value

    const data = this._map({
      type,
      to: message.to && message.to.length === 6 ? peers.decode(message.to)[0] : null,
      node: {
        id: message.id,
        port: peer.port,
        host: peer.host
      },
      value
    })

    if (!data) {
      this._readMaybe()
      return
    }

    this.push(data)
  }

  _decodeOutput (val) {
    try {
      return val && this._outputEncoding.decode(val)
    } catch (err) {
      return null
    }
  }

  _bootstrap () {
    const table = this.table
    const bootstrap = this._node.bucket.closest(table.target, table.k)
    var i = 0

    for (; i < bootstrap.length; i++) {
      const b = bootstrap[i]
      const node = { id: b.id, port: b.port, host: b.host }
      table.addUnverified(node, null)
    }

    const bootstrapNodes = this._node.bootstrapNodes
    if (bootstrap.length < bootstrapNodes.length) {
      for (i = 0; i < bootstrapNodes.length; i++) {
        this._send(bootstrapNodes[i], true, false)
      }
    }

    this._status = MOVING_CLOSER
    this._moveCloser()
  }

  _sendAll (nodes, force, sendToken) {
    var free = Math.max(0, this._concurrency - this._node._io.inflight.length)
    var sent = 0

    if (!free && !this.inflight) free = 1
    if (!free) return 0

    for (var i = 0; i < nodes.length; i++) {
      if (this._send(nodes[i], force, sendToken)) {
        if (++sent === free) break
      }
    }

    return sent
  }

  _send (node, force, isUpdate) {
    if (!force) {
      if (node.queried) return false
      node.queried = true
    }

    this.inflight++
    const io = this._node._io

    if (isUpdate) {
      if (!node.roundtripToken) return this._callback(new Error('Roundtrip token is required'))
      io.update(this.command, this.target, this.value, node, this._callback)
    } else if (this.query) {
      io.query(this.command, this.target, this.value, node, this._callback)
    } else {
      io.query('_find_node', this.target, null, node, this._callback)
    }

    return true
  }

  _sendUpdate () {
    const sent = this._sendAll(this.table.closest, false, true)
    if (sent || this.inflight) return

    this._finalize()
  }

  _moveCloser () {
    const table = this.table
    const sent = this._sendAll(table.unverified, false, false)
    if (sent || this.inflight) return

    if (this.update) {
      for (var i = 0; i < table.closest.length; i++) {
        table.closest[i].queried = false
      }
      this._status = UPDATING
      this._sendUpdate()
    } else {
      this._finalize()
    }
  }

  _finalize () {
    const status = this._status
    if (status === FINALIZED) return

    this._status = FINALIZED
    this._node.inflightQueries--

    if (!this.responses && !this.destroyed) {
      this.destroy(new Error('No nodes responded'))
    }
    if (status === UPDATING && !this.updates && !this.destroyed) {
      this.destroy(new Error('No close nodes responded'))
    }

    this.push(null)
  }

  _readMaybe () {
    if (!this.inflight || this._readableState.flowing === true) this._read()
  }

  _read () {
    if (this._node.destroyed) return

    switch (this._status) {
      case BOOTSTRAPPING: return this._bootstrap()
      case MOVING_CLOSER: return this._moveCloser()
      case UPDATING: return this._sendUpdate()
      case FINALIZED: return
    }

    throw new Error('Unknown status: ' + this._status)
  }

  destroy (err) {
    if (this.destroyed) return
    this.destroyed = true

    if (err) this.emit('error', err)
    this._finalize()
    if (!this.inflight) this.emit('close')
  }
}

module.exports = QueryStream

function decodeNodes (buf) {
  if (!buf) return []
  try {
    return nodes.decode(buf)
  } catch (err) {
    return []
  }
}

function identity (a) {
  return a
}
