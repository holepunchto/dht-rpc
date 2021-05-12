// how far can the port median distance be?
const INCREMENTING_THRESHOLD = 200

class NatAnalyzer {
  constructor (sampleSize) {
    // sampleSize must be 2^n
    this.samples = new Array(sampleSize)
    this.length = 0
    this.top = 0
  }

  sample (referrer) {
    for (let i = 0; i < this.length; i++) {
      const s = this.samples[i]
      const r = s.referrer
      if (r.port === referrer.port && r.host === referrer.host) return s
    }
    return null
  }

  add (addr, referrer) {
    if (this.length < this.samples.length) this.length++
    this.samples[this.top] = { port: addr.port, host: addr.host, dist: 0, referrer }
    this.top = (this.top + 1) & (this.samples.length - 1)
  }

  analyze (minSamples = 3) {
    if (this.length < minSamples) return { type: NatAnalyzer.UNKNOWN, host: null, port: 0 }

    const samples = this.samples.slice(0, this.length)
    const hosts = new Map()

    let bestHost = null
    let bestHits = 0

    for (let i = 0; i < samples.length; i++) {
      const host = samples[i].host
      const hits = (hosts.get(host) || 0) + 1

      hosts.set(host, hits)

      if (hits > bestHits) {
        bestHits = hits
        bestHost = host
      }
    }

    if (bestHits < (samples.length >> 1)) {
      return { type: NatAnalyzer.UNKNOWN, host: null, port: 0 }
    }

    samples.sort(cmpPort)

    let start = 0
    let end = samples.length
    let mid = samples[samples.length >> 1].port

    // remove the 3 biggest outliers from the median if we have more than 6 samples
    if (samples.length >= 6) {
      for (let i = 0; i < 3; i++) {
        const s = samples[start]
        const e = samples[end - 1]

        if (Math.abs(mid - s.port) < Math.abs(mid - e.port)) end--
        else start++
      }
    }

    const len = end - start
    mid = samples[len >> 1].port

    for (let i = 0; i < samples.length; i++) {
      samples[i].dist = Math.abs(mid - samples[i].port)
    }

    // note that still sorts with the outliers which is why we just start=0, end=len-1 below
    samples.sort(cmpDist)
    mid = samples[len >> 1].dist

    if (samples[0].dist === 0 && samples[len - 1].dist === 0) {
      return {
        type: NatAnalyzer.PORT_CONSISTENT,
        host: bestHost,
        port: samples[0].port
      }
    }

    if (mid < INCREMENTING_THRESHOLD) {
      return {
        type: NatAnalyzer.PORT_INCREMENTING,
        host: bestHost,
        port: 0
      }
    }

    return {
      type: NatAnalyzer.PORT_RANDOMIZED,
      host: bestHost,
      port: 0
    }
  }
}

NatAnalyzer.UNKNOWN = Symbol.for('NAT_UNKNOWN')
NatAnalyzer.PORT_CONSISTENT = Symbol.for('NAT_PORT_CONSISTENT')
NatAnalyzer.PORT_INCREMENTING = Symbol.for('NAT_PORT_INCREMENTING')
NatAnalyzer.PORT_RANDOMIZED = Symbol.for('NAT_PORT_RANDOM')

module.exports = NatAnalyzer

function cmpDist (a, b) {
  return a.dist - b.dist
}

function cmpPort (a, b) {
  return a.port - b.port
}
