var stream = require('readable-stream')
var inherits = require('inherits')
var nodes = require('ipv4-peers').idLength(32)
var bufferEquals = require('buffer-equals')
var xor = require('xor-distance')

module.exports = QueryStream

function QueryStream (dht, query, opts) {
  if (!(this instanceof QueryStream)) return new QueryStream(dht, query, opts)
  if (!opts) opts = {}
  if (!opts.concurrency) opts.concurrency = opts.highWaterMark || dht.concurrency
  if (!query.target) throw new Error('query.target is required')

  stream.Readable.call(this, {objectMode: true, highWaterMark: opts.concurrency})

  var self = this
  var nodes = opts.node || opts.nodes

  this.query = query
  this.query.id = dht._queryId
  this.target = query.target
  this.token = !!opts.token
  this.holepunching = opts.holepunching !== false
  this.commits = 0
  this.responses = 0
  this.errors = 0
  this.destroyed = false
  this.verbose = !!opts.verbose

  dht.inflightQueries++

  this._dht = dht
  this._committing = false
  this._finalized = false
  this._closest = opts.closest || []
  this._concurrency = opts.concurrency
  this._updating = false
  this._pending = nodes ? [].concat(nodes).map(copyNode) : []
  this._k = nodes ? Infinity : opts.k || 20
  this._inflight = 0
  this._moveCloser = !nodes
  this._bootstrapped = !this._moveCloser
  this._onresponse = onresponse
  this._onresponseholepunch = onresponseholepunch

  function onresponseholepunch (err, res, peer, query) {
    if (!err || !peer || !peer.referrer) self._callback(err, res, peer)
    else self._holepunch(peer, query)
  }

  function onresponse (err, res, peer) {
    self._callback(err, res, peer)
  }
}

inherits(QueryStream, stream.Readable)

QueryStream.prototype.destroy = function (err) {
  if (this.destroyed) return
  this.destroyed = true
  this._finalize()
  if (err) this.emit('error', err)
  this.emit('close')
}

QueryStream.prototype._finalize = function () {
  if (this._finalized) return
  this._finalized = true
  this._dht.inflightQueries--
  if (!this.responses && !this.destroyed) this.destroy(new Error('No nodes responded'))
  if (!this.commits && this._committing && !this.destroyed) this.destroy(new Error('No close nodes responded'))
  this.push(null)
}

QueryStream.prototype._bootstrap = function () {
  this._bootstrapped = true

  var bootstrap = this._dht.nodes.closest(this.target, this._k)
  var i = 0

  for (i = 0; i < bootstrap.length; i++) {
    var b = bootstrap[i]
    this._addPending({id: b.id, port: b.port, host: b.host}, null)
  }

  if (bootstrap.length < this._dht.bootstrap.length) {
    for (i = 0; i < this._dht.bootstrap.length; i++) {
      this._send(this._dht.bootstrap[i], true, false)
    }
  }
}

QueryStream.prototype._readMaybe = function () {
  if (this._readableState.flowing === true) this._read()
}

QueryStream.prototype._sendTokens = function () {
  if (this.destroyed) return

  var sent = this._sendAll(this._closest, false, true)
  if (sent || this._inflight) return

  this._finalize()
}

QueryStream.prototype._sendPending = function () {
  if (this.destroyed) return
  if (!this._bootstrapped) this._bootstrap()

  var sent = this._sendAll(this._pending, false, false)
  if (sent || this._inflight) return

  if (this.token) {
    for (var i = 0; i < this._closest.length; i++) this._closest[i].queried = false
    this._committing = true
    this._sendTokens()
  } else {
    this._finalize()
  }
}

QueryStream.prototype._read = function () {
  if (this._committing) this._sendTokens()
  else this._sendPending()
}

QueryStream.prototype._holepunch = function (peer, query) {
  var self = this

  this._dht._holepunch(peer, peer.referrer, function (err) {
    if (err) return self._callback(err, null, peer)
    self._dht._request(query, peer, false, self._onresponse)
  })
}

QueryStream.prototype._callback = function (err, res, peer) {
  this._inflight--
  if (this.destroyed) return

  if (err) {
    this.errors++
    this.emit('warning', err)
    this._readMaybe()
    return
  }

  this.responses++
  if (this._committing) this.commits++
  this._addClosest(res, peer)

  if (this._moveCloser) {
    var candidates = decodeNodes(res.nodes)
    for (var i = 0; i < candidates.length; i++) this._addPending(candidates[i], peer)
  }

  if (!validateId(res.id) || (this.token && !this.verbose && !this._committing)) {
    this._readMaybe()
    return
  }

  this.push({
    node: {
      id: res.id,
      port: peer.port,
      host: peer.host
    },
    value: res.value
  })
}

QueryStream.prototype._sendAll = function (nodes, force, useToken) {
  var sent = 0
  var free = Math.max(0, this._concurrency - this._dht.socket.inflight)

  if (!free && !this._inflight) free = 1
  if (!free) return 0

  for (var i = 0; i < nodes.length; i++) {
    if (this._send(nodes[i], force, useToken)) {
      if (++sent === free) break
    }
  }

  return sent
}

QueryStream.prototype._send = function (node, force, useToken) {
  if (!force) {
    if (node.queried) return false
    node.queried = true
  }

  this._inflight++

  var query = this.query

  if (useToken && node.roundtripToken) {
    query = {
      command: this.query.command,
      id: this.query.id,
      target: this.query.target,
      value: this.query.value,
      roundtripToken: node.roundtripToken
    }
  }

  this._dht._request(query, node, false, this.holepunching ? this._onresponseholepunch : this._onresponse)
  return true
}

QueryStream.prototype._addPending = function (node, ref) {
  if (bufferEquals(node.id, this._dht.id)) return
  node.distance = xor(this.target, node.id)
  node.referrer = ref
  insertSorted(node, this._k, this._pending)
}

QueryStream.prototype._addClosest = function (res, peer) {
  if (!res.id || !res.roundtripToken || bufferEquals(res.id, this._dht.id)) return

  var prev = getNode(res.id, this._pending)

  if (!prev) {
    prev = {
      id: res.id,
      port: peer.port,
      host: peer.host,
      distance: xor(res.id, this.target)
    }
  }

  prev.roundtripToken = res.roundtripToken
  insertSorted(prev, this._k, this._closest)
}

function decodeNodes (buf) {
  if (!buf) return []
  try {
    return nodes.decode(buf)
  } catch (err) {
    return []
  }
}

function getNode (id, list) {
  // find id in the list.
  // technically this would be faster with binary search (against distance)
  // but this list is always small, so meh
  for (var i = 0; i < list.length; i++) {
    if (bufferEquals(list[i].id, id)) return list[i]
  }

  return null
}

function validateId (id) {
  return id && id.length === 32
}

function insertSorted (node, max, list) {
  if (list.length === max && !xor.lt(node.distance, list[max - 1].distance)) return
  if (getNode(node.id, list)) return

  if (list.length < max) list.push(node)
  else list[max - 1] = node

  var pos = list.length - 1
  while (pos && xor.gt(list[pos - 1].distance, node.distance)) {
    list[pos] = list[pos - 1]
    list[pos - 1] = node
    pos--
  }
}

function copyNode (node) {
  return {
    id: node.id,
    port: node.port,
    host: node.host,
    roundtripToken: node.roundtripToken,
    referrer: node.referrer
  }
}
