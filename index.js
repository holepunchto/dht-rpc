const dns = require('dns')
const RPC = require('./lib/rpc')
const Query = require('./lib/query')
const race = require('./lib/race')
const NatAnalyzer = require('./lib/nat-analyzer')
const Table = require('kademlia-routing-table')
const TOS = require('time-ordered-set')
const FIFO = require('fast-fifo/fixed-size')
const sodium = require('sodium-universal')
const { EventEmitter } = require('events')

const TICK_INTERVAL = 5000
const SLEEPING_INTERVAL = 3 * TICK_INTERVAL
const STABLE_TICKS = 240 // if nothing major bad happens in ~20mins we can consider this node stable (if nat is friendly)
const MORE_STABLE_TICKS = 3 * STABLE_TICKS
const REFRESH_TICKS = 60 // refresh every ~5min when idle
const RECENT_NODE = 20 // we've heard from a node less than 1min ago
const OLD_NODE = 360 // if an node has been around more than 30 min we consider it old

// this is the known id for figuring out if we should ping bootstrap nodes
const PING_BOOTSTRAP = Buffer.allocUnsafe(32)
sodium.crypto_generichash(PING_BOOTSTRAP, Buffer.from('ping bootstrap'))

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

  get commit () {
    return this.token !== null
  }

  error (code) {
    this.dht._reply(this.rpc, this.tid, this.target, code, null, false, this.from)
  }

  reply (value, token = true) {
    this.dht._reply(this.rpc, this.tid, this.target, 0, value, token, this.from)
  }
}

class DHT extends EventEmitter {
  constructor (opts = {}) {
    super()

    const id = opts.id || randomBytes(32)

    this.bootstrapNodes = opts.bootstrap === false ? [] : (opts.bootstrap || []).map(parseNode)
    this.nodes = new TOS()
    this.table = new Table(id)
    this.rpc = new RPC({
      socket: opts.socket,
      onwarning: opts.onwarning,
      onrequest: this._onrequest.bind(this),
      onresponse: this._onresponse.bind(this)
    })

    this.bootstrapped = false
    this.concurrency = opts.concurrency || 16
    this.ephemeral = !!opts.ephemeral
    this.adaptive = !!opts.adaptive

    this._repinging = 0
    this._reping = new FIFO(128)
    this._bootstrapping = this.bootstrap()
    this._secrets = [randomBytes(32), randomBytes(32)]
    // make sure to random offset all the network ticks
    this._tick = randomOffset(100)
    this._refreshTicks = randomOffset(REFRESH_TICKS)
    this._pingBootstrapTicks = randomOffset(REFRESH_TICKS)
    this._stableTicks = this.adaptive ? STABLE_TICKS : 0
    this._tickInterval = setInterval(this._ontick.bind(this), TICK_INTERVAL)
    this._rotateSecrets = false
    this._lastTick = Date.now()
    this._nat = new NatAnalyzer(opts.natSampleSize || 16)

    this.table.on('row', (row) => row.on('full', (node) => this._onfullrow(node, row)))
  }

  get id () {
    return this.table.id
  }

  static createRPCSocket (opts) {
    return new RPC(opts)
  }

  ready () {
    return this._bootstrapping
  }

  query (target, command, value, opts) {
    this._refreshTicks = REFRESH_TICKS
    return new Query(this, target, command, value || null, opts)
  }

  ping (node) {
    return this.request(null, 'ping', null, node)
  }

  request (target, command, value, to, opts) {
    return this.rpc.request({
      version: 1,
      tid: 0,
      from: null,
      to,
      token: to.token || null,
      nodeId: this.ephemeral ? null : this.table.id,
      target,
      closerNodes: null,
      command,
      status: 0,
      value
    }, opts)
  }

  requestAll (target, command, value, nodes, opts = {}) {
    if (nodes instanceof Table) nodes = nodes.closest(nodes.id)
    if (nodes instanceof Query) nodes = nodes.table.closest(nodes.table.id)

    const min = typeof opts.min === 'number' ? opts.min : 1
    if (nodes.length < min) return Promise.reject(new Error('Too few nodes to request'))

    const p = []
    for (const node of nodes) p.push(this.request(target, command, value, node))
    return race(p, min, opts.max)
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

  _pingSomeBootstrapNodes () {
    // once in a while it can be good to ping the bootstrap nodes, since we force them to be ephemeral to lower their load
    // to make this a lightweight as possible we first check if we are the closest node we know to a known id (hash(ping bootstrap))
    // and if so we issue a background query against that. if after doing this query we are still one of the closests nodes
    // we ping the bootstrapper - in practice this results to very little bootstrap ping traffic.

    this._pingBootstrapTicks = REFRESH_TICKS

    const nodes = this.table.closest(PING_BOOTSTRAP, 1)
    if (nodes.length === 0 || compare(PING_BOOTSTRAP, this.table.id, nodes[0].id) > 0) {
      return
    }

    const q = this._backgroundQuery(PING_BOOTSTRAP, 'find_node', null)

    q.on('close', () => {
      if (q.closest.length === 0) return

      if (compare(PING_BOOTSTRAP, this.table.id, q.closest[q.closest.length - 1].id) > 0) {
        return
      }

      this._resolveBootstrapNodes((nodes) => {
        const node = nodes[(Math.random() * nodes.length) | 0]
        this.ping(node).then(noop, noop)
      })
    })
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
    this.ping(node)
      .then(
        m => this._maybeRemoveNode(node, m.nodeId),
        () => this._removeNode(node)
      )
  }

  _token (peer, i) {
    this._rotateSecrets = true
    const out = Buffer.allocUnsafe(32)
    sodium.crypto_generichash(out, Buffer.from(peer.host), this._secrets[i])
    return out
  }

  _ontick () {
    if (this._rotateSecrets) {
      const tmp = this._secrets[0]
      this._secrets[0] = this._secrets[1]
      this._secrets[1] = tmp
      sodium.randombytes_buf(tmp)
    }

    const time = Date.now()

    if (time - this._lastTick > SLEEPING_INTERVAL) {
      this._onwakeup()
    } else {
      this._tick++
    }

    this._lastTick = time

    if (!this.bootstrapped) return

    if (this.adaptive && this.ephemeral && --this._stableTicks <= 0) {
      this._onstable()
    }

    if ((this._tick & 7) === 0) {
      this._pingSome()
    }

    if (!this.ephemeral && --this._pingBootstrapTicks <= 0) {
      this._pingSomeBootstrapNodes()
    }

    if (((this._tick & 63) === 0 && this.nodes.length < this.table.k) || --this._refreshTicks <= 0) {
      this.refresh()
    }
  }

  _onstable () {
    if (this.remoteAddress().type === NatAnalyzer.PORT_CONSISTENT) {
      this.emit('stable')
    } else {
      this._stableTicks = MORE_STABLE_TICKS
    }
  }

  _onwakeup () {
    this._tick += 2 * OLD_NODE // bump the tick enough that everything appears old.
    this._tick += 8 - (this._tick & 7) - 2 // triggers a series of pings in two ticks
    this._stableTicks = MORE_STABLE_TICKS
    this._pingBootstrapTicks = REFRESH_TICKS // forced ephemeral, so no need for a bootstrap ping soon
    this._refreshTicks = 1 // triggers a refresh next tick (allow network time to wake up also)

    if (this.adaptive) {
      this.ephemeral = true
      this.emit('unstable')
    }

    this.emit('wakeup')
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

    function onsuccess (m) {
      if (m.nodeId === null || !m.nodeId.equals(oldNode.id)) return onswap()
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

  _resolveBootstrapNodes (done) {
    if (!this.bootstrapNodes.length) return done([])

    let missing = this.bootstrapNodes.length
    const nodes = []

    for (const node of this.bootstrapNodes) {
      dns.lookup(node.host, (_, host) => {
        if (host) nodes.push({ id: node.id || null, host, port: node.port })
        if (--missing === 0) done(nodes)
      })
    }
  }

  _addNode (node) {
    if (this.nodes.has(node) || node.id.equals(this.table.id)) return

    node.added = node.seen = this._tick

    if (this.table.add(node)) this.nodes.add(node)

    this.emit('add-node', node)
  }

  _maybeRemoveNode (node, expectedId) {
    if (expectedId !== null && expectedId.equals(node.id)) return
    this._removeNode(node)
  }

  _removeNode (node) {
    if (!this.nodes.has(node)) return

    this.table.remove(node.id)
    this.nodes.remove(node)

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

    // add a sample of our address from the remote nodes pov
    this._nat.add(m.to)

    this._addNode({
      id: m.nodeId,
      token: null,
      port: m.from.port,
      host: m.from.host,
      added: this._tick,
      seen: this._tick,
      prev: null,
      next: null
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

    // empty dht reply back
    if (req.command === 'find_node') {
      this._reply(this.rpc, req.tid, req.target, 0, null, false, req.from)
      return
    }

    // if this node is ephemeral, it prob came from a bootstrapper somehow so no need to ping them
    if (req.nodeId === null) {
      this._pingBootstrapTicks = REFRESH_TICKS
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

  address () {
    return this.rpc.address()
  }

  remoteAddress () {
    return this._nat.analyze()
  }

  _reply (rpc, tid, target, status, value, token, to) {
    const closerNodes = target ? this.table.closest(target) : null
    const persistent = !this.ephemeral && rpc === this.rpc

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

DHT.OK = 0
DHT.UNKNOWN_COMMAND = 1
DHT.BAD_TOKEN = 2
DHT.NAT_UNKNOWN = NatAnalyzer.UNKNOWN
DHT.NAT_PORT_CONSISTENT = NatAnalyzer.PORT_CONSISTENT
DHT.NAT_PORT_INCREMENTING = NatAnalyzer.PORT_INCREMENTING
DHT.NAT_PORT_RANDOMIZED = NatAnalyzer.PORT_RANDOMIZED

module.exports = DHT

function parseNode (s) {
  if (typeof s === 'object') return s
  const [, id, host, port] = s.match(/([a-f0-9]{64}@)?([^:@]+)(:\d+)?$/i)
  if (!port) throw new Error('Node format is id@?host:port')

  return {
    id: id ? Buffer.from(id.slice(0, -1), 'hex') : null,
    host,
    port: Number(port.slice(1))
  }
}

function randomBytes (n) {
  const b = Buffer.alloc(n)
  sodium.randombytes_buf(b)
  return b
}

function noop () {}

function compare (id, a, b) {
  for (let i = 0; i < id.length; i++) {
    if (a[i] === b[i]) continue
    const t = id[i]
    return (t ^ a[i]) - (t ^ b[i])
  }
  return 0
}

function randomOffset (n) {
  return n - ((Math.random() * 0.5 * n) | 0)
}
