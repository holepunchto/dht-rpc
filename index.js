const dns = require('dns')
const RPC = require('./lib/rpc')
const createKeyPair = require('./lib/key-pair')
const Query = require('./lib/query')
const Table = require('kademlia-routing-table')
const TOS = require('time-ordered-set')
const FIFO = require('fast-fifo/fixed-size')
const sodium = require('sodium-universal')
const { EventEmitter } = require('events')

const TICK_INTERVAL = 5000
const REFRESH_TICKS = 60 // refresh every ~5min when idle
const RECENT_NODE = 20 // we've heard from a node less than 1min ago
const OLD_NODE = 360 // if an node has been around more than 30 min we consider it old...

class Request {
  constructor (dht, m) {
    this.rpc = dht.rpc
    this.dht = dht
    this.tid = m.tid
    this.from = m.from
    this.to = m.to
    this.nodeId = m.nodeId
    this.target = m.target
    this.closerNodes = m.closerNodes
    this.status = m.status
    this.token = m.token
    this.command = m.command
    this.value = m.value
  }

  error (code) {
    this.dht._reply(this.rpc, this.tid, this.target, code, null, false, this.from)
  }

  reply (value, token = false) {
    this.dht._reply(this.rpc, this.tid, this.target, 0, value, token, this.from)
  }
}

module.exports = class DHT extends EventEmitter {
  constructor (opts = {}) {
    super()

    this.bootstrapNodes = (opts.bootstrapNodes || []).map(parseNode)
    this.keyPair = opts.keyPair || createKeyPair(opts.seed)
    this.nodes = new TOS()
    this.table = new Table(this.keyPair.publicKey)
    this.rpc = new RPC({
      socket: opts.socket,
      onwarning: opts.onwarning,
      onrequest: this._onrequest.bind(this),
      onresponse: this._onresponse.bind(this)
    })

    this.bootstrapped = false
    this.concurrency = opts.concurrency || 16
    this.persistent = opts.ephemeral ? false : true

    this._repinging = 0
    this._reping = new FIFO(128)
    this._bootstrapping = this.bootstrap()
    this._secrets = [randomBytes(32), randomBytes(32)]
    this._tick = (Math.random() * 1024) | 0 // random offset it
    this._refreshTick = REFRESH_TICKS
    this._tickInterval = setInterval(this._ontick.bind(this), TICK_INTERVAL)

    this.table.on('row', (row) => row.on('full', (node) => this._onfullrow(node, row)))
  }

  static OK = 0
  static UNKNOWN_COMMAND = 1
  static BAD_TOKEN = 2

  static createRPCSocket (opts) {
    return new RPC(opts)
  }

  static keyPair (seed) {
    return createKeyPair(seed)
  }

  ready () {
    return this._bootstrapping
  }

  query (target, command, value, opts) {
    this._refreshTick = this._tick + REFRESH_TICKS
    return new Query(this, target, command, value, opts)
  }

  ping (node) {
    return this.request(null, 'ping', null, node)
  }

  request (target, command, value, to) {
    return this.rpc.request({
      version: 1,
      tid: 0,
      from: null,
      to,
      token: to.token || null,
      nodeId: this.persistent ? this.table.id : null,
      target,
      closerNodes: null,
      command,
      status: 0,
      value
    })
  }

  requestAll (target, command, value, nodes, opts = {}) {
    if (nodes instanceof Table) nodes = nodes.closest(nodes.id)
    if (nodes instanceof Query) nodes = nodes.table.closest(nodes.table.id)
    if (nodes.length === 0) return Promise.resolve([])

    const p = []
    for (const node of nodes) p.push(this.request(target, command, value, node))

    let errors = 0
    const results = []
    const min = typeof opts.min === 'number' ? opts.min : 1
    const max = typeof opts.max === 'number' ? opts.max : p.length

    return new Promise((resolve, reject) => {
      for (let i = 0; i < p.length; i++) p[i].then(ondone, onerror)

      function ondone (res) {
        if (results.length < max) results.push(res)
        if (results.length >= max) return resolve(results)
        if (results.length + errors === p.length) return resolve(results)
      }

      function onerror (err) {
        if ((p.length - ++errors) < min) reject(new Error('Too many requests failed'))
      }
    })
  }

  destroy () {
    this.rpc.destroy()
    clearInterval(this._tickInterval)
  }

  async bootstrap () {
    return new Promise((resolve) => {
      this._backgroundQuery(this.table.id, 'find_node', null)
        .on('close', () => {
          if (!this.bootstrapped) {
            this.bootstrapped = true
            this.emit('ready')
          }
          resolve()
        })
    })
  }

  _backgroundQuery (target, command, value) {
    const backgroundCon = Math.min(this.concurrency, Math.max(2, (this.concurrency / 8) | 0))
    const q = this.query(target, command, value, {
      concurrency: backgroundCon
    })

    q.on('data', () => {
      // yield to other traffic
      q.concurrency = this.rpc.inflightRequests < 3
        ? this.concurrency
        : backgroundCon
    })

    return q
  }

  refresh () {
    const node = this.table.random()
    this._backgroundQuery(node ? node.id : this.table.id, 'find_node', null)
  }

  _pingSome () {
    let cnt = this.rpc.inflightRequests > 2 ? 3 : 5
    let oldest = this.nodes.oldest

    // tiny dht, ping the bootstrap again
    if (!oldest) {
      this.refresh()
      return
    }

    // we've recently pinged the oldest one, so only trigger a couple of repings
    if ((this._tick - oldest.seen) < RECENT_NODE) {
      cnt = 2
    }

    while (cnt--) {
      if (!oldest || this._tick === oldest.seen) continue
      this._check(oldest)
      oldest = oldest.next
    }
  }

  _check (node) {
    this.ping(node).catch(() => this._removeNode(node))
  }

  _token (peer, i) {
    const out = Buffer.allocUnsafe(32)
    sodium.crypto_generichash(out, Buffer.from(peer.host), this._secrets[i])
    return out
  }

  _ontick () {
    // rotate secrets
    const tmp = this._secrets[0]
    this._secrets[0] = this._secrets[1]
    this._secrets[1] = tmp
    sodium.randombytes_buf(tmp)

    if (!this.bootstrapped) return
    this._tick++
    if ((this._tick & 7) === 0) this._pingSome()
    if (((this._tick & 63) === 0 && this.nodes.length < 20) || this._tick === this._refreshTick) this.refresh()
  }

  _onfullrow (newNode, row) {
    if (this.bootstrapped && this._reping.push({ newNode, row })) this._repingMaybe()
  }

  _repingMaybe () {
    while (this._repinging < 3 && this._reping.isEmpty() === false) {
      const { newNode, row } = this._reping.shift()
      if (this.table.get(newNode.id)) continue

      let oldest = null
      for (const node of row.nodes) {
        if (node.seen === this._tick) continue
        if (oldest === null || oldest.seen > node.seen || (oldest.seen === node.seen && oldest.added > node.added)) oldest = node
      }

      if (oldest === null) continue
      if ((this._tick - oldest.seen) < RECENT_NODE && (this._tick - oldest.added) > OLD_NODE) continue

      this._repingAndSwap(newNode, oldest)
    }
  }

  _repingAndSwap (newNode, oldNode) {
    const self = this

    this._repinging++
    this.ping(oldNode).then(onsuccess, onswap)

    function onsuccess () {
      self._repinging--
      self._repingMaybe()
    }

    function onswap () {
      self._repinging--
      self._repingMaybe()
      self._removeNode(oldNode)
      self._addNode(newNode)
    }
  }

  _resolveBootstrapNodes (cb) {
    if (!this.bootstrapNodes.length) return cb([])

    let missing = this.bootstrapNodes.length
    const nodes = []

    for (const node of this.bootstrapNodes) {
      dns.lookup(node.host, (_, host) => {
        if (host) nodes.push({ id: node.id || null, host, port: node.port })
        if (--missing === 0) cb(nodes)
      })
    }
  }

  _addNode (node) {
    if (this.nodes.has(node)) return

    node.added = node.seen = this._tick

    this.nodes.add(node)
    this.table.add(node)

    this.emit('add-node', node)
  }

  _removeNode (node) {
    if (!this.nodes.has(node)) return

    this.nodes.remove(node)
    this.table.remove(node.id)

    this.emit('remove-node', node)
  }

  _addNodeFromMessage (m) {
    const oldNode = this.table.get(m.nodeId)

    if (oldNode) {
      if (oldNode.port === m.from.port && oldNode.host === m.from.host) {
        // refresh it
        oldNode.seen = this._tick
        this.nodes.add(oldNode)
      }
      return
    }

    this._addNode({
      id: m.nodeId,
      port: m.from.port,
      host: m.from.host,
      token: null,
      added: this._tick,
      seen: this._tick,
      prev: null,
      next: null,
    })
  }

  _onrequest (req) {
    if (req.nodeId !== null) this._addNodeFromMessage(req)

    if (req.token !== null) {
      if (!req.token.equals(this._token(req.from, 1)) && !req.token.equals(this._token(req.from, 0))) {
        req.token = null
      }
    }

    // empty reply back
    if (req.command === 'ping') {
      this._reply(this.rpc, req.tid, null, 0, null, false, req.from)
      return
    }

    if (req.command === 'find_node') {
      this._reply(this.rpc, req.tid, req.target, 0, null, false, req.from)
      return
    }

    if (this.emit('request', new Request(this, req)) === false) {
      this._reply(this.rpc, req.tid, req.target, 1, null, false, req.from)
    }
  }

  _onresponse (res) {
    if (res.nodeId !== null) this._addNodeFromMessage(res)
  }

  bind (...args) {
    return this.rpc.bind(...args)
  }

  _reply (rpc, tid, target, status, value, token, to) {
    const closerNodes = target ? this.table.closest(target) : null
    const persistent = this.persistent && rpc === this.rpc

    rpc.send({
      version: 1,
      tid,
      from: null,
      to,
      token: token ? this._token(to, 1) : null,
      nodeId: persistent ? this.table.id : null,
      target: null,
      closerNodes,
      command: null,
      status,
      value
    })
  }
}

function parseNode (s) {
  if (typeof s === 'object') return s
  const [_, id, host, port] = s.match(/([a-f0-9]{64}@)?([^:@]+)(:\d+)?$/i)
  if (!port) throw new Error('Node format is id@?host:port')

  return {
    id: id ? Buffer.from(id.slice(0, -1), 'hex') : null,
    host,
    port
  }
}

function randomBytes (n) {
  const b = Buffer.alloc(n)
  sodium.randombytes_buf(b)
  return b
}

function noop () {}
