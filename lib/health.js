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
  }

  update() {
    this._window.push({ ...this._dht.stats.requests })
    if (this._window.length > this._maxHealthWindow) {
      this._window.shift()
    }

    let someResponses = false
    let someTimeouts = false
    for (let i = 1; i < this._window.length && !(someResponses && someTimeouts); i++) {
      const deltaResponses = this._window[i].responses - this._window[i - 1].responses
      const deltaTimeouts = this._window[i].timeouts - this._window[i - 1].timeouts
      someResponses ||= deltaResponses > 0
      someTimeouts ||= deltaTimeouts > 0
    }

    this.online = someResponses || this.cold
    this.degraded = this.online && someTimeouts
  }
}
