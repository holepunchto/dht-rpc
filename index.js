const dns = require('dns')
const RPC = require('./lib/rpc')
const Query = require('./lib/query')
const race = require('./lib/race')
const nodeId = require('./lib/id')
const NatAnalyzer = require('./lib/nat-analyzer')
const Table = require('kademlia-routing-table')
const TOS = require('time-ordered-set')
const FIFO = require('fast-fifo/fixed-size')
const sodium = require('sodium-universal')
const dgram = require('dgram')
const { EventEmitter } = require('events')

const TICK_INTERVAL = 5000
const SLEEPING_INTERVAL = 3 * TICK_INTERVAL
const PERSISTENT_TICKS = 240 // if nothing major bad happens in ~20mins we can consider this node stable (if nat is friendly)
const MORE_PERSISTENT_TICKS = 3 * PERSISTENT_TICKS
const REFRESH_TICKS = 60 // refresh every ~5min when idle
const RECENT_NODE = 20 // we've heard from a node less than 1min ago
const OLD_NODE = 360 // if an node has been around more than 30 min we consider it old

// this is the known id for figuring out if we should ping bootstrap nodes
const PING_BOOTSTRAP = Buffer.allocUnsafe(32)
sodium.crypto_generichash(PING_BOOTSTRAP, Buffer.from('ping bootstrap'))

class Request {
  constructor (dht, m) {
    this.dht = dht
    this.tid = m.tid
    this.from = m.from
    this.to = m.to
    this.token = m.token
    this.target = m.target
    this.closerNodes = m.closerNodes
    this.status = m.status
    this.command = m.command
    this.value = m.value
  }

  get commit () {
    return this.token !== null
  }

  error (code, token = false, socket) {
    return this.dht._reply(this.tid, this.target, code, null, this.from, token, socket)
  }

  reply (value, token = true, socket) {
    return this.dht._reply(this.tid, this.target, 0, value, this.from, token, socket)
  }
}

class DHT extends EventEmitter {
  constructor (opts = {}) {
    super()

    this.bootstrapNodes = opts.bootstrap === false ? [] : (opts.bootstrap || []).map(parseNode)
    this.nodes = new TOS()
    // this is just the private id, see below in the persistence handler
    this.table = new Table(opts.id || randomBytes(32))

    this.rpc = new RPC({
      maxWindow: opts.maxWindow,
      socket: opts.socket,
      onwarning: opts.onwarning || console.error,
      onrequest: this._onrequest.bind(this),
      onresponse: this._onresponse.bind(this)
    })

    this.bootstrapped = false
    this.concurrency = opts.concurrency || this.table.k
    this.ephemeral = true
    this.adaptive = opts.ephemeral !== false && opts.adaptive !== false
    this.clientOnly = !this.adaptive

    this._forcePersistent = opts.ephemeral === false
    this._repinging = 0
    this._reping = new FIFO(128)
    this._bootstrapping = this.bootstrap()
    this._localSocket = opts.localSocket || null // used for auto configuring nat sessions
    this._tick = randomOffset(100) // make sure to random offset all the network ticks
    this._refreshTicks = randomOffset(REFRESH_TICKS)
    this._pingBootstrapTicks = randomOffset(REFRESH_TICKS)
    this._persistentTicks = this.adaptive ? PERSISTENT_TICKS : 0
    this._tickInterval = setInterval(this._ontick.bind(this), TICK_INTERVAL)
    this._lastTick = Date.now()
    this._nat = new NatAnalyzer(opts.natSampleSize || 16)
    this._onrow = (row) => row.on('full', (node) => this._onfullrow(node, row))
    this._rotateSecrets = false
    this._secrets = [
      Buffer.alloc(32),
      Buffer.alloc(32)
    ]

    sodium.randombytes_buf(this._secrets[0])
    sodium.randombytes_buf(this._secrets[1])

    this.table.on('row', this._onrow)
  }

  get id () {
    return this.ephemeral ? null : this.table.id
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
      id: this.ephemeral ? null : this.table.id,
      token: to.token,
      target,
      closerNodes: null,
      command,
      status: 0,
      value
    }, opts)
  }

  requestAll (target, command, value, nodes, opts = {}) {
    const min = typeof opts.min === 'number' ? opts.min : 1
    if (nodes.length < min) return Promise.reject(new Error('Too few nodes to request'))

    const p = []
    for (const node of nodes) p.push(this.request(target, command, value, node))
    return race(p, min, opts.max)
  }

  // TODO: make this more smart - ie don't retry the first one etc etc
  async requestAny (target, command, value, nodes, opts) {
    for (const node of nodes) {
      try {
        return await this.request(target, command, value, node, opts)
      } catch {}
    }

    throw new Error('All requests failed')
  }

  destroy () {
    this.rpc.destroy()
    if (this._localSocket) {
      this._localSocket.close()
      this._localSocket = null
    }
    clearInterval(this._tickInterval)
  }

  async bootstrap () {
    for (let i = 0; i < 2; i++) {
      await this._backgroundQuery(this.table.id, 'find_node', null).finished()
      if (this.bootstrapped || !this._forcePersistent || !(await this._onpersistent())) break
    }

    if (this.bootstrapped) return
    this.bootstrapped = true
    this.emit('ready')
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

  _token (addr, i) {
    const token = Buffer.allocUnsafe(32)
    this._rotateSecrets = true
    // TODO: also add .port?
    sodium.crypto_generichash(token, Buffer.from(addr.host), this._secrets[i])
    return token
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
      this._check(oldest, oldest.seen)
      oldest = oldest.next
    }
  }

  _check (node, lastSeen) {
    this.ping(node)
      .then(
        () => this._removeStaleNode(node, lastSeen),
        () => this._removeNode(node)
      )
  }

  _ontick () {
    if (this._rotateSecrets) {
      const tmp = this._secrets[0]
      this._secrets[0] = this._secrets[1]
      this._secrets[1] = tmp
      sodium.crypto_generichash(tmp, tmp)
    }

    const time = Date.now()

    if (time - this._lastTick > SLEEPING_INTERVAL) {
      this._onwakeup()
    } else {
      this._tick++
    }

    this._lastTick = time

    if (!this.bootstrapped) return

    if (this.adaptive && this.ephemeral && --this._persistentTicks <= 0) {
      this._onpersistent() // the promise returned here never fails so just ignore it
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

  async _onpersistent () {
    if (this.ephemeral === false) return false

    // TODO: do nat check also

    const addr = this.remoteAddress(this._forcePersistent ? 1 : 3)

    if (addr.type !== DHT.NAT_PORT_CONSISTENT && addr.type !== DHT.NAT_OPEN) {
      this._persistentTicks = MORE_PERSISTENT_TICKS
      return false
    }

    if (await this._checkIfFirewalled()) return false
    if (!this.ephemeral) return false // incase it's called in parallel for some reason

    const id = nodeId(addr.host, addr.port)
    if (this.table.id.equals(id)) return false

    const nodes = this.table.toArray()

    this.table = new Table(id)
    for (const node of nodes) this.table.add(node)
    this.table.on('row', this._onrow)

    this.ephemeral = false
    this.emit('persistent')
    return true
  }

  async _addBootstrapNodes (nodes) {
    return new Promise((resolve) => {
      this._resolveBootstrapNodes(function (bootstrappers) {
        nodes.push(...bootstrappers)
        resolve()
      })
    })
  }

  async _checkIfFirewalled () {
    const nodes = []
    for (let node = this.nodes.latest; node && nodes.length < 5; node = node.prev) {
      nodes.push(node)
    }

    if (nodes.length < 5) await this._addBootstrapNodes(nodes)
    if (!nodes.length) return true // no nodes available, including bootstrappers - bail

    try {
      await this.requestAll(null, 'ping_nat', null, nodes, { min: nodes.length >= 5 ? 3 : 1, max: 3 })
    } catch {
      // not enough nat pings succeded - assume firewalled
      return true
    }

    return false
  }

  _onwakeup () {
    this._tick += 2 * OLD_NODE // bump the tick enough that everything appears old.
    this._tick += 8 - (this._tick & 7) - 2 // triggers a series of pings in two ticks
    this._persistentTicks = MORE_PERSISTENT_TICKS
    this._pingBootstrapTicks = REFRESH_TICKS // forced ephemeral, so no need for a bootstrap ping soon
    this._refreshTicks = 1 // triggers a refresh next tick (allow network time to wake up also)

    if (this.adaptive) {
      this.ephemeral = true
      this.emit('ephemeral')
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
    const lastSeen = oldNode.seen

    this._repinging++
    this.ping(oldNode).then(onsuccess, onswap)

    function onsuccess (m) {
      if (oldNode.seen <= lastSeen) return onswap()
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
        if (host) nodes.push({ id: nodeId(host, node.port), host, port: node.port })
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

  _removeStaleNode (node, lastSeen) {
    if (node.seen <= lastSeen) this._removeNode(node)
  }

  _removeNode (node) {
    if (!this.nodes.has(node)) return

    this.table.remove(node.id)
    this.nodes.remove(node)

    this.emit('remove-node', node)
  }

  _addNodeFromMessage (m) {
    const id = nodeId(m.from.host, m.from.port)

    // verify id, if the id is mismatched it doesn't strictly mean the node is bad, could be
    // a weird NAT thing, that the node is unaware of - in any case it def means we should not
    // add this node to our routing table
    if (!m.id.equals(id)) {
      m.id = null
      return
    }

    const oldNode = this.table.get(id)

    // TODO: if the to.host is different than what the node has told us previously
    // ALSO add it to the nat analyser as we have likely changed networks...
    // If we DO change the ip, it should factor into our adaptive logic as well potentially

    // refresh it, if we've seen this before
    if (oldNode) {
      oldNode.seen = this._tick
      this.nodes.add(oldNode)
      return
    }

    // add a sample of our address from the remote nodes pov
    this._nat.add(m.to)

    this._addNode({
      id,
      port: m.from.port,
      host: m.from.host,
      token: null, // adding this so it has the same "shape" as the query nodes for easier debugging
      added: this._tick,
      seen: this._tick,
      prev: null,
      next: null
    })
  }

  _onrequest (req) {
    // check if the roundtrip token is one we've generated within the last 10s for this peer
    if (req.token !== null && !this._token(req.from, 1).equals(req.token) && !this._token(req.from, 0).equals(req.token)) {
      req.token = null
    }

    if (req.id !== null) this._addNodeFromMessage(req)
    else this._pingBootstrapTicks = REFRESH_TICKS
    // o/ if this node is ephemeral, it prob originated from a bootstrapper somehow so no need to ping them

    // echo the value back
    if (req.command === 'ping') {
      this._reply(req.tid, null, 0, req.value, req.from, false)
      return
    }

    if (req.command === 'ping_nat') {
      if (!this._localSocket) this._localSocket = dgram.createSocket('udp4')
      this._reply(req.tid, null, 0, null, req.from, false, this._localSocket)
      return
    }

    // empty dht reply back
    if (req.command === 'find_node') {
      this._reply(req.tid, req.target, 0, null, req.from, false)
      return
    }

    if (this.emit('request', new Request(this, req)) === false) {
      this._reply(req.tid, req.target, 1, null, req.from, false)
    }
  }

  _onresponse (res) {
    if (res.id !== null) this._addNodeFromMessage(res)
    else if (this._nat.length < 3) this._nat.add(res.to)
  }

  bind (...args) {
    return this.rpc.bind(...args)
  }

  address () {
    return this.rpc.address()
  }

  remoteAddress (minSamples) {
    const result = this._nat.analyze(minSamples)
    if (result.type === NatAnalyzer.PORT_CONSISTENT && !this.ephemeral) result.type = DHT.NAT_OPEN
    return result
  }

  _reply (tid, target, status, value, to, addToken, socket = this.rpc.socket) {
    const closerNodes = target ? this.table.closest(target) : null
    const ephemeral = socket !== this.rpc.socket || this.ephemeral
    const reply = {
      version: 1,
      tid,
      from: null,
      to,
      id: ephemeral ? null : this.table.id,
      token: (!ephemeral && addToken) ? this._token(to, 1) : null,
      target: null,
      closerNodes,
      command: null,
      status,
      value
    }

    this.rpc.send(reply, socket)
    return reply
  }
}

DHT.OK = 0
DHT.UNKNOWN_COMMAND = 1
DHT.BAD_TOKEN = 2
DHT.NAT_UNKNOWN = NatAnalyzer.UNKNOWN
DHT.NAT_OPEN = Symbol.for('NAT_OPEN') // implies PORT_CONSISTENT
DHT.NAT_PORT_CONSISTENT = NatAnalyzer.PORT_CONSISTENT
DHT.NAT_PORT_INCREMENTING = NatAnalyzer.PORT_INCREMENTING
DHT.NAT_PORT_RANDOMIZED = NatAnalyzer.PORT_RANDOMIZED

module.exports = DHT

function parseNode (s) {
  if (typeof s === 'object') return s
  const [host, port] = s.split(':')
  if (!port) throw new Error('Bootstrap node format is host:port')

  return {
    host,
    port: Number(port)
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
