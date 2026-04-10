const MAX_HEALTH_WINDOW = 4
const OFFLINE_THRESHOLD = 2
const IDLE_THRESHOLD = 4
const DEGRADED_TIMEOUT_RATE_THRESHOLD = 0.5

module.exports = class NetworkHealth {
  constructor(dht) {
    this._dht = dht
    this._window = []
    this._head = -1
    this._offlineTicks = 0
    this._degradedTicks = 0
    this._healthyTicks = 0
    this.online = true
    this.degraded = false
  }

  get oldest() {
    return this._window[this._tail]
  }

  get previous() {
    return this._window[(this._head - 1 + MAX_HEALTH_WINDOW) % MAX_HEALTH_WINDOW]
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
    return this._window.length < MAX_HEALTH_WINDOW
  }

  get idle() {
    return this.responses + this.timeouts < IDLE_THRESHOLD
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
    return (this._head + 1) % MAX_HEALTH_WINDOW
  }

  reset() {
    this._window = []
    this._head = -1
    this._offlineTicks = 0
    this._degradedTicks = 0
    this._healthyTicks = 0
    this.online = true
    this.degraded = false
    this._dht._online()
  }

  update() {
    // update counters before dropping oldest
    if (this.oldest?.degraded) this._degradedTicks--
    else if (this.oldest?.degraded === false) this._healthyTicks--

    // move window
    this._head = this._tail
    this._window[this._head] = {
      responses: this._dht.stats.requests.responses,
      timeouts: this._dht.stats.requests.timeouts
    }

    // skip state changes
    if (this.cold || this.idle) return

    // update newest
    this.newest.offline = this.responses === 0
    this.newest.degraded =
      !this.newest.offline && this.timeoutsRate > DEGRADED_TIMEOUT_RATE_THRESHOLD

    // update counters
    if (this.newest.offline) this._offlineTicks++
    else {
      this._offlineTicks = 0
      if (this.newest.degraded) this._degradedTicks++
      else this._healthyTicks++
    }

    // check online/offline
    if (!this.newest.offline) this.online = true
    else if (this._offlineTicks >= OFFLINE_THRESHOLD) this.online = false

    // check degraded
    if (!this.online || this._healthyTicks === MAX_HEALTH_WINDOW) this.degraded = false
    else if (this._degradedTicks === MAX_HEALTH_WINDOW) this.degraded = true

    // fire events
    if (this.online && !this.degraded) this._dht._online()
    else if (this.degraded) this._dht._degraded()
    else this._dht._offline()
  }
}
