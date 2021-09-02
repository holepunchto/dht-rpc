const dns = require('dns')
const { EventEmitter } = require('events')
const Table = require('kademlia-routing-table')
const TOS = require('time-ordered-set')
const sodium = require('sodium-universal')
const c = require('compact-encoding')
const NatSampler = require('nat-sampler')
const IO = require('./lib/io')
const Query = require('./lib/query')
const peer = require('./lib/peer')
const { UNKNOWN_COMMAND, BAD_COMMAND, INVALID_TOKEN } = require('./lib/errors')

const TMP = Buffer.allocUnsafe(32)
const TICK_INTERVAL = 5000
const SLEEPING_INTERVAL = 3 * TICK_INTERVAL
const STABLE_TICKS = 240 // if nothing major bad happens in ~20mins we can consider this node stable (if nat is friendly)
const MORE_STABLE_TICKS = 3 * STABLE_TICKS
const REFRESH_TICKS = 60 // refresh every ~5min when idle
const RECENT_NODE = 12 // we've heard from a node less than 1min ago
const OLD_NODE = 360 // if an node has been around more than 30 min we consider it old

class DHT extends EventEmitter {
  constructor (opts = {}) {
    super()

    this.bootstrapNodes = opts.bootstrap === false ? [] : (opts.bootstrap || []).map(parseNode)
    this.table = new Table(opts.id || randomBytes(32))
    this.nodes = new TOS()
    this.io = new IO(this.table, {
      ...opts,
      onrequest: this._onrequest.bind(this),
      onresponse: this._onresponse.bind(this),
      ontimeout: this._ontimeout.bind(this)
    })

    this.concurrency = opts.concurrency || 10
    this.bootstrapped = false
    this.ephemeral = true
    this.firewalled = this.io.firewalled
    this.adaptive = typeof opts.ephemeral !== 'boolean' && opts.adaptive !== false

    this._nat = new NatSampler()
    this._bind = opts.bind || 0
    this._forcePersistent = opts.ephemeral === false
    this._repinging = 0
    this._checks = 0
    this._tick = randomOffset(100) // make sure to random offset all the network ticks
    this._refreshTicks = randomOffset(REFRESH_TICKS)
    this._stableTicks = this.adaptive ? STABLE_TICKS : 0
    this._tickInterval = setInterval(this._ontick.bind(this), TICK_INTERVAL)
    this._lastTick = Date.now()
    this._lastHost = null
    this._onrow = (row) => row.on('full', (node) => this._onfullrow(node, row))
    this._nonePersistentSamples = []
    this._bootstrapping = this.bootstrap()

    this.table.on('row', this._onrow)

    if (opts.nodes) {
      for (const node of opts.nodes) this.addNode(node)
    }
  }

  static bootstrapper (bind, opts) {
    return new this({ bind, firewalled: false, ...opts })
  }

  get id () {
    return this.ephemeral ? null : this.table.id
  }

  get host () {
    return this._nat.host
  }

  get port () {
    return this._nat.port
  }

  onmessage (buf, rinfo) {
    if (buf.byteLength > 1) this.io.onmessage(null, buf, rinfo)
  }

  bind () {
    return this.io.bind()
  }

  address () {
    const socket = this.firewalled ? this.io.clientSocket : this.io.serverSocket
    return socket ? socket.address() : null
  }

  addNode ({ host, port }) {
    this._addNode({
      id: peer.id(host, port),
      port,
      host,
      token: null,
      to: null,
      sampled: 0,
      added: this._tick,
      pinged: 0,
      seen: 0,
      downHints: 0,
      prev: null,
      next: null
    })
  }

  toArray () {
    return this.nodes.toArray().map(({ host, port }) => ({ host, port }))
  }

  ready () {
    return this._bootstrapping
  }

  query ({ target, command, value }, opts) {
    this._refreshTicks = REFRESH_TICKS
    return new Query(this, target, command, value || null, opts)
  }

  ping (to) {
    return this.request({ token: null, command: 'ping', target: null, value: null }, to)
  }

  request ({ token = null, command, target = null, value = null }, { host, port }, opts) {
    const req = this.io.createRequest({ id: null, host, port }, token, command, target, value)

    if (opts && opts.socket) req.socket = opts.socket

    return new Promise((resolve, reject) => {
      req.onresponse = resolve
      req.onerror = reject
      req.send()
    })
  }

  async bootstrap () {
    await Promise.resolve() // wait a tick, so apis can be used from the outside
    await this.io.bind()

    this.emit('listening')

    // TODO: some papers describe more advanced ways of bootstrapping - we should prob look into that

    for (let i = 0; i < 2; i++) {
      await this._backgroundQuery(this.table.id, 'find_node', null).finished()
      if (this.bootstrapped || !this._forcePersistent || !(await this._onstable())) break
    }

    if (this.bootstrapped) return
    this.bootstrapped = true

    this.emit('ready')
  }

  refresh () {
    const node = this.table.random()
    this._backgroundQuery(node ? node.id : this.table.id, 'find_node', null)
  }

  destroy () {
    clearInterval(this._tickInterval)
    return this.io.destroy()
  }

  _request (to, command, target, value, onresponse, onerror) {
    const req = this.io.createRequest(to, null, command, target, value)

    req.onresponse = onresponse
    req.onerror = onerror
    req.send()

    return req
  }

  _sampleBootstrapMaybe (from, to) { // we don't check that this is a bootstrap but good enough, some node once
    if (this._nonePersistentSamples.length >= this.bootstrapNodes.length) return
    const id = from.host + ':' + from.port
    if (this._nonePersistentSamples.indexOf(id) > -1) return
    this._nonePersistentSamples.push(id)
    this._nat.add(to.host, to.port)
  }

  _addNodeFromNetwork (sample, from, to) {
    if (from.id === null) {
      this._sampleBootstrapMaybe(from, to)
      return
    }

    const oldNode = this.table.get(from.id)

    // refresh it, if we've seen this before
    if (oldNode) {
      if (sample && (oldNode.sampled === 0 || (this._tick - oldNode.sampled) >= OLD_NODE)) {
        oldNode.to = to
        oldNode.sampled = this._tick
        this._nat.add(to.host, to.port)
      }

      oldNode.pinged = oldNode.seen = this._tick
      this.nodes.add(oldNode)
      return
    }

    this._addNode({
      id: from.id,
      port: from.port,
      host: from.host,
      to,
      sampled: 0,
      added: this._tick,
      pinged: this._tick, // last time we interacted with them
      seen: this._tick, // last time we heard from them
      downHints: 0,
      prev: null,
      next: null
    })
  }

  _addNode (node) {
    if (this.nodes.has(node) || node.id.equals(this.table.id)) return

    node.added = node.pinged = node.seen = this._tick

    if (!this.table.add(node)) return
    this.nodes.add(node)

    if (node.to && node.sampled === 0) {
      node.sampled = this._tick
      this._nat.add(node.to.host, node.to.port)
    }

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

  _onwakeup () {
    this._tick += 2 * OLD_NODE // bump the tick enough that everything appears old.
    this._tick += 8 - (this._tick & 7) - 2 // triggers a series of pings in two ticks
    this._stableTicks = MORE_STABLE_TICKS
    this._refreshTicks = 1 // triggers a refresh next tick (allow network time to wake up also)
    this._lastHost = null // clear network cache check

    if (this.adaptive && !this.ephemeral) {
      this.ephemeral = true
      this.io.ephemeral = true
      this.emit('ephemeral')
    }

    this.emit('wakeup')
  }

  _onfullrow (newNode, row) {
    if (!this.bootstrapped || this._repinging >= 3) return

    let oldest = null
    for (const node of row.nodes) {
      if (node.pinged === this._tick) continue
      if (oldest === null || oldest.pinged > node.pinged || (oldest.pinged === node.pinged && oldest.added > node.added)) oldest = node
    }

    if (oldest === null) return
    if ((this._tick - oldest.pinged) < RECENT_NODE && (this._tick - oldest.added) > OLD_NODE) return

    this._repingAndSwap(newNode, oldest)
  }

  _repingAndSwap (newNode, oldNode) {
    const self = this
    const lastSeen = oldNode.seen

    oldNode.pinged = this._tick

    this._repinging++
    this._request({ id: null, host: oldNode.host, port: oldNode.port }, 'ping', null, null, onsuccess, onswap)

    function onsuccess (m) {
      if (oldNode.seen <= lastSeen) return onswap()
      self._repinging--
    }

    function onswap (e) {
      self._repinging--
      self._removeNode(oldNode)
      self._addNode(newNode)
    }
  }

  _onrequest (req, external) {
    if (req.from.id !== null) {
      this._addNodeFromNetwork(!external, req.from, req.to)
    }

    // standard keep alive call
    if (req.command === 'ping') {
      req.sendReply(0, null, false, false)
      return
    }

    // check if the other side can receive a message to their other socket
    if (req.command === 'ping_nat') {
      if (req.value === null || req.value.byteLength < 2) return
      const port = c.uint16.decode({ start: 0, end: 2, buffer: req.value })
      if (port === 0) return
      req.from.port = port
      req.sendReply(0, null, false, false)
      return
    }

    // empty dht reply back
    if (req.command === 'find_node') {
      if (!req.target) return
      req.sendReply(0, null, false, true)
      return
    }

    if (req.command === 'down_hint') {
      if (req.value === null || req.value.byteLength < 6) return
      if (this._checks < 10) {
        sodium.crypto_generichash(TMP, req.value.subarray(0, 6))
        const node = this.table.get(TMP)
        if (node && (node.pinged < this._tick || node.downHints === 0)) {
          node.downHints++
          this._check(node)
        }
      }
      req.sendReply(0, null, false, false)
      return
    }

    // ask the user to handle it or reply back with a bad command
    if (this.onrequest(req) === false) {
      req.sendReply(UNKNOWN_COMMAND, null, false, true)
    }
  }

  onrequest (req) {
    return this.emit('request', req)
  }

  _onresponse (res, external) {
    this._addNodeFromNetwork(!external, res.from, res.to)
  }

  _ontimeout (req) {
    if (!req.to.id) return
    const node = this.table.get(req.to.id)
    if (node) this._removeNode(node)
  }

  _pingSome () {
    let cnt = this.io.inflight.length > 2 ? 3 : 5
    let oldest = this.nodes.oldest

    // tiny dht, pinged the bootstrap again
    if (!oldest) {
      this.refresh()
      return
    }

    // we've recently pinged the oldest one, so only trigger a couple of repings
    if ((this._tick - oldest.pinged) < RECENT_NODE) {
      cnt = 2
    }

    while (cnt--) {
      if (!oldest || this._tick === oldest.pinged) continue
      this._check(oldest)
      oldest = oldest.next
    }
  }

  _check (node) {
    node.pinged = this._tick

    const lastSeen = node.seen
    const onresponse = () => {
      this._checks--
      this._removeStaleNode(node, lastSeen)
    }
    const onerror = () => {
      this._checks--
      this._removeNode(node)
    }

    this._checks++
    this._request({ id: null, host: node.host, port: node.port }, 'ping', null, null, onresponse, onerror)
  }

  _ontick () {
    const time = Date.now()

    if (time - this._lastTick > SLEEPING_INTERVAL) {
      this._onwakeup()
    } else {
      this._tick++
    }

    this._lastTick = time

    if (!this.bootstrapped) return

    if (this.adaptive && this.ephemeral && --this._stableTicks <= 0) {
      if (this._lastHost === this._nat.host) { // do not recheck the same network...
        this._stableTicks = MORE_STABLE_TICKS
      } else {
        this._onstable() // the promise returned here never fails so just ignore it
      }
    }

    if ((this._tick & 7) === 0) {
      this._pingSome()
    }

    if (((this._tick & 63) === 0 && this.nodes.length < this.table.k) || --this._refreshTicks <= 0) {
      this.refresh()
    }
  }

  async _onstable () {
    if (!this.ephemeral) return false

    const { host, port } = this._nat

    // remember what host we checked and reset the counter
    this._stableTicks = MORE_STABLE_TICKS
    this._lastHost = host

    // check if we have a consistent host and port
    if (host === null || port === 0) {
      return false
    }

    // check if the external port is mapped to the internal port
    if (this._nat.port !== this.address().port) {
      return false
    }

    const natSampler = this.firewalled ? new NatSampler() : this._nat

    // ask remote nodes to ping us on our server socket to see if we have the port open
    const firewalled = this.firewalled && await this._checkIfFirewalled(natSampler)
    if (firewalled) return false

    this.firewalled = this.io.firewalled = false

    // incase it's called in parallel for some reason, or if our nat status somehow changed
    if (!this.ephemeral || host !== this._nat.host || port !== this._nat.port) return false
    // if the firewall probe returned a different host / non consistent port, bail as well
    if (natSampler.host !== host || natSampler.port === 0) return false

    const id = peer.id(natSampler.host, natSampler.port)

    this.ephemeral = this.io.ephemeral = false

    this._nonePersistentSamples = []
    this._nat = natSampler

    // all good! copy over the old routing table to the new one
    if (!this.table.id.equals(id)) {
      const nodes = this.table.toArray()

      this.table = this.io.table = new Table(id)

      for (const node of nodes) {
        if (node.id.equals(id)) continue
        if (!this.table.add(node)) this.nodes.remove(node)
      }

      this.table.on('row', this._onrow)

      // we need to rebootstrap/refresh since we updated our id
      if (this.bootstrapped) this.refresh()
    }

    this.emit('persistent')

    return true
  }

  _resolveBootstrapNodes (done) {
    if (!this.bootstrapNodes.length) return done([])

    let missing = this.bootstrapNodes.length
    const nodes = []

    for (const node of this.bootstrapNodes) {
      dns.lookup(node.host, { family: 4 }, (_, host) => {
        if (host) nodes.push({ id: peer.id(host, node.port), host, port: node.port })
        if (--missing === 0) done(nodes)
      })
    }
  }

  async _addBootstrapNodes (nodes) {
    return new Promise((resolve) => {
      this._resolveBootstrapNodes(function (bootstrappers) {
        nodes.push(...bootstrappers)
        resolve()
      })
    })
  }

  async _checkIfFirewalled (natSampler = new NatSampler()) {
    const nodes = []
    for (let node = this.nodes.latest; node && nodes.length < 5; node = node.prev) {
      nodes.push(node)
    }

    if (nodes.length < 5) await this._addBootstrapNodes(nodes)
    // if no nodes are available, including bootstrappers - bail
    if (nodes.length === 0) return true

    const hosts = []
    const value = Buffer.allocUnsafe(2)
    let pongs

    c.uint16.encode({ start: 0, end: 2, buffer: value }, this.io.serverSocket.address().port)

    // double check they actually came on the server socket...
    this.io.serverSocket.on('message', onmessage)

    pongs = await requestAll(this, 'ping_nat', value, nodes)
    if (!pongs.length) return true

    let count = 0
    for (const res of pongs) {
      if (hosts.indexOf(res.from.host) > -1) count++
    }

    this.io.serverSocket.removeListener('message', onmessage)

    // if we got very few replies, consider it a fluke
    if (count < (nodes.length >= 5 ? 3 : 1)) return true

    // check that the server socket has the same properties nat wise
    pongs = await requestAll(this, 'ping', null, nodes, { socket: this.io.serverSocket })
    for (const seen of pongs) natSampler.add(seen.to.host, seen.to.port)

    // check that the server socket has the same ip as the client socket
    if (natSampler.host === null || this._nat.host !== natSampler.host) return true

    // check that the local port of the server socket is the same as the remote port
    if (natSampler.port === 0 || natSampler.port !== this.io.serverSocket.address().port) return true

    return false

    function onmessage (_, rinfo) {
      hosts.push(rinfo.address)
    }
  }

  _backgroundQuery (target, command, value) {
    this._refreshTicks = REFRESH_TICKS

    const backgroundCon = Math.min(this.concurrency, Math.max(2, (this.concurrency / 8) | 0))
    const q = new Query(this, target, command, value, { concurrency: backgroundCon, maxSlow: 0 })

    q.on('data', () => {
      // yield to other traffic
      q.concurrency = this.io.inflight.length < 3
        ? this.concurrency
        : backgroundCon
    })

    return q
  }
}

DHT.ERROR_UNKNOWN_COMMAND = UNKNOWN_COMMAND
DHT.ERROR_INVALID_TOKEN = INVALID_TOKEN
DHT.ERROR_BAD_COMMAND = BAD_COMMAND

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

function randomOffset (n) {
  return n - ((Math.random() * 0.5 * n) | 0)
}

function requestAll (dht, command, value, nodes, opts) {
  let missing = nodes.length
  const replies = []

  return new Promise((resolve) => {
    for (const node of nodes) {
      dht.request({ token: null, command, target: null, value }, node, opts)
        .then(onsuccess, onerror)
    }

    function onsuccess (res) {
      replies.push(res)
      if (--missing === 0) resolve(replies)
    }

    function onerror () {
      if (--missing === 0) resolve(replies)
    }
  })
}
