const { Readable } = require('streamx')

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
    this.concurrency = opts.concurrency || this.k
    this.inflight = 0
    this.map = opts.map || defaultMap
    this.closest = []

    this._slowdown = false
    this._seen = new Set()
    this._pending = []
    this._onresolve = this._onvisit.bind(this)
    this._onreject = this._onerror.bind(this)
    this._fromTable = false

    const nodes = opts.nodes || opts.closest

    if (nodes) {
      // add them reverse as we pop below
      for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i]
        this._addPending(node.id, node.host, node.port)
      }
    }
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

  async commit (command = this.command, value = this.value, opts) {
    if (typeof command === 'object' && command) return this.commit(undefined, undefined, command)
    return this.dht.requestAll(this.target, command, value, this.closest, opts)
  }

  async toArray () {
    const all = []
    this.on('data', data => all.push(data))
    await this.finished()
    return all
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
    return this.closest.length < this.k || this._compare(id, this.closest[this.closest.length - 1].id) < 0
  }

  _addPending (id, host, port) {
    if (id && !this._isCloser(id)) return
    const addr = host + ':' + port
    if (this._seen.has(addr)) return
    this._seen.add(addr)
    this._pending.push({ id, host, port })
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
    // the closests node a chance to reply before going broad to question more
    if (!this._fromTable && this.successes === 0 && this.errors === 0) {
      this._slowdown = true
    }

    if (this.inflight === 0 && this._pending.length === 0) {
      // if more than 3/4 failed and we only used cached nodes, try again from the routing table
      if (!this._fromTable && this.successes < this.k / 4) {
        this._addFromTable()
        return this._readMore()
      }

      this.push(null)
    }
  }

  _onvisit (m) {
    if (m.status === 0) this.successes++
    else this.errors++

    this.inflight--

    if (m.nodeId !== null && this._isCloser(m.nodeId)) {
      const node = {
        id: m.nodeId,
        token: m.token,
        port: m.from.port,
        host: m.from.host
      }

      this._pushClosest(node)
    }

    if (m.closerNodes !== null) {
      for (const node of m.closerNodes) {
        if (node.id.equals(this.dht.table.id)) continue
        this._addPending(node.id, node.host, node.port)
      }
    }

    if (!this._fromTable && this.successes + this.errors >= this.concurrency) {
      this._slowdown = false
    }

    if (m.status !== 0 || this.push(this.map(m)) !== false) this._readMore()
  }

  _onerror () {
    this.errors++
    this.inflight--
    this._readMore()
  }

  _pushClosest (node) {
    this.closest.push(node)
    for (let i = this.closest.length - 2; i >= 0; i--) {
      const prev = this.closest[i]
      const cmp = this._compare(prev.id, node.id)
      // if sorted, done!
      if (cmp < 0) break
      // if dup, splice it out (rare)
      if (cmp === 0) {
        this.closest.splice(i + 1, 1)
        break
      }
      // swap and continue down
      this.closest[i + 1] = prev
      this.closest[i] = node
    }
    if (this.closest.length > this.k) this.closest.pop()
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
    this.dht.request(this.target, this.command, this.value, node, { expectOk: false })
      .then(this._onresolve, this._onreject)
  }
}

function defaultMap (m) {
  return m
}
