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

// Warm-network admission benchmark.
// Default shape:
// - 64 warm base nodes
// - 32 additional joining nodes
// - join concurrency 4
const BASE_NODES = Number(process.env.DHT_RPC_BENCH_BASE_NODES || 64)
const ADMISSION_NODES = Number(process.env.DHT_RPC_BENCH_ADMISSION_NODES || 32)
const ADMISSION_CONCURRENCY = Number(process.env.DHT_RPC_BENCH_CONCURRENCY || 4)
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
      baseNodes: result.baseNodes,
      admissionNodes: result.admissionNodes,
      admissionAvgMs: round(result.admission.avgMs),
      admissionP95Ms: round(result.admission.p95Ms),
      totalElapsedMs: round(result.admission.totalElapsedMs),
      nodesPerSec: round(result.admission.nodesPerSec),
      cpuMs: round(result.admission.cpuMs),
      rssDeltaMb: round(toMb(result.admission.memory.rss)),
      heapDeltaMb: round(toMb(result.admission.memory.heapUsed))
    }))
  )

  console.log('Median summary')
  console.table(
    [summarizeRuns(runs)].map((result) => ({
      runs: result.runs,
      baseNodes: result.baseNodes,
      admissionNodes: result.admissionNodes,
      admissionAvgMsMedian: round(result.admissionAvgMsMedian),
      admissionP95MsMedian: round(result.admissionP95MsMedian),
      totalElapsedMsMedian: round(result.totalElapsedMsMedian),
      nodesPerSecMedian: round(result.nodesPerSecMedian),
      cpuMsMedian: round(result.cpuMsMedian),
      rssDeltaMbMedian: round(result.rssDeltaMbMedian),
      heapDeltaMbMedian: round(result.heapDeltaMbMedian)
    }))
  )
}

async function runCase() {
  const base = []
  const admitted = []

  try {
    const bootstrapper = createNode(DHT, { ephemeral: false, firewalled: false })
    await bootstrapper.fullyBootstrapped()
    base.push(bootstrapper)

    const bootstrap = ['localhost:' + bootstrapper.address().port]

    while (base.length < BASE_NODES) {
      const node = createNode(DHT, { ephemeral: false, bootstrap })
      await node.fullyBootstrapped()
      base.push(node)
    }

    if (global.gc) global.gc()
    const memoryBefore = process.memoryUsage()
    const cpuBefore = process.cpuUsage()
    const started = process.hrtime.bigint()
    const latencies = new Array(ADMISSION_NODES)

    await Promise.all(
      Array.from({ length: ADMISSION_CONCURRENCY }, (_, worker) => workerLoop(worker))
    )

    const elapsedNs = process.hrtime.bigint() - started
    const cpu = process.cpuUsage(cpuBefore)
    if (global.gc) global.gc()
    const memoryAfter = process.memoryUsage()
    const stats = summarizeDurationSamples(latencies, { elapsedNs, rateCount: ADMISSION_NODES })

    return {
      baseNodes: BASE_NODES,
      admissionNodes: ADMISSION_NODES,
      admission: {
        totalElapsedMs: stats.elapsedMs,
        nodesPerSec: stats.ratePerSec,
        avgMs: stats.avgMs,
        p95Ms: stats.p95Ms,
        cpuMs: cpuTimeMs(cpu),
        memory: diffMemory(memoryAfter, memoryBefore)
      }
    }

    async function workerLoop(worker) {
      for (let i = worker; i < ADMISSION_NODES; i += ADMISSION_CONCURRENCY) {
        const nodeStarted = process.hrtime.bigint()
        const node = createNode(DHT, { ephemeral: false, bootstrap })
        await node.fullyBootstrapped()
        latencies[i] = process.hrtime.bigint() - nodeStarted
        admitted.push(node)
      }
    }
  } finally {
    await Promise.allSettled([...admitted, ...base].map((node) => node.destroy()))
  }
}

function summarizeRuns(runs) {
  return {
    runs: runs.length,
    baseNodes: runs[0].baseNodes,
    admissionNodes: runs[0].admissionNodes,
    admissionAvgMsMedian: median(runs.map((result) => result.admission.avgMs)),
    admissionP95MsMedian: median(runs.map((result) => result.admission.p95Ms)),
    totalElapsedMsMedian: median(runs.map((result) => result.admission.totalElapsedMs)),
    nodesPerSecMedian: median(runs.map((result) => result.admission.nodesPerSec)),
    cpuMsMedian: median(runs.map((result) => result.admission.cpuMs)),
    rssDeltaMbMedian: median(runs.map((result) => toMb(result.admission.memory.rss))),
    heapDeltaMbMedian: median(runs.map((result) => toMb(result.admission.memory.heapUsed)))
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
