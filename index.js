var udp = require('udp-request')
var KBucket = require('k-bucket')
var inherits = require('inherits')
var events = require('events')
var peers = require('ipv4-peers')
var collect = require('stream-collector')
var sodium = require('sodium-universal')
var nodes = peers.idLength(32)
var messages = require('./messages')
var queryStream = require('./query-stream')
var blake2b = require('./blake2b')

module.exports = DHT

function DHT (opts) {
  if (!(this instanceof DHT)) return new DHT(opts)
  if (!opts) opts = {}

  events.EventEmitter.call(this)

  var self = this

  this.concurrency = opts.concurrency || 16
  this.id = opts.id || randomBytes(32)
  this.ephemeral = !!opts.ephemeral
  this.nodes = new KBucket({localNodeId: this.id, arbiter: arbiter})
  this.nodes.on('ping', onnodeping)
  this.inflightQueries = 0

  this.socket = udp({
    socket: opts.socket,
    requestEncoding: messages.Request,
    responseEncoding: messages.Response
  })

  this.socket.on('request', onrequest)
  this.socket.on('response', onresponse)
  this.socket.on('close', onclose)

  this._bootstrap = [].concat(opts.bootstrap || []).map(parseAddr)
  this._queryId = this.ephemeral ? null : this.id
  this._bootstrapped = false
  this._pendingRequests = []
  this._tick = 0
  this._secrets = [randomBytes(32), randomBytes(32)]
  this._secretsInterval = setInterval(rotateSecrets, 5 * 60 * 1000)
  this._tickInterval = setInterval(tick, 5 * 1000)
  this._top = null
  this._bottom = null

  if (opts.nodes) {
    for (var i = 0; i < opts.nodes.length; i++) {
      this._addNode(opts.nodes[i].id, opts.nodes[i])
    }
  }

  process.nextTick(function () {
    self.bootstrap()
  })

  function rotateSecrets () {
    self._rotateSecrets()
  }

  function onrequest (request, peer) {
    self._onrequest(request, peer)
  }

  function onresponse (response, peer) {
    self._onresponse(response, peer)
  }

  function onnodeping (oldContacts, newContact) {
    self._onnodeping(oldContacts, newContact)
  }

  function onclose () {
    while (self._pendingRequests.length) {
      self._pendingRequests.shift().callback(new Error('Request cancelled'))
    }
    self.emit('close')
  }

  function tick () {
    self._tick++
    if ((self._tick & 7) === 0) self._pingSome()
  }
}

inherits(DHT, events.EventEmitter)

DHT.prototype.ready = function (cb) {
  if (!this._bootstrapped) this.once('ready', cb)
  else cb()
}

DHT.prototype.query = function (query, opts, cb) {
  if (typeof opts === 'function') return this.query(query, null, opts)
  return collect(queryStream(this, query, opts), cb)
}

DHT.prototype.update = function (query, opts, cb) {
  if (typeof opts === 'function') return this.update(query, null, opts)
  if (!opts) opts = {}
  if (opts.query) opts.verbose = true
  opts.token = true
  return collect(queryStream(this, query, opts), cb)
}

DHT.prototype._pingSome = function () {
  var cnt = this.inflightQueries > 2 ? 1 : 3
  var oldest = this._bottom

  while (cnt--) {
    if (!oldest || this._tick - oldest.tick < 3) continue
    this._check(oldest)
    oldest = oldest.next
  }
}

DHT.prototype.holepunch = function (peer, referrer, cb) {
  this._holepunch(parseAddr(peer), parseAddr(referrer), cb)
}

DHT.prototype.ping = function (peer, cb) {
  this._ping(parseAddr(peer), function (err, res, peer) {
    if (err) return cb(err)
    var rinfo = decodePeer(res.value)
    if (!rinfo) return cb(new Error('Invalid pong'))
    cb(null, rinfo, {port: peer.port, host: peer.host, id: res.id})
  })
}

DHT.prototype.toArray = function () {
  return this.nodes.toArray()
}

DHT.prototype.destroy = function () {
  clearInterval(this._secretsInterval)
  clearInterval(this._tickInterval)
  this.socket.destroy()
}

DHT.prototype.address = function () {
  return this.socket.address()
}

DHT.prototype._rotateSecrets = function () {
  var secret = randomBytes(32)
  this._secrets[1] = this._secrets[0]
  this._secrets[0] = secret
}

DHT.prototype.bootstrap = function (cb) {
  var self = this

  if (!this._bootstrap.length) return process.nextTick(done)

  var backgroundCon = Math.min(self.concurrency, Math.max(2, Math.floor(self.concurrency / 8)))
  var qs = this.query({
    command: '_find_node',
    target: this.id
  })

  qs.on('data', update)
  qs.on('error', onerror)
  qs.on('end', done)

  update()

  function onerror (err) {
    if (cb) cb(err)
  }

  function done () {
    if (!self._bootstrapped) {
      self._bootstrapped = true
      self.emit('ready')
    }
    if (cb) cb()
  }

  function update () {
    qs._concurrency = self.inflightQueries === 1 ? self.concurrency : backgroundCon
  }
}

DHT.prototype._ping = function (peer, cb) {
  this._request({command: '_ping', id: this._queryId}, peer, false, cb)
}

DHT.prototype._holepunch = function (peer, referrer, cb) {
  this._request({command: '_ping', id: this._queryId, forwardRequest: encodePeer(peer)}, referrer, false, cb)
}

DHT.prototype._request = function (request, peer, important, cb) {
  if (this.socket.inflight >= this.concurrency || this._pendingRequests.length) {
    this._pendingRequests.push({request: request, peer: peer, callback: cb})
  } else {
    this.socket.request(request, peer, cb)
  }
}

DHT.prototype._onrequest = function (request, peer) {
  if (validateId(request.id)) this._addNode(request.id, peer, request.roundtripToken)

  if (request.roundtripToken) {
    if (!request.roundtripToken.equals(this._token(peer, 0))) {
      if (!request.roundtripToken.equals(this._token(peer, 1))) {
        request.roundtripToken = null
      }
    }
  }

  if (request.forwardRequest) {
    this._forwardRequest(request, peer)
    return
  }

  if (request.forwardResponse) peer = this._forwardResponse(request, peer)

  switch (request.command) {
    case '_ping': return this._onping(request, peer)
    case '_find_node': return this._onfindnode(request, peer)
  }

  this._onquery(request, peer)
}

DHT.prototype._forwardResponse = function (request, peer) {
  if (request.command !== '_ping') return // only allow ping for now

  try {
    var from = peers.decode(request.forwardResponse)[0]
    if (!from) return
  } catch (err) {
    return
  }

  from.request = true
  from.tid = peer.tid

  return from
}

DHT.prototype._forwardRequest = function (request, peer) {
  if (request.command !== '_ping') return // only allow ping forwards right now

  try {
    var to = peers.decode(request.forwardRequest)[0]
    if (!to) return
  } catch (err) {
    return
  }

  this.emit('holepunch', peer, to)
  request.forwardRequest = null
  request.forwardResponse = encodePeer(peer)
  this.socket.forwardRequest(request, peer, to)
}

DHT.prototype._onquery = function (request, peer) {
  if (!validateId(request.target)) return

  var self = this
  var query = {
    node: {
      id: request.id,
      port: peer.port,
      host: peer.host
    },
    command: request.command,
    target: request.target,
    value: request.value,
    roundtripToken: request.roundtripToken
  }

  var method = request.roundtripToken ? 'update' : 'query'

  if (!this.emit(method + ':' + request.command, query, callback) && !this.emit(method, query, callback)) callback()

  function callback (err, value) {
    if (err) return

    var res = {
      id: self._queryId,
      value: value || null,
      nodes: nodes.encode(self.nodes.closest(request.target, 20)),
      roundtripToken: self._token(peer, 0)
    }

    self.socket.response(res, peer)
  }
}

DHT.prototype._onresponse = function (response, peer) {
  if (validateId(response.id)) this._addNode(response.id, peer, response.roundtripToken)

  while (this.socket.inflight < this.concurrency && this._pendingRequests.length) {
    var next = this._pendingRequests.shift()
    this.socket.request(next.request, next.peer, next.callback)
  }
}

DHT.prototype._onping = function (request, peer) {
  var res = {
    id: this._queryId,
    value: encodePeer(peer),
    roundtripToken: this._token(peer, 0)
  }

  this.socket.response(res, peer)
}

DHT.prototype._onfindnode = function (request, peer) {
  if (!validateId(request.target)) return

  var res = {
    id: this._queryId,
    nodes: nodes.encode(this.nodes.closest(request.target, 20)),
    roundtripToken: this._token(peer, 0)
  }

  this.socket.response(res, peer)
}

DHT.prototype._onnodeping = function (oldContacts, newContact) {
  if (!this._bootstrapped) return // bootstrapping, we've recently pinged all nodes

  var reping = []

  for (var i = 0; i < oldContacts.length; i++) {
    var old = oldContacts[i]

    if (this._tick - old.tick < 3) { // less than 10s since we talked to this peer ...
      this.nodes.add(oldContacts[i])
      continue
    }

    reping.push(old)
  }

  if (reping.length) this._reping(reping, newContact)
}

DHT.prototype._check = function (node) {
  var self = this
  this._request({command: '_ping', id: this._queryId}, node, false, function (err) {
    if (err) self._removeNode(node)
  })
}

DHT.prototype._reping = function (oldContacts, newContact) {
  var self = this
  var next = null

  ping()

  function ping () {
    next = oldContacts.shift()
    if (next) self._request({command: '_ping', id: self._queryId}, next, true, afterPing)
  }

  function afterPing (err) {
    if (!err) return ping()

    self._removeNode(next)
    self.nodes.add(newContact)
  }
}

DHT.prototype._token = function (peer, i) {
  return blake2b.batch([this._secrets[i], Buffer.from(peer.host)])
}

DHT.prototype._addNode = function (id, peer, token) {
  if (id.equals(this.id)) return

  var node = this.nodes.get(id)
  var fresh = !node

  if (!node) node = {}

  node.id = id
  node.port = peer.port
  node.host = peer.host
  node.roundtripToken = token
  node.tick = this._tick

  if (!fresh) remove(this, node)
  add(this, node)

  this.nodes.add(node)
  if (fresh) this.emit('add-node', node)
}

DHT.prototype._removeNode = function (node) {
  remove(this, node)
  this.nodes.remove(node.id)
  this.emit('remove-node', node)
}

DHT.prototype.listen = function (port, cb) {
  this.socket.listen(port, cb)
}

function encodePeer (peer) {
  return peer && peers.encode([peer])
}

function decodePeer (buf) {
  try {
    return buf && peers.decode(buf)[0]
  } catch (err) {
    return null
  }
}

function parseAddr (addr) {
  if (typeof addr === 'object' && addr) return addr
  if (typeof addr === 'number') return parseAddr(':' + addr)
  if (addr[0] === ':') return parseAddr('127.0.0.1' + addr)
  return {port: Number(addr.split(':')[1] || 3282), host: addr.split(':')[0]}
}

function validateId (id) {
  return id && id.length === 32
}

function arbiter (incumbant, candidate) {
  return candidate
}

function remove (self, node) {
  if (self._bottom !== node && self._top !== node) {
    node.prev.next = node.next
    node.next.prev = node.prev
    node.next = node.prev = null
  } else {
    if (self._bottom === node) {
      self._bottom = node.next
      if (self._bottom) self._bottom.prev = null
    }
    if (self._top === node) {
      self._top = node.prev
      if (self._top) self._top.next = null
    }
  }
}

function add (self, node) {
  if (!self._top && !self._bottom) {
    self._top = self._bottom = node
    node.prev = node.next = null
  } else {
    self._top.next = node
    node.prev = self._top
    node.next = null
    self._top = node
  }
}

function randomBytes (n) {
  var buf = Buffer.allocUnsafe(n)
  sodium.randombytes_buf(buf)
  return buf
}
