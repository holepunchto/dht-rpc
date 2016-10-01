var udp = require('udp-request')
var crypto = require('crypto')
var KBucket = require('k-bucket')
var inherits = require('inherits')
var events = require('events')
var peers = require('ipv4-peers')
var bufferEquals = require('buffer-equals')
var nodes = peers.idLength(32)
var messages = require('./messages')

module.exports = DHT

function DHT (opts) {
  if (!(this instanceof DHT)) return new DHT(opts)
  if (!opts) opts = {}

  events.EventEmitter.call(this)

  var self = this

  this.concurrency = opts.concurrency || 16
  this.bootstrap = [].concat(opts.bootstrap || []).map(parseAddr)
  this.id = opts.id || crypto.randomBytes(32)
  this.nodes = new KBucket({localNodeId: this.id})
  this.nodes.on('ping', onnodeping)

  this.socket = udp({
    requestEncoding: messages.Request,
    responseEncoding: messages.Response
  })

  this.socket.on('request', onrequest)
  this.socket.on('response', onresponse)
  this.socket.on('close', onclose)

  this._bootstrapped = false
  this._pendingRequests = []
  this._secrets = [crypto.randomBytes(32), crypto.randomBytes(32)]
  this._interval = setInterval(rotateSecrets, 5 * 60 * 1000)

  process.nextTick(function () {
    self._bootstrap()
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
}

inherits(DHT, events.EventEmitter)

DHT.prototype.ping = function (peer, cb) {
  this._ping(parseAddr(peer), function (err, res, peer) {
    if (err) return cb(err)
    var rinfo = decodePeer(res.value)
    if (!rinfo) return cb(new Error('Invalid pong'))
    cb(null, rinfo, {port: peer.port, host: peer.host, id: res.id})
  })
}

DHT.prototype.destroy = function () {
  this.socket.destroy()
}

DHT.prototype._rotateSecrets = function () {
  var secret = crypto.randomBytes(32)
  this._secrets[1] = this._secrets[0]
  this._secrets[0] = secret
}

DHT.prototype._bootstrap = function () {
  // TODO: run in the background
  // TODO: check stats, to determine wheather to rerun?

  var self = this
  this._closest({command: '_find_node', target: this.id, id: this.id}, null, function (err) {
    if (err) return self.emit('error', err)
    self._bootstrapped = true
    self.emit('ready')
  })
}

DHT.prototype._closest = function (request, onresponse, cb) {
  if (!cb) cb = noop

  var self = this
  var target = request.target
  var stats = {responses: 0, errors: 0}
  // var table = new KBucket({localNodeId: target})
  var table = require('./table')(target)
  var requested = {}
  var inflight = 0

  var bootstrap = this.nodes.closest(target, 20)
  if (bootstrap.length < this.bootstrap.length) bootstrap.push.apply(bootstrap, this.bootstrap)

  bootstrap.forEach(send)
  if (!inflight) cb(null, stats, table)

  function send (peer) {
    var addr = peer.host + ':' + peer.port

    if (requested[addr]) return
    requested[addr] = true

    inflight++
    self._request(request, peer, false, next)
  }

  function next (err, res, peer) {
    inflight--

    if (err) {
      stats.errors++
    } else {
      stats.responses++

      if (res.id) {
        // var prev = table.get(res.id)
        // if (prev) prev.roundtripToken = res.roundtripToken
      }

      // TODO: do not add nodes to table.
      // instead merge-sort with table so we only add nodes that actually respond
      var n = decodeNodes(res.nodes)
      for (var i = 0; i < n.length; i++) {
        if (!bufferEquals(n[i].id, self.id)) table.add(n[i])
      }

      if (onresponse) onresponse(res, peer)
    }

    table.closest(20).forEach(send)
    if (!inflight) {
      cb(null, stats, table)
    }
  }
}

DHT.prototype._ping = function (peer, cb) {
  this._request({command: '_ping', id: this.id}, peer, false, cb)
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

  var forwardRequest = decodePeer(request.forwardRequest)
  if (forwardRequest) { // TODO: security stuff
    console.error('TODO: [forward request]', forwardRequest)
  }

  var forwardResponse = decodePeer(request.forwardResponse)
  if (forwardResponse) {
    console.error('TODO: [forward response]', forwardResponse)
  }

  if (request.roundtripToken) {
    if (!bufferEquals(request.roundtripToken, this._token(peer, 0))) {
      if (!bufferEquals(request.roundtripToken, this._token(peer, 1))) {
        request.roundtripToken = null
      }
    }
  }

  switch (request.command) {
    case '_ping': return this._onping(request, peer)
    case '_find_node': return this._onfindnode(request, peer)
  }

  this._onquery(request, peer)
}

DHT.prototype._onquery = function (request, peer) {
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

  if (!this.emit('query', query, callback)) callback()

  function callback (err, value) {
    // TODO: support errors?

    var res = {
      id: self.id,
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
    id: this.id,
    value: peers.encode([peer]),
    roundtripToken: this._token(peer, 0)
  }

  this.socket.response(res, peer)
}

DHT.prototype._onfindnode = function (request, peer) {
  if (!validateId(request.target)) return

  var res = {
    id: this.id,
    nodes: nodes.encode(this.nodes.closest(request.target, 20)),
    roundtripToken: this._token(peer, 0)
  }

  this.socket.response(res, peer)
}

DHT.prototype._onnodeping = function (oldContacts, newContact) {
  if (!this._bootstrapped) return // bootstrapping, we've recently pinged all nodes
  // TODO: record if we've recently pinged oldContacts, no need to flood them with new pings then
  // console.log('onnodeping', this.bootstrap.length, this._bootstrapped, oldContacts.length)
  for (var i = 0; i < oldContacts.length; i++) {
    this.nodes.add(oldContacts[i])
  }
}

DHT.prototype._token = function (peer, i) {
  return crypto.createHash('sha256').update(this._secrets[i]).update(peer.host).digest()
}

DHT.prototype._addNode = function (id, peer, token) {
  if (bufferEquals(id, this.id)) return
  this.nodes.add({id: id, roundtripToken: token, port: peer.port, host: peer.host})
}

DHT.prototype.listen = function (port, cb) {
  this.socket.listen(port, cb)
}

function noop () {}

function decodeNodes (buf) {
  if (!buf) return []
  try {
    return nodes.decode(buf)
  } catch (err) {
    return []
  }
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
  if (typeof addr === 'number') return parseAddr(':' + addr)
  if (addr[0] === ':') return parseAddr('127.0.0.1' + addr)
  return {port: Number(addr.split(':')[1] || 3282), host: addr.split(':')[0]}
}

function validateId (id) {
  return id && id.length === 32
}
