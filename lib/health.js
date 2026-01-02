const MAX_HEALTH_WINDOW = 4

module.exports = class NetworkHealth {
  static DEFAULT_MAX_HEALTH_WINDOW = MAX_HEALTH_WINDOW

  constructor(dht, { maxHealthWindow = MAX_HEALTH_WINDOW } = {}) {
    this._dht = dht
    this._maxHealthWindow = maxHealthWindow
    this.reset()
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

    const oldest = this._window[this._tail]
    const newest = this._window[this._head]

    this.online = newest.responses - oldest.responses > 0
    this.degraded = this.online && newest.timeouts - oldest.timeouts > 0

    if (this.online && !this.degraded) this._dht._online()
    else if (this.degraded) this._dht._degraded()
    else this._dht._offline()
  }
}
