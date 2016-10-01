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

  this._dht = dht
  this._bootstrapped = false
  this._concurrency = opts.concurrency
  this._inflight = 0
  this._k = 20
  this._onresponse = onresponse
  this.closest = []

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
    this._add(bootstrap[i])
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
  } else {
    this.responses++

    if (res.id) {
      var prev = this._get(res.id)
      if (prev) prev.roundtripToken = res.roundtripToken
    }

    // TODO: do not add nodes to table.
    // instead merge-sort with table so we only add nodes that actually respond
    var n = decodeNodes(res.nodes)

    for (var i = 0; i < n.length; i++) {
      if (!bufferEquals(n[i].id, this._dht.id)) this._add(n[i])
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
}

QueryStream.prototype._read = function () {
  if (this.destroyed) return
  if (!this._bootstrapped) this._bootstrap()

  var free = Math.max(0, this._concurrency - this._dht.socket.inflight)
  if (!free && !this._inflight) free = 1
  var missing = free

  for (var i = 0; missing && i < this.closest.length; i++) {
    if (this.closest[i].queried) continue
    missing--
    this._send(this.closest[i], false)
  }

  if (!this._inflight && free) {
    this.push(null)
  }
}

QueryStream.prototype._send = function (node, bootstrap) {
  if (!bootstrap && node.queried) return
  if (!bootstrap) node.queried = true
  this._inflight++
  this._dht._request(this.request, node, false, this._onresponse)
}

QueryStream.prototype._get = function (id) {
  for (var i = 0; i < this.closest.length; i++) {
    if (bufferEquals(this.closest[i].id, id)) return this.closest[i]
  }
  return null
}

QueryStream.prototype._add = function (node) {
  if (this._get(node.id)) return

  node.distance = xor(this.target, node.id)
  node.queried = false

  if (this.closest.length < this._k) {
    this.closest.push(node)
    return
  }

  if (!xor.gt(this.closest[this._k - 1].distance, node.distance)) return

  this.closest[this._k - 1] = node

  var pos = this._k - 1
  while (pos && xor.gt(this.closest[pos - 1].distance, node.distance)) {
    this.closest[pos] = this.closest[pos - 1]
    this.closest[pos - 1] = node
    pos--
  }
}

function decodeNodes (buf) {
  if (!buf) return []
  try {
    return nodes.decode(buf)
  } catch (err) {
    return []
  }
}
