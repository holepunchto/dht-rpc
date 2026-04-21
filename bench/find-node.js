'use strict'

const DHT = require('..')
const {
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
} = require('./_shared')

// Steady-state lookup benchmark.
// Default shape:
// - 96-node warm local swarm
// - 20 warmup lookups
// - 80 sequential lookups for latency
// - 240 concurrent lookups for throughput at concurrency 12
const NODE_COUNT = Number(process.env.DHT_RPC_BENCH_NODES || 96)
const WARMUP_LOOKUPS = Number(process.env.DHT_RPC_BENCH_WARMUP_LOOKUPS || 20)
const LATENCY_LOOKUPS = Number(process.env.DHT_RPC_BENCH_LATENCY_LOOKUPS || 80)
const THROUGHPUT_LOOKUPS = Number(process.env.DHT_RPC_BENCH_THROUGHPUT_LOOKUPS || 240)
const THROUGHPUT_CONCURRENCY = Number(process.env.DHT_RPC_BENCH_CONCURRENCY || 12)
const REPEATS = Number(process.env.DHT_RPC_BENCH_REPEATS || 5)

async function main() {
  if (CHILD_RUN) {
    const result = await runCase()
    process.stdout.write(JSON.stringify(result) + '\n')
    return
  }

  const runs = await runRepeatedCases(REPEATS, () => runCaseInChild(__filename))

  console.log('Per-run results')
  console.table(
    runs.map((result) => ({
      round: result.round,
      nodes: result.nodes,
      latencyAvgMs: round(result.latency.avgMs),
      latencyP95Ms: round(result.latency.p95Ms),
      throughputLookupsPerSec: round(result.throughput.lookupsPerSec),
      throughputAvgMs: round(result.throughput.avgMs),
      cpuMs: round(result.throughput.cpuMs),
      rssDeltaMb: round(toMb(result.throughput.memory.rss)),
      heapDeltaMb: round(toMb(result.throughput.memory.heapUsed))
    }))
  )

  console.log('Median summary')
  console.table(
    [summarizeRuns(runs)].map((result) => ({
      runs: result.runs,
      nodes: result.nodes,
      latencyAvgMsMedian: round(result.latencyAvgMsMedian),
      latencyP95MsMedian: round(result.latencyP95MsMedian),
      throughputLookupsPerSecMedian: round(result.throughputLookupsPerSecMedian),
      throughputAvgMsMedian: round(result.throughputAvgMsMedian),
      cpuMsMedian: round(result.cpuMsMedian),
      rssDeltaMbMedian: round(result.rssDeltaMbMedian),
      heapDeltaMbMedian: round(result.heapDeltaMbMedian)
    }))
  )
}

async function runCase() {
  const swarm = await makeSwarm(NODE_COUNT)

  try {
    await runLookups(swarm, WARMUP_LOOKUPS, 4)

    if (global.gc) global.gc()
    const latency = await runLookups(swarm, LATENCY_LOOKUPS, 1)

    if (global.gc) global.gc()
    const memoryBefore = process.memoryUsage()
    const cpuBefore = process.cpuUsage()
    const throughput = await runLookups(swarm, THROUGHPUT_LOOKUPS, THROUGHPUT_CONCURRENCY)
    const cpu = process.cpuUsage(cpuBefore)
    if (global.gc) global.gc()
    const memoryAfter = process.memoryUsage()

    throughput.cpuMs = cpuTimeMs(cpu)
    throughput.memory = diffMemory(memoryAfter, memoryBefore)

    return {
      nodes: NODE_COUNT,
      latency,
      throughput
    }
  } finally {
    await Promise.allSettled(swarm.map((node) => node.destroy()))
  }
}

async function runLookups(swarm, count, concurrency) {
  const latencies = new Array(count)
  const started = process.hrtime.bigint()

  await Promise.all(
    Array.from({ length: concurrency }, (_, worker) => workerLoop(worker, concurrency))
  )

  const elapsedNs = process.hrtime.bigint() - started
  const stats = summarizeDurationSamples(latencies, { elapsedNs, rateCount: count })

  return {
    count,
    concurrency,
    elapsedMs: stats.elapsedMs,
    lookupsPerSec: stats.ratePerSec,
    avgMs: stats.avgMs,
    p95Ms: stats.p95Ms
  }

  async function workerLoop(worker, step) {
    for (let i = worker; i < count; i += step) {
      const source = swarm[(i * 17 + 3) % swarm.length]
      let target = swarm[(i * 31 + 11) % swarm.length]

      if (target === source) {
        target = swarm[(i * 31 + 12) % swarm.length]
      }

      const startedAt = process.hrtime.bigint()
      const query = source.findNode(target.table.id)

      await query.finished()

      latencies[i] = process.hrtime.bigint() - startedAt
    }
  }
}

async function makeSwarm(count) {
  const first = createNode(DHT, { ephemeral: false, firewalled: false })
  await first.fullyBootstrapped()

  const bootstrap = ['localhost:' + first.address().port]
  const nodes = [first]

  while (nodes.length < count) {
    const node = createNode(DHT, { ephemeral: false, bootstrap })
    await node.fullyBootstrapped()
    nodes.push(node)
  }

  return nodes
}

function summarizeRuns(runs) {
  return {
    runs: runs.length,
    nodes: runs[0].nodes,
    latencyAvgMsMedian: median(runs.map((result) => result.latency.avgMs)),
    latencyP95MsMedian: median(runs.map((result) => result.latency.p95Ms)),
    throughputLookupsPerSecMedian: median(runs.map((result) => result.throughput.lookupsPerSec)),
    throughputAvgMsMedian: median(runs.map((result) => result.throughput.avgMs)),
    cpuMsMedian: median(runs.map((result) => result.throughput.cpuMs)),
    rssDeltaMbMedian: median(runs.map((result) => toMb(result.throughput.memory.rss))),
    heapDeltaMbMedian: median(runs.map((result) => toMb(result.throughput.memory.heapUsed)))
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
