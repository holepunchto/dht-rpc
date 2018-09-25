const { EventEmitter } = require('events')
const peers = require('ipv4-peers')
const dgram = require('dgram')
const sodium = require('sodium-universal')
const KBucket = require('k-bucket')
const tos = require('time-ordered-set')
const collect = require('stream-collector')
const codecs = require('codecs')
const { Message, Holepunch } = require('./lib/messages')
const IO = require('./lib/io')
const QueryStream = require('./lib/query-stream')
const blake2b = require('./lib/blake2b')

const UNSUPPORTED_COMMAND = new Error('Unsupported command')
const nodes = peers.idLength(32)

exports = module.exports = opts => new DHT(opts)

class DHT extends EventEmitter {
  constructor (opts) {
    if (!opts) opts = {}

    super()

    this.bootstrapped = false
    this.destroyed = false
    this.concurrency = 16
    this.socket = dgram.createSocket('udp4')
    this.id = randomBytes(32)
    this.inflightQueries = 0
    this.ephemeral = !!opts.ephemeral

    this.nodes = tos()
    this.bucket = new KBucket({ localNodeId: this.id })
    this.bucket.on('ping', this._onnodeping.bind(this))
    this.bootstrapNodes = [].concat(opts.bootstrap || []).map(parsePeer)

    this.socket.on('listening', this.emit.bind(this, 'listening'))
    this.socket.on('close', this.emit.bind(this, 'close'))

    const queryId = this.ephemeral ? null : this.id
    const io = new IO(this.socket, queryId, this)

    this._io = io
    this._commands = new Map()
    this._tick = 0
    this._tickInterval = setInterval(this._ontick.bind(this), 5000)

    process.nextTick(this.bootstrap.bind(this))
  }

  _ontick () {
    this._tick++
    if ((this._tick & 7) === 0) this._pingSome()
  }

  address () {
    return this.socket.address()
  }

  command (name, opts) {
    this._commands.set(name, {
      inputEncoding: codecs(opts.inputEncoding || opts.valueEncoding),
      outputEncoding: codecs(opts.outputEncoding || opts.valueEncoding),
      query: opts.query || queryNotSupported,
      update: opts.update || updateNotSupported
    })
  }

  ready (onready) {
    if (!this.bootstrapped) this.once('ready', onready)
    else onready()
  }

  onrequest (type, message, peer) {
    if (validateId(message.id)) {
      this._addNode(message.id, peer, null)
    }

    switch (message.command) {
      case '_ping':
        return this._onping(message, peer)

      case '_find_node':
        return this._onfindnode(message, peer)

      case '_holepunch':
        return this._onholepunch(message, peer)

      default:
        return this._oncommand(type, message, peer)
    }
  }

  _onping (message, peer) {
    if (message.value && !this.id.equals(message.value)) return
    this._io.response(message, peers.encode([ peer ]), null, peer)
  }

  _onholepunch (message, peer) {
    const value = decodeHolepunch(message.value)
    if (!value) return

    if (value.to) {
      const to = decodePeer(value.to)
      if (!to || samePeer(to, peer)) return
      message.id = this._io.id
      message.value = Holepunch.encode({ from: peers.encode([ peer ]) })
      this.emit('holepunch', peer, to)
      this._io.send(Message.encode(message), to)
      return
    }

    if (value.from) {
      const from = decodePeer(value.from)
      if (from) peer = from
    }

    this._io.response(message, null, null, peer)
  }

  _onfindnode (message, peer) {
    if (!validateId(message.target)) return

    const closerNodes = nodes.encode(this.bucket.closest(message.target, 20))
    this._io.response(message, null, closerNodes, peer)
  }

  _oncommand (type, message, peer) {
    if (!message.target) return

    const self = this
    const cmd = this._commands.get(message.command)

    if (!cmd) return reply(UNSUPPORTED_COMMAND)

    const query = {
      type,
      command: message.command,
      node: peer,
      target: message.target,
      value: cmd.inputEncoding.decode(message.value)
    }

    if (type === IO.UPDATE) cmd.update(query, reply)
    else cmd.query(query, reply)

    function reply (err, value) {
      const closerNodes = nodes.encode(self.bucket.closest(message.target, 20))
      if (err) return self._io.error(message, err, closerNodes, peer)
      self._io.response(message, value && cmd.outputEncoding.encode(value), closerNodes, peer)
    }
  }

  onresponse (message, peer) {
    if (validateId(message.id)) {
      this._addNode(message.id, peer, message.roundtripToken)
    }
  }

  holepunch (peer, cb) {
    if (!peer.referrer) throw new Error('peer.referrer is required')
    this._io.query('_holepunch', null, null, peer, cb)
  }

  destroy () {
    this.destroyed = true
    this._io.destroy()
    clearInterval(this._tickInterval)
  }

  ping (peer, cb) {
    this._io.query('_ping', null, peer.id, peer, function (err, res) {
      if (err) return cb(err)
      if (res.error) return cb(new Error(res.error))
      const pong = decodePeer(res.value)
      if (!pong) return cb(new Error('Invalid pong'))
      cb(null, pong)
    })
  }

  _addNode (id, peer, token) {
    if (id.equals(this.id)) return

    var node = this.bucket.get(id)
    const fresh = !node

    if (!node) node = {}

    node.id = id
    node.port = peer.port
    node.host = peer.host
    if (token) node.roundtripToken = token
    node.tick = this._tick

    if (!fresh) this.nodes.remove(node)
    this.nodes.add(node)
    this.bucket.add(node)
    if (fresh) this.emit('add-node', node)
  }

  _removeNode (node) {
    this.nodes.remove(node)
    this.bucket.remove(node.id)
    this.emit('remove-node')
  }

  _token (peer, i) {
    return blake2b.batch([
      this._secrets[i],
      Buffer.from(peer.host)
    ])
  }

  _onnodeping (oldContacts, newContact) {
    // if bootstrapping, we've recently pinged all nodes
    if (!this.bootstrapped) return

    const reping = []

    for (var i = 0; i < oldContacts.length; i++) {
      const old = oldContacts[i]

      // check if we recently talked to this peer ...
      if (this._tick === old.tick) {
        this.bucket.add(oldContacts[i])
        continue
      }

      reping.push(old)
    }

    if (reping.length) this._reping(reping, newContact)
  }

  _check (node) {
    const self = this
    this.ping(node, function (err) {
      if (err) self._removeNode(node)
    })
  }

  _reping (oldContacts, newContact) {
    const self = this

    ping()

    function ping () {
      const next = oldContacts.shift()
      if (!next) return
      self._io.queryImmediately('_ping', null, next.id, next, afterPing)
    }

    function afterPing (err, res, node) {
      if (!err) return ping()
      self._removeNode(node)
      self.bucket.add(newContact)
    }
  }

  _pingSome () {
    var cnt = this.inflightQueries > 2 ? 1 : 3
    var oldest = this.nodes.oldest

    while (cnt--) {
      if (!oldest || this._tick === oldest.tick) continue
      this._check(oldest)
      oldest = oldest.next
    }
  }

  query (command, target, value, cb) {
    if (typeof value === 'function') return this.query(command, target, null, value)
    return collect(this.runCommand(command, target, value, { query: true, update: false }), cb)
  }

  update (command, target, value, cb) {
    if (typeof value === 'function') return this.update(command, target, null, value)
    return collect(this.runCommand(command, target, value, { query: false, update: true }), cb)
  }

  queryAndUpdate (command, target, value, cb) {
    if (typeof value === 'function') return this.queryAndUpdate(command, target, null, value)
    return collect(this.runCommand(command, target, value, { query: true, update: true }), cb)
  }

  runCommand (command, target, value, opts) {
    return new QueryStream(this, command, target, value, opts)
  }

  listen (port, addr, cb) {
    if (typeof port === 'function') return this.listen(0, null, port)
    if (typeof addr === 'function') return this.listen(port, null, addr)
    if (cb) this.once('listening', cb)
    this.socket.bind(port, addr)
  }

  bootstrap (cb) {
    const self = this
    const backgroundCon = Math.min(this.concurrency, Math.max(2, Math.floor(this.concurrency / 8)))

    if (!this.bootstrapNodes.length) return process.nextTick(done)

    const qs = this.query('_find_node', this.id)

    qs.on('data', update)
    qs.on('error', onerror)
    qs.on('end', done)

    update()

    function onerror (err) {
      if (cb) cb(err)
    }

    function done () {
      if (!self.bootstrapped) {
        self.bootstrapped = true
        self.emit('ready')
      }
      if (cb) cb()
    }

    function update () {
      qs._concurrency = self.inflightQueries === 1 ? self.concurrency : backgroundCon
    }
  }
}

exports.QUERY = DHT.QUERY = IO.QUERY
exports.UPDATE = DHT.UPDATE = IO.UPDATE
exports.DHT = DHT

function validateId (id) {
  return id && id.length === 32
}

function randomBytes (n) {
  const buf = Buffer.allocUnsafe(n)
  sodium.randombytes_buf(buf)
  return buf
}

function decodeHolepunch (buf) {
  try {
    return Holepunch.decode(buf)
  } catch (err) {
    return null
  }
}

function decodePeer (buf) {
  try {
    const p = peers.decode(buf)[0]
    if (!p) throw new Error('No peer in buffer')
    return p
  } catch (err) {
    return null
  }
}

function parsePeer (peer) {
  if (typeof peer === 'object' && peer) return peer
  if (typeof peer === 'number') return parsePeer(':' + peer)
  if (peer[0] === ':') return parsePeer('127.0.0.1' + peer)

  const parts = peer.split(':')
  return {
    host: parts[0],
    port: parseInt(parts[1], 10)
  }
}

function samePeer (a, b) {
  return a.port === b.port && a.host === b.host
}

function updateNotSupported (query, cb) {
  cb(new Error('Update not supported'))
}

function queryNotSupported (query, cb) {
  cb(null, null)
}
