const MAX_HEALTH_WINDOW = 4

module.exports = class NetworkHealth {
  static DEFAULT_MAX_HEALTH_WINDOW = MAX_HEALTH_WINDOW

  constructor(dht, { maxHealthWindow = MAX_HEALTH_WINDOW } = {}) {
    this._dht = dht
    this._maxHealthWindow = maxHealthWindow
    this.reset()
  }

  get cold() {
    return this._window.length < this._maxHealthWindow
  }

  reset() {
    this._window = []
    this.online = true
    this.degraded = false
    this._dht._online()
  }

  update() {
    const { responses, timeouts } = this._dht.stats.requests
    this._window.push({ responses, timeouts })
    if (this._window.length > this._maxHealthWindow) {
      this._window.shift()
    }

    const lastIndex = this._window.length - 1
    const someResponses = this._window[lastIndex].responses - this._window[0].responses > 0
    const someTimeouts = this._window[lastIndex].timeouts - this._window[0].timeouts > 0

    this.online = someResponses || this.cold
    this.degraded = this.online && someTimeouts

    if (this.online && !this.degraded) this._dht._online()
    if (this.degraded) this._dht._degraded()
    if (!this.online) this._dht._offline()
  }
}
