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

// Cold-start swarm bring-up benchmark.
// Default shape:
// - 64 total local nodes
// - 1 bootstrapper plus 63 additional joining nodes
const NODE_COUNT = Number(process.env.DHT_RPC_BENCH_NODES || 64)
const REPEATS = Number(process.env.DHT_RPC_BENCH_REPEATS || 5)

async function main() {
  if (CHILD_RUN) {
    const result = await runCase()
    process.stdout.write(JSON.stringify(result) + '\n')
    return
  }

  const runs = await runRepeatedCases(REPEATS, () => runCaseInChild(__filename))

  console.log('Median summary')
  console.table(
    [summarizeRuns(runs)].map((result) => ({
      runs: result.runs,
      nodes: result.nodes,
      bootstrapAvgMsMedian: round(result.bootstrapAvgMsMedian),
      bootstrapP95MsMedian: round(result.bootstrapP95MsMedian),
      totalElapsedMsMedian: round(result.totalElapsedMsMedian),
      nodesPerSecMedian: round(result.nodesPerSecMedian),
      cpuMsMedian: round(result.cpuMsMedian),
      rssDeltaMbMedian: round(result.rssDeltaMbMedian),
      heapDeltaMbMedian: round(result.heapDeltaMbMedian)
    }))
  )
}

async function runCase() {
  const nodes = []
  let bootstrapper = null

  try {
    bootstrapper = createNode(DHT, { ephemeral: false, firewalled: false })

    const cpuBefore = process.cpuUsage()
    if (global.gc) global.gc()
    const memoryBefore = process.memoryUsage()
    const started = process.hrtime.bigint()

    await bootstrapper.fullyBootstrapped()
    nodes.push(bootstrapper)

    const bootstrap = ['localhost:' + bootstrapper.address().port]
    const latencies = []

    while (nodes.length < NODE_COUNT) {
      const nodeStarted = process.hrtime.bigint()
      const node = createNode(DHT, { ephemeral: false, bootstrap })
      await node.fullyBootstrapped()
      latencies.push(process.hrtime.bigint() - nodeStarted)
      nodes.push(node)
    }

    const elapsedNs = process.hrtime.bigint() - started
    const cpu = process.cpuUsage(cpuBefore)
    if (global.gc) global.gc()
    const memoryAfter = process.memoryUsage()
    const stats = summarizeDurationSamples(latencies, { elapsedNs, rateCount: NODE_COUNT })

    return {
      nodes: NODE_COUNT,
      bootstrap: {
        totalElapsedMs: stats.elapsedMs,
        nodesPerSec: stats.ratePerSec,
        avgMs: stats.avgMs,
        p95Ms: stats.p95Ms,
        cpuMs: cpuTimeMs(cpu),
        memory: diffMemory(memoryAfter, memoryBefore)
      }
    }
  } finally {
    await Promise.allSettled(nodes.map((node) => node.destroy()))
  }
}

function summarizeRuns(runs) {
  return {
    runs: runs.length,
    nodes: runs[0].nodes,
    bootstrapAvgMsMedian: median(runs.map((result) => result.bootstrap.avgMs)),
    bootstrapP95MsMedian: median(runs.map((result) => result.bootstrap.p95Ms)),
    totalElapsedMsMedian: median(runs.map((result) => result.bootstrap.totalElapsedMs)),
    nodesPerSecMedian: median(runs.map((result) => result.bootstrap.nodesPerSec)),
    cpuMsMedian: median(runs.map((result) => result.bootstrap.cpuMs)),
    rssDeltaMbMedian: median(runs.map((result) => toMb(result.bootstrap.memory.rss))),
    heapDeltaMbMedian: median(runs.map((result) => toMb(result.bootstrap.memory.heapUsed)))
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
