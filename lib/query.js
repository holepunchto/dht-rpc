const Table = require('kademlia-routing-table')
const { Readable } = require('streamx')

module.exports = class Query extends Readable {
  constructor (dht, target, command, value, opts = {}) {
    super()

    this.dht = dht
    this.table = opts.table || new Table(target, { k: 20 })
    this.command = command
    this.value = value
    this.errors = 0
    this.successes = 0
    this.concurrency = opts.concurrency || 16
    this.inflight = 0
    this.map = opts.map || defaultMap

    this._onresolve = this._onvisit.bind(this)
    this._onreject = this._onerror.bind(this)
  }

  get target () {
    return this.table.id
  }

  closest () {
    return this.table.closest(this.table.id)
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
    return this.dht.requestAll(this.table.id, command, value, this.closest(), opts)
  }

  async toArray () {
    const all = []
    this.on('data', data => all.push(data))
    await this.finished()
    return all
  }

  _open (cb) {
    let cnt = 0

    // we need to do this in case of table reuse
    for (const node of this.table.closest(this.table.id)) {
      node.visited = false
      cnt++
    }

    const closest = this.dht.table.closest(this.table.id)

    for (const node of closest) {
      cnt++
      this.table.add({
        visited: false,
        id: node.id,
        token: null,
        port: node.port,
        host: node.host
      })
    }

    if (cnt >= this.concurrency) return cb(null)

    this.dht._resolveBootstrapNodes((bootstrapNodes) => {
      for (const node of bootstrapNodes) {
        this._visit({
          visited: false,
          id: node.id,
          token: null,
          port: node.port,
          host: node.host
        })
      }

      cb(null)
    })
  }

  _read (cb) {
    this._readMore()
    cb(null)
  }

  _readMore () {
    if (this.destroying) return

    const closest = this.table.closest(this.table.id)

    for (const node of closest) {
      if (node.visited) continue
      if (this.inflight >= this.concurrency) return
      this._visit(node)
    }

    if (this.inflight === 0) {
      this.push(null)
    }
  }

  _onvisit (m) {
    this.successes++
    this.inflight--

    if (m.nodeId !== null) {
      this.table.add({
        visited: true,
        id: m.nodeId,
        token: m.token,
        port: m.from.port,
        host: m.from.host
      })
    }

    if (m.closerNodes !== null) {
      for (const node of m.closerNodes) {
        if (node.id.equals(this.dht.table.id)) continue
        if (this.table.get(node.id)) continue
        this.table.add({
          visited: false,
          id: node.id,
          token: null,
          port: node.port,
          host: node.host
        })
      }
    }

    if (this.push(this.map(m)) !== false) this._readMore()
  }

  _onerror () {
    this.errors++
    this.inflight--
    this._readMore()
  }

  _visit (node) {
    node.visited = true

    this.inflight++
    this.dht.request(this.table.id, this.command, this.value, node)
      .then(this._onresolve, this._onreject)
  }
}

function defaultMap (m) {
  return m
}
