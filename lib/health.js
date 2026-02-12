const MAX_HEALTH_WINDOW = 4
const TIMEOUTS_THRESHOLD = 0.5

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

  get previous() {
    return this._window[(this._head - 1 + this._maxHealthWindow) % this._maxHealthWindow]
  }

  get newest() {
    return this._window[this._head]
  }

  get recentResponses() {
    if (!this.newest || !this.previous) return 0
    return this.newest.responses - this.previous.responses
  }

  get recentTimeouts() {
    if (!this.newest || !this.previous) return 0
    return this.newest.timeouts - this.previous.timeouts
  }

  get responses() {
    if (!this.newest || !this.oldest) return 0
    return this.newest.responses - this.oldest.responses
  }

  get timeouts() {
    if (!this.newest || !this.oldest) return 0
    return this.newest.timeouts - this.oldest.timeouts
  }

  get timeoutsRate() {
    if (this.timeouts === 0) return 0
    return this.timeouts / (this.responses + this.timeouts)
  }

  get stats() {
    return {
      online: this.online,
      degraded: this.degraded,
      responses: this.responses,
      timeouts: this.timeouts,
      timeoutsRate: this.timeoutsRate,
      recentResponses: this.recentResponses,
      recentTimeouts: this.recentTimeouts
    }
  }

  get _tail() {
    return (this._head + 1) % this._maxHealthWindow
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

    if (this._window.length < 2) return

    if (this.recentResponses > 0) {
      this.online = true
    }

    if (this.recentResponses === 0 && this.recentTimeouts > 0) {
      this.online = false
    }

    this.degraded = this.online && this.timeoutsRate > TIMEOUTS_THRESHOLD

    if (this.online && !this.degraded) this._dht._online()
    else if (this.degraded) this._dht._degraded()
    else this._dht._offline()
  }
}
