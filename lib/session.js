module.exports = class Session {
  constructor (dht) {
    this.dht = dht
    this.inflight = []
  }

  _attach (req) {
    this.inflight.push(req)
  }

  _detach (req) {
    const i = this.inflight.indexOf(req)
    if (i === -1) return

    if (i === this.inflight.length - 1) this.inflight.pop()
    else this.inflight[i] = this.inflight.pop()
  }

  query ({ target, command, value }, opts = {}) {
    return this.dht.query({ target, command, value }, { ...opts, session: this })
  }

  request ({ token, command, target, value }, { host, port }, opts = {}) {
    return this.dht.request({ token, command, target, value }, { host, port }, { ...opts, session: this })
  }

  ping ({ host, port }, opts = {}) {
    return this.dht.ping({ host, port }, { ...opts, session: this })
  }

  destroy (err) {
    while (this.inflight.length) {
      const req = this.inflight.pop()
      req.destroy(err)
    }
  }
}
