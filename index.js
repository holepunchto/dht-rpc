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

    const timeout = opts.timeout || 1000
    const tick = Math.floor(timeout / 4)
    const io = new IO(this.socket, this)

    this._io = io
    this._queryId = this.ephemeral ? null : this.id
    this._commands = new Map()
    this._secrets = [ randomBytes(32), randomBytes(32) ]
    this._tick = 0

    this._timeoutInterval = setInterval(this._io.tick.bind(this._io), tick)
    this._tickInterval = setInterval(this._ontick.bind(this), 5000)
    this._rotateInterval = setInterval(this._onrotate.bind(this), 300000)

    process.nextTick(this.bootstrap.bind(this))
  }

  _ontick () {
    this._tick++
    if ((this._tick & 7) === 0) this._pingSome()
  }

  _onrotate () {
    this._secrets[1] = this._secrets[0]
    this._secrets[0] = randomBytes(32)
  }

  address () {
    return this.socket.address()
  }

  command (name, opts) {
    this._commands.set(name, {
      valueEncoding: opts.valueEncoding && codecs(opts.valueEncoding),
      query: opts.query || queryNotSupported,
      update: opts.update || updateNotSupported
    })
  }

  ready (onready) {
    if (!this.bootstrapped) this.once('ready', onready)
    else onready()
  }

  onrequest (message, peer) {
    if (message.roundtripToken) {
      if (!message.roundtripToken.equals(this._token(peer, 0))) {
        if (!message.roundtripToken.equals(this._token(peer, 1))) {
          message.roundtripToken = null
        }
      }
    }

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
        return this._oncommand(message, peer)
    }
  }

  _onping (message, peer) {
    if (message.value && !this.id.equals(message.value)) return

    this._io.response({
      rid: message.rid,
      id: this._queryId,
      roundtripToken: this._token(peer, 0),
      value: peers.encode([ peer ])
    }, peer)
  }

  _onholepunch (message, peer) {
    const value = decodeHolepunch(message.value)
    if (!value) return

    if (value.to) {
      const to = decodePeer(value.to)
      if (!to && samePeer(to, peer)) return
      message.id = this._queryId
      message.value = Holepunch.encode({ from: peers.encode([ peer ]) })
      this.emit('holepunch', peer, to)
      this._io.send(Message.encode(message), to)
      return
    }

    if (value.from) {
      const from = decodePeer(value.from)
      if (from) peer = from
    }

    this._io.response({
      rid: message.rid,
      id: this._queryId
    }, peer)
  }

  _onfindnode (message, peer) {
    if (!validateId(message.target)) return

    this._io.response({
      rid: message.rid,
      id: this._queryId,
      closerNodes: nodes.encode(this.bucket.closest(message.target, 20)),
      roundtripToken: this._token(peer, 0)
    }, peer)
  }

  _oncommand (message, peer) {
    if (!message.target) return

    const self = this

    const cmd = this._commands.get(message.command)
    if (!cmd) return reply(new Error('Unsupported command'))

    const query = {
      command: message.command,
      node: peer,
      target: message.target,
      roundtripToken: message.roundtripToken,
      value: message.value
    }

    if (message.roundtripToken) cmd.update(query, reply)
    else cmd.query(query, reply)

    function reply (err, value) {
      self._io.response({
        rid: message.rid,
        id: self._queryId,
        closerNodes: nodes.encode(self.bucket.closest(message.target, 20)),
        roundtripToken: self._token(peer, 0),
        error: err ? err.message : undefined,
        value
      }, peer)
    }
  }

  onresponse (message, peer) {
    if (validateId(message.id)) {
      this._addNode(message.id, peer, message.roundtripToken)
    }
  }

  holepunch (peer, cb) {
    if (!peer.referrer) throw new Error('peer.referrer is required')
    this.request({ command: '_holepunch', id: this._queryId }, peer, cb)
  }

  request (message, peer, cb) {
    this._io.request(message, peer, false, cb)
  }

  destroy () {
    this.destroyed = true
    this._io.destroy()
    clearInterval(this._rotateInterval)
    clearInterval(this._timeoutInterval)
    clearInterval(this._tickInterval)
  }

  ping (peer, cb) {
    this._io.request({
      rid: 0,
      command: '_ping',
      id: this._queryId,
      value: peer.id
    }, peer, false, function (err, res) {
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
    const id = this._queryId

    ping()

    function ping () {
      const next = oldContacts.shift()
      if (!next) return
      self._io.request({
        rid: 0,
        command: '_ping',
        id,
        value: next.id
      }, next, true, afterPing)
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
    const cmd = this._commands.get(command)
    const enc = cmd && cmd.valueEncoding
    const query = {
      id: this._queryId,
      command,
      target,
      value: enc ? enc.encode(value) : value
    }
    return new QueryStream(this, query, opts)
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
