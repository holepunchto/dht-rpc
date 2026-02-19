const MAX_HEALTH_WINDOW = 4
const IDLE_THRESHOLD = 4
const DEGRADED_TIMEOUT_RATE_THRESHOLD = 0.5

module.exports = class NetworkHealth {
  static DEFAULT_MAX_HEALTH_WINDOW = MAX_HEALTH_WINDOW

  constructor(dht, { maxHealthWindow = MAX_HEALTH_WINDOW } = {}) {
    this._dht = dht
    this._maxHealthWindow = maxHealthWindow
    this._window = []
    this._head = -1
    this._degradedTicks = 0
    this._healthyTicks = 0
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

  get responses() {
    if (!this.newest || !this.previous) return 0
    return this.newest.responses - this.previous.responses
  }

  get timeouts() {
    if (!this.newest || !this.previous) return 0
    return this.newest.timeouts - this.previous.timeouts
  }

  get timeoutsRate() {
    if (this.timeouts === 0) return 0
    return this.timeouts / (this.responses + this.timeouts)
  }

  get cold() {
    return this._window.length < this._maxHealthWindow
  }

  get idle() {
    return this.responses + this.timeouts < IDLE_THRESHOLD
  }

  get allDegraded() {
    return this._degradedTicks === this._maxHealthWindow
  }

  get allHealthy() {
    return this._healthyTicks === this._maxHealthWindow
  }

  get stats() {
    return {
      online: this.online,
      degraded: this.degraded,
      cold: this.cold,
      idle: this.idle,
      responses: this.responses,
      timeouts: this.timeouts,
      timeoutsRate: this.timeoutsRate
    }
  }

  get _tail() {
    return (this._head + 1) % this._maxHealthWindow
  }

  reset() {
    this._window = []
    this._head = -1
    this._degradedTicks = 0
    this._healthyTicks = 0
    this.online = true
    this.degraded = false
    this._dht._online()
  }

  update() {
    if (this.oldest?.degraded) this._degradedTicks--
    else if (this.oldest?.degraded === false) this._healthyTicks--

    this._head = this._tail
    this._window[this._head] = {
      responses: this._dht.stats.requests.responses,
      timeouts: this._dht.stats.requests.timeouts
    }

    if (this.cold || this.idle) return

    this.newest.degraded = this.timeoutsRate > DEGRADED_TIMEOUT_RATE_THRESHOLD

    if (this.newest.degraded) this._degradedTicks++
    else this._healthyTicks++

    this.online = this.responses > 0
    if (this.online && this.allDegraded) this.degraded = true
    if (!this.online || this.allHealthy) this.degraded = false

    if (this.online && !this.degraded) this._dht._online()
    else if (this.degraded) this._dht._degraded()
    else this._dht._offline()
  }
}
