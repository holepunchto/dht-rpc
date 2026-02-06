const MAX_HEALTH_WINDOW = 2
const RESPONSES_SANITY = 0
const TIMEOUTS_SANITY = 0
const TIMEOUTS_THRESHOLD = 0.25

module.exports = class NetworkHealth {
  static DEFAULT_MAX_HEALTH_WINDOW = MAX_HEALTH_WINDOW

  constructor(dht, { maxHealthWindow = MAX_HEALTH_WINDOW } = {}) {
    this._dht = dht
    this._maxHealthWindow = maxHealthWindow
    this._window = []
    this._head = -1
    this.online = true
    this.degraded = false
  }

  get oldest() {
    return this._window[this._tail]
  }

  get newest() {
    return this._window[this._head]
  }

  get responses() {
    return this.newest.responses - this.oldest.responses
  }

  get timeouts() {
    return this.newest.timeouts - this.oldest.timeouts
  }

  get timeoutsRate() {
    return this.timeouts / (this.responses + this.timeouts)
  }

  get stats() {
    return {
      online: this.online,
      degraded: this.degraded,
      responses: this.responses,
      timeouts: this.timeouts,
      timeoutsRate: this.timeoutsRate
    }
  }

  get _tail() {
    return (this._head + 1) % this._maxHealthWindow
  }

  get cold() {
    return this._window.length < this._maxHealthWindow
  }

  reset() {
    this._window = []
    this._head = -1
    this.online = true
    this.degraded = false
    this._dht._online()
  }

  update() {
    this._head = this._tail
    this._window[this._head] = {
      responses: this._dht.stats.requests.responses,
      timeouts: this._dht.stats.requests.timeouts
    }

    if (this.cold) return

    const responses = this.responses
    const timeouts = this.timeouts
    const timeoutsRate = this.timeoutsRate

    if (responses > 0) {
      this.online = true
    }

    if (responses > RESPONSES_SANITY * this._window.length) {
      this.degraded = timeoutsRate > TIMEOUTS_THRESHOLD
    }

    if (responses === 0 && timeouts > TIMEOUTS_SANITY * this._window.length) {
      this.online = false
      this.degraded = false
    }

    if (this.online && !this.degraded) this._dht._online()
    else if (this.degraded) this._dht._degraded()
    else this._dht._offline()
  }
}
