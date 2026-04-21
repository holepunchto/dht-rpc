'use strict'

const { spawn } = require('child_process')

const CHILD_RUN = process.env.DHT_RPC_BENCH_CHILD === '1'

module.exports = {
  CHILD_RUN,
  cpuTimeMs,
  createNode,
  diffMemory,
  median,
  round,
  runCaseInChild,
  runRepeatedCases,
  summarizeDurationSamples,
  toMb
}

async function runRepeatedCases(repeats, runChild) {
  await runChild()

  const runs = []

  for (let round = 1; round <= repeats; round++) {
    const result = await runChild()
    result.round = round
    runs.push(result)
  }

  return runs
}

function runCaseInChild(filename) {
  return new Promise((resolve, reject) => {
    const stdout = []
    const stderr = []
    const child = spawn(process.execPath, ['--expose-gc', filename], {
      env: {
        ...process.env,
        DHT_RPC_BENCH_CHILD: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    child.stdout.on('data', (chunk) => {
      stdout.push(chunk)
    })

    child.stderr.on('data', (chunk) => {
      stderr.push(chunk)
    })

    child.on('error', reject)
    child.on('close', (code) => {
      const output = Buffer.concat(stdout).toString('utf8').trim()
      const errorOutput = Buffer.concat(stderr).toString('utf8').trim()

      if (code !== 0) {
        reject(new Error(errorOutput || ('Benchmark child exited with code ' + code)))
        return
      }

      const line = output.split('\n').filter(Boolean).at(-1)

      if (!line) {
        reject(new Error('Benchmark child produced no JSON output'))
        return
      }

      try {
        resolve(JSON.parse(line))
      } catch (err) {
        reject(new Error('Failed to parse benchmark child output: ' + line + '\n' + err.message))
      }
    })
  })
}

function createNode(DHT, opts) {
  return new DHT({
    ...opts,
    host: '127.0.0.1'
  })
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1

  if ((sorted.length & 1) === 1) return sorted[middle]
  return (sorted[middle - 1] + sorted[middle]) / 2
}

function diffMemory(after, before) {
  return {
    rss: after.rss - before.rss,
    heapUsed: after.heapUsed - before.heapUsed,
    external: after.external - before.external,
    arrayBuffers: after.arrayBuffers - before.arrayBuffers
  }
}

function summarizeDurationSamples(samples, { elapsedNs, rateCount = samples.length }) {
  if (samples.length === 0) {
    return {
      elapsedMs: Number(elapsedNs) / 1e6,
      ratePerSec: rateCount === 0 ? 0 : rateCount / (Number(elapsedNs) / 1e9),
      avgMs: 0,
      p95Ms: 0
    }
  }

  const totalNs = samples.reduce((sum, value) => sum + value, 0n)
  const sorted = [...samples].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

  return {
    elapsedMs: Number(elapsedNs) / 1e6,
    ratePerSec: rateCount === 0 ? 0 : rateCount / (Number(elapsedNs) / 1e9),
    avgMs: Number(totalNs) / samples.length / 1e6,
    p95Ms: Number(sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]) / 1e6
  }
}

function cpuTimeMs(cpu) {
  return (cpu.user + cpu.system) / 1000
}

function toMb(bytes) {
  return bytes / (1024 * 1024)
}

function round(value) {
  return Math.round(value * 100) / 100
}
