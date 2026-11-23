# Benchmarks

This repo includes three local loopback benchmarks for current `dht-rpc` behavior.

## Lookup

```sh
npm run bench:lookup
```

Runs [bench/find-node.js](./bench/find-node.js) for steady-state `findNode()` latency and throughput.

## Bootstrap

```sh
npm run bench:bootstrap
```

Runs [bench/bootstrap.js](./bench/bootstrap.js) for cold-start swarm bring-up.

## Admission

```sh
npm run bench:admission
```

Runs [bench/admission.js](./bench/admission.js) for warm-network join and admission pressure.

For a steadier baseline, prepend `DHT_RPC_BENCH_REPEATS=5`.
