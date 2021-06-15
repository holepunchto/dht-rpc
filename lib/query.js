const { Readable } = require('streamx')
const race = require('./race')
const nodeId = require('./id')

module.exports = class Query extends Readable {
  constructor (dht, target, command, value, opts = {}) {
    super()

    this.dht = dht
    this.k = this.dht.table.k
    this.target = target
    this.command = command
    this.value = value
    this.errors = 0
    this.successes = 0
    this.concurrency = opts.concurrency || this.dht.concurrency
    this.inflight = 0
    this.map = opts.map || defaultMap
    this.closestReplies = []

    this._slowdown = false
    this._seen = new Set()
    this._pending = []
    this._onresolve = this._onvisit.bind(this)
    this._onreject = this._onerror.bind(this)
    this._fromTable = false
    this._commit = opts.commit === true ? autoCommit : (opts.commit || null)
    this._commiting = false
    this._ropts = { socket: (opts && opts.socket) || this.dht.rpc.socket, expectOk: false }

    const nodes = opts.nodes || opts.closestNodes

    if (nodes) {
      // add them reverse as we pop below
      for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i]
        this._addPending(node.id || null, node.host, node.port)
      }
    }
  }

  get closestNodes () {
    const nodes = new Array(this.closestReplies.length)

    for (let i = 0; i < nodes.length; i++) {
      const c = this.closestReplies[i]

      nodes[i] = {
        id: c.id,
        host: c.from.host,
        port: c.from.port
      }
    }

    return nodes
  }

  finished () {
    return new Promise((resolve, reject) => {
      const self = this
      let error = null

      this.resume()
      this.on('error', onerror)
      this.on('close', onclose)

      function onclose () {
        self.removeListener('error', onerror)
        self.removeListener('close', onclose)
        if (error) reject(error)
        else resolve()
      }

      function onerror (err) {
        error = err
      }
    })
  }

  _addFromTable () {
    if (this._pending.length >= this.k) return
    this._fromTable = true

    const closest = this.dht.table.closest(this.target, this.k - this._pending.length)

    for (const node of closest) {
      this._addPending(node.id, node.host, node.port)
    }
  }

  _open (cb) {
    this._addFromTable()
    if (this._pending.length >= this.k) return cb(null)

    this.dht._resolveBootstrapNodes((bootstrapNodes) => {
      for (const node of bootstrapNodes) {
        this._addPending(node.id, node.host, node.port)
      }
      cb(null)
    })
  }

  _isCloser (id) {
    return this.closestReplies.length < this.k || this._compare(id, this.closestReplies[this.closestReplies.length - 1].id) < 0
  }

  _addPending (id, host, port) {
    if (id && !this._isCloser(id)) return false
    const addr = host + ':' + port
    if (this._seen.has(addr)) return true
    this._seen.add(addr)
    this._pending.push({ id, host, port })
    return true
  }

  _read (cb) {
    this._readMore()
    cb(null)
  }

  _readMore () {
    if (this.destroying) return

    const concurrency = this._slowdown ? 3 : this.concurrency

    while (this.inflight < concurrency && this._pending.length > 0) {
      const next = this._pending.pop()
      if (next && next.id && !this._isCloser(next.id)) continue
      this._visit(next)
    }

    // if reusing closest nodes, slow down after the first readMore tick to allow
    // the closest node a chance to reply before going broad to question more
    if (!this._fromTable && this.successes === 0 && this.errors === 0) {
      this._slowdown = true
    }

    if (this.inflight === 0 && this._pending.length === 0) {
      // if more than 3/4 failed and we only used cached nodes, try again from the routing table
      if (!this._fromTable && this.successes < this.k / 4) {
        this._addFromTable()
        return this._readMore()
      }

      this._flush()
    }
  }

  _flush () {
    if (this._commit === null) {
      this.push(null)
      return
    }

    if (!this.closestReplies.length) {
      this.destroy(new Error('Too few nodes responded'))
      return
    }

    if (this._commiting) return
    this._commiting = true

    const p = []
    for (const m of this.closestReplies) p.push(this._commit(m, this.dht, this))

    race(p, 1, p.length)
      .then(() => this.push(null), (err) => this.destroy(err))
  }

  _onvisit (m) {
    if (m.status === 0) this.successes++
    else this.errors++

    this.inflight--

    if (m.status === 0 && m.id !== null && this._isCloser(m.id)) {
      this._pushClosest(m)
    }

    if (m.closerNodes !== null) {
      for (const node of m.closerNodes) {
        const id = nodeId(node.host, node.port)
        if (id.equals(this.dht.table.id)) continue
        if (!this._addPending(id, node.host, node.port)) break
      }
    }

    if (!this._fromTable && this.successes + this.errors >= this.concurrency) {
      this._slowdown = false
    }

    if (m.status !== 0) {
      this._readMore()
      return
    }

    const data = this.map(m)
    if (!data || this.push(data) !== false) {
      this._readMore()
    }
  }

  _onerror () {
    this.errors++
    this.inflight--
    this._readMore()
  }

  _pushClosest (m) {
    this.closestReplies.push(m)
    for (let i = this.closestReplies.length - 2; i >= 0; i--) {
      const prev = this.closestReplies[i]
      const cmp = this._compare(prev.id, m.id)
      // if sorted, done!
      if (cmp < 0) break
      // if dup, splice it out (rare)
      if (cmp === 0) {
        this.closestReplies.splice(i + 1, 1)
        break
      }
      // swap and continue down
      this.closestReplies[i + 1] = prev
      this.closestReplies[i] = m
    }
    if (this.closestReplies.length > this.k) this.closestReplies.pop()
  }

  _compare (a, b) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue
      const t = this.target[i]
      return (t ^ a[i]) - (t ^ b[i])
    }
    return 0
  }

  _visit (node) {
    this.inflight++
    this.dht.request(this.target, this.command, this.value, node, this._ropts)
      .then(this._onresolve, this._onreject)
  }
}

function autoCommit (reply, dht, query) {
  if (!reply.token) return Promise.reject(new Error('No token received for closest node'))
  return dht.request(query.target, query.command, query.value, reply.from, { token: reply.token })
}

function defaultMap (m) {
  return m
}
