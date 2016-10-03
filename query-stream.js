var stream = require('readable-stream')
var inherits = require('inherits')
var KBucket = require('k-bucket')
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

  this.request = query
  this.request.id = dht.id
  this.target = this.request.target
  this.destroyed = false
  this.responses = 0
  this.errors = 0
  this.closest = []

  this._post = opts.post
  this._dht = dht
  this._bootstrapped = false
  this._concurrency = opts.concurrency
  this._inflight = 0
  this._k = 20
  this._onresponse = onresponse
  this._pending = []

  function onresponse (err, response, peer) {
    self._update(err, response, peer)
  }
}

inherits(QueryStream, stream.Readable)

QueryStream.prototype.destroy = function (err) {
  if (this.destroyed) return
  this.destroyed = true
  this.push(null)
  if (err) this.emit('error', err)
  this.emit('close')
}

QueryStream.prototype._bootstrap = function () {
  this._bootstrapped = true

  var bootstrap = this._dht.nodes.closest(this.target, this._k)

  for (var i = 0; i < bootstrap.length; i++) {
    var b = bootstrap[i]
    this._addPending({id: b.id, port: b.port, host: b.host})
  }

  if (bootstrap.length < this._dht.bootstrap.length) {
    for (var i = 0; i < this._dht.bootstrap.length; i++) {
      this._send(this._dht.bootstrap[i], true)
    }
  }
}

QueryStream.prototype._update = function (err, res, peer) {
  this._inflight--
  if (this.destroyed) return

  if (err) {
    this.errors++
    this.emit('warning', err)
    if (this._readableState.flowing === true) this._read()
    return
  }

  this.responses++
  this._addClosest(res, peer)

  var candidates = decodeNodes(res.nodes)
  for (var i = 0; i < candidates.length; i++) this._addPending(candidates[i])

  this.push({
    node: {
      id: res.id,
      port: peer.port,
      host: peer.host
    },
    value: res.value
  })
}

QueryStream.prototype._read = function () {
  if (this.destroyed) return
  if (!this._bootstrapped) this._bootstrap()

  var free = Math.max(0, this._concurrency - this._dht.socket.inflight)
  if (!free && !this._inflight) free = 1
  var missing = free

  for (var i = 0; missing && i < this._pending.length; i++) {
    if (this._pending[i].queried) continue
    missing--
    this._send(this._pending[i], false)
  }

  if (!this._inflight && free) {
    this.push(null)
  }
}

QueryStream.prototype._send = function (node, bootstrap) {
  if (!bootstrap) {
    if (node.queried) return
    node.queried = true
  }
  this._inflight++
  this._dht._request(this.request, node, false, this._onresponse)
}

QueryStream.prototype._addPending = function (node) {
  if (bufferEquals(node.id, this._dht.id)) return
  node.distance = xor(this.target, node.id)
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
  insertSorted(prev, this._k, this.closest)
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
