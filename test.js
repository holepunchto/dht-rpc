const test = require('brittle')
const suspend = require('test-suspend')
const UDX = require('udx-native')
const DHT = require('./')
const { DOWN_HINT } = require('./lib/commands.js')

test('bootstrapper', async function (t) {
  const port = await freePort()

  const node = createBootstrapper(port)

  await node.fullyBootstrapped()

  if (node.address().family === 4) {
    t.is(node.address().host, '127.0.0.1')
    t.is(node.address().family, 4)
  } else {
    t.is(node.address().host, '::')
    t.is(node.address().family, 6)
  }
  t.is(node.address().port, port)

  await node.destroy()
})

test('bootstrapper - bind host', async function (t) {
  const port = await freePort()

  const node = createBootstrapper(port)

  await node.fullyBootstrapped()
  t.is(node.address().host, '127.0.0.1')
  t.is(node.address().family, 4)
  t.is(node.address().port, port)

  await node.destroy()
})

test('bootstrapper - opts.bootstrap', async function (t) {
  const port1 = await freePort()
  const port2 = await freePort()

  const node1 = createBootstrapper(port1)
  await node1.fullyBootstrapped()

  const bootstrap = [{ host: '127.0.0.1', port: node1.address().port }]
  const node2 = createBootstrapper(port2, { bootstrap })
  await node2.fullyBootstrapped()

  t.is(node1.bootstrapNodes.length, 0)
  t.alike(node2.bootstrapNodes, bootstrap)

  await node1.destroy()
  await node2.destroy()
})

test('bootstrapper - port and host are required', function (t) {
  t.plan(3)

  try {
    DHT.bootstrapper()
  } catch (error) {
    t.is(error.message, 'Port is required')
  }

  try {
    DHT.bootstrapper(0)
  } catch (error) {
    t.is(error.message, 'Port is required')
  }

  try {
    DHT.bootstrapper(49737)
  } catch (error) {
    t.is(error.message, 'Host is required')
  }
})

test('make tiny swarm', async function (t) {
  await makeSwarm(2, t)
  t.pass('could make swarm')
})

test('metrics', async function (t) {
  const [swarm1, swarm2] = await makeSwarm(2, t)

  const pingProm = swarm1.ping({ host: swarm2.host, port: swarm2.port })
  t.alike(swarm1.stats.commands.ping, { tx: 1, rx: 0 }, 'ping sent')
  await pingProm
  t.alike(swarm1.stats.commands.ping, { tx: 1, rx: 1 }, 'ping resp')
})

test('make bigger swarm', { timeout: 120000 }, async function (t) {
  const swarm = await makeSwarm(500, t)

  const targetNode = swarm[25]
  const target = targetNode.id

  let q = swarm[499].findNode(target)
  let messages = 0
  let found = false

  for await (const data of q) {
    messages++
    if (data.from.id && data.from.id.equals(target)) {
      found = true
      break
    }
  }

  const replies = q.closestReplies
  t.ok(found, 'found target in ' + messages + ' message(s)')

  q = swarm[490].findNode(target, { nodes: q.closestNodes })
  messages = 0
  found = false

  for await (const data of q) {
    messages++
    if (data.from.id && data.from.id.equals(target)) {
      found = true
      break
    }
  }

  t.ok(found, 'found target again in ' + messages + ' message(s)')

  q = swarm[470].findNode(target, { replies })
  messages = 0
  found = false

  for await (const data of q) {
    messages++
    if (data.from.id && data.from.id.equals(target)) {
      found = true
      break
    }
  }

  t.ok(found, 'found target again in ' + messages + ' message(s) with original replies')

  const { firewalled, host, port } = swarm[490]

  t.is(firewalled, false)
  t.is(port, swarm[490].address().port)
  t.ok(host)

  // Sanity check: nobody timed out, so there should be no down hints sent
  let downRx = 0
  let downTx = 0
  for (const x of swarm) {
    downRx += x.stats.commands.downHint.rx
    downTx += x.stats.commands.downHint.tx
  }
  t.is(downRx, 0, 'no down hints received')
  t.is(downTx, 0, 'no down hints sent')
})

test('commit after query', async function (t) {
  const swarm = await makeSwarm(100, t)
  const BEFORE = 0
  const AFTER = 1

  let commits = 0

  for (const node of swarm) {
    node.on('request', function (req) {
      if (req.command === BEFORE) {
        return req.reply(null)
      }
      if (req.command === AFTER && req.token) {
        commits++
        return req.reply(null)
      }
    })
  }

  const q = swarm[42].query(
    { command: BEFORE, target: swarm[0].table.id },
    {
      commit(m, dht, query) {
        return dht.request({ command: AFTER, target: query.target, token: m.token }, m.from)
      }
    }
  )

  await q.finished()

  t.is(commits, swarm[42].table.k)
})

test('map query stream', async function (t) {
  const swarm = await makeSwarm(10, t)

  const expected = []
  const q = swarm[0].findNode(swarm[0].table.id, {
    map(data) {
      if (expected.length > 3) return null
      expected.push(data.from.id)
      return data.from.id
    }
  })

  const buf = []
  q.on('data', (data) => buf.push(data))

  await q.finished()

  t.ok(expected.length > 0)
  t.alike(buf, expected)
})

test('timeouts', async function (t) {
  const [, a, b] = await makeSwarm(3, t)
  let tries = 0
  const NOPE = 52

  t.plan(5)

  b.on('request', function (req) {
    if (req.command === NOPE) {
      tries++
      t.pass('ignoring request')
    }
  })

  const q = a.query({ command: NOPE, target: Buffer.alloc(32) })
  await q.finished()

  t.is(tries, 3)
  t.is(a.stats.commands.downHint.tx, 1, 'a sent a down-hint message')
})

test('timeouts - downhints disabled', async function (t) {
  const [, a, b] = await makeSwarm(3, t, { sendDownHints: false })
  let tries = 0
  // Set to same command as DOWN_HINT but not internal to prove only DOWN_HINT is not sent
  const LOOKUP = DOWN_HINT // Command used in hyperdht
  const NOPE = LOOKUP

  t.plan(5)

  b.on('request', function (req) {
    if (req.command === NOPE) {
      tries++
      t.pass('ignoring request')
    }
  })

  const q = a.query({ command: NOPE, target: Buffer.alloc(32) })
  await q.finished()

  t.is(tries, 3)
  t.is(a.stats.commands.downHint.tx, 0, 'didnt send a down-hint message')
})

test('request with/without retries', async function (t) {
  const [, a, b] = await makeSwarm(3, t)
  let tries = 0
  const NOPE = 442

  b.on('request', function (req) {
    if (req.command === NOPE) {
      tries++
      t.pass('ignoring request')
    }
  })

  try {
    await a.request({ command: NOPE }, { host: '127.0.0.1', port: b.address().port })
  } catch {
    // do nothing
  }

  t.is(tries, 3)
  t.is(a.stats.requests.retries, 3 - 1, 'retried n - 1 times')

  try {
    await a.request(
      { command: NOPE },
      { host: '127.0.0.1', port: b.address().port },
      { retry: false }
    )
  } catch {
    // do nothing
  }

  t.is(tries, 4)
  t.is(a.stats.requests.retries, 3 - 1, 'didnt retry')
})

test('ratelimit downhint commands', async function (t) {
  const [, a, b, c] = await makeSwarm(4, t, { downHintsRateLimit: 1 })
  let tries = 0
  const NOPE = 52

  t.plan(3 + 4)

  b.on('request', function (req) {
    if (req.command === NOPE) {
      tries++
      t.pass('ignoring request')
    }
  })

  const queryOpts = { retries: 1 }
  const q = a.query({ command: NOPE, target: b.id }, queryOpts)
  await q.finished()

  const q2 = a.query({ command: NOPE, target: b.id }, queryOpts)
  await q2.finished()

  t.is(tries, 2)
  t.is(a.stats.commands.downHint.tx, 1, 'didnt send more than ratelimit')

  if ((a._tick + 1) % 8 === 0) a._tick++ // ensure ontick doesn't make requests
  if (a._refreshTicks <= 1) a._refreshTicks = 60
  a._ontick() // Simulate waiting for tick

  const q3 = a.query({ command: NOPE, target: b.id }, queryOpts)
  await q3.finished()

  t.is(tries, 3)
  t.is(a.stats.commands.downHint.tx, 2, 'rate limit was reset on tick')
})

test('ratelimit downhint can be 0', async function (t) {
  const [, a, b, c] = await makeSwarm(4, t, { downHintsRateLimit: 0 })
  let tries = 0
  const NOPE = 52

  t.plan(3 + 4)

  b.on('request', function (req) {
    if (req.command === NOPE) {
      tries++
      t.pass('ignoring request')
    }
  })

  const queryOpts = { retries: 1 }
  const q = a.query({ command: NOPE, target: b.id }, queryOpts)
  await q.finished()

  const q2 = a.query({ command: NOPE, target: b.id }, queryOpts)
  await q2.finished()

  t.is(tries, 2)
  t.is(a.stats.commands.downHint.tx, 0, 'didnt send down hint')

  if ((a._tick + 1) % 8 === 0) a._tick++ // ensure ontick doesn't make requests
  if (a._refreshTicks <= 1) a._refreshTicks = 60
  a._ontick() // Simulate waiting for tick

  const q3 = a.query({ command: NOPE, target: b.id }, queryOpts)
  await q3.finished()

  t.is(tries, 3)
  t.is(a.stats.commands.downHint.tx, 0, 'didnt send down hint after tick')
})

test('ratelimit findNode', async function (t) {
  const [, a, b, c] = await makeSwarm(4, t, { internalCommandsRateLimit: { findNode: 2 + 1 } })
  t.plan(2)

  const bootstrapStats = JSON.parse(JSON.stringify(a.stats.commands))

  const queryOpts = { retries: 1 }
  const q = a.findNode(b.id, queryOpts)
  await q.finished()

  const q2 = a.findNode(b.id, queryOpts)
  await q2.finished()

  // 3 because each query visits 3 other nodes. rate limit is per method call
  t.is(
    a.stats.commands.findNode.tx - bootstrapStats.findNode.tx,
    3,
    'didnt send more than ratelimit'
  )

  if ((a._tick + 1) % 8 === 0) a._tick++ // ensure ontick doesn't make requests
  if (a._refreshTicks <= 1) a._refreshTicks = 60
  a._ontick() // Simulate waiting for tick

  const q3 = a.findNode(b.id, queryOpts)
  await q3.finished()

  // 6 because each query visits 3 other nodes
  t.is(a.stats.commands.findNode.tx - bootstrapStats.findNode.tx, 6, 'rate limit was reset on tick')
})

test('ratelimit findNode via _backgroundQuery', async function (t) {
  const [, a, b, c] = await makeSwarm(4, t, { internalCommandsRateLimit: { findNode: 2 + 1 } })
  t.plan(3)

  const bootstrapStats = JSON.parse(JSON.stringify(a.stats.commands))
  t.is(bootstrapStats.findNode.tx, 2)

  a.refresh() // Easy way to trigger _backgroundQuery
  // allow to run in background
  await new Promise((resolve) => setTimeout(resolve, 100))

  a.refresh()
  // allow to run in background
  await new Promise((resolve) => setTimeout(resolve, 100))

  // 3 because each query visits 3 other nodes
  t.is(
    a.stats.commands.findNode.tx - bootstrapStats.findNode.tx,
    3,
    'didnt send more than ratelimit'
  )

  if ((a._tick + 1) % 8 === 0) a._tick++ // ensure ontick doesn't make requests
  if (a._refreshTicks <= 1) a._refreshTicks = 60
  a._ontick() // Simulate waiting for tick

  a.refresh()
  // allow to run in background
  await new Promise((resolve) => setTimeout(resolve, 100))

  // 6 because each query visits 3 other nodes
  t.is(a.stats.commands.findNode.tx - bootstrapStats.findNode.tx, 6, 'rate limit was reset on tick')
})

test('ratelimit ping', async function (t) {
  const [, a, b, c] = await makeSwarm(4, t, { internalCommandsRateLimit: { ping: 1 } })
  t.plan(3)

  const bootstrapStats = JSON.parse(JSON.stringify(a.stats.commands))

  const queryOpts = { retry: false }
  await a.ping({ host: b.host, port: b.port }, queryOpts)
  await t.exception(a.ping({ host: b.host, port: b.port }, queryOpts), 'PING hit rate limit')

  t.is(a.stats.commands.ping.tx - bootstrapStats.ping.tx, 1, 'didnt send more than ratelimit')

  if ((a._tick + 1) % 8 === 0) a._tick++ // ensure ontick doesn't make requests
  if (a._refreshTicks <= 1) a._refreshTicks = 60
  a._ontick() // Simulate waiting for tick

  await a.ping({ host: b.host, port: b.port }, queryOpts)

  t.is(a.stats.commands.ping.tx - bootstrapStats.ping.tx, 2, 'rate limit was reset on tick')
})

test('ratelimit ping via _check', async function (t) {
  const [, a, b, c] = await makeSwarm(4, t, { internalCommandsRateLimit: { ping: 1 } })
  t.plan(2)

  const bootstrapStats = JSON.parse(JSON.stringify(a.stats.commands))

  a._check(a.table.get(b.id))
  // allow to run in background
  await new Promise((resolve) => setTimeout(resolve, 100))

  a._check(a.table.get(b.id))
  // allow to run in background
  await new Promise((resolve) => setTimeout(resolve, 100))

  t.is(a.stats.commands.ping.tx - bootstrapStats.ping.tx, 1, 'didnt send more than ratelimit')

  if ((a._tick + 1) % 8 === 0) a._tick++ // ensure ontick doesn't make requests
  if (a._refreshTicks <= 1) a._refreshTicks = 60
  a._ontick() // Simulate waiting for tick
  t.comment('tick')

  a._check(a.table.get(c.id))
  // allow to run in background
  await new Promise((resolve) => setTimeout(resolve, 100))

  t.is(a.stats.commands.ping.tx - bootstrapStats.ping.tx, 2, 'rate limit was reset on tick')
})

test('ratelimit ping via _repingAndSwap', async function (t) {
  const [, a, b, c] = await makeSwarm(4, t, { internalCommandsRateLimit: { ping: 1 } })
  t.plan(2)

  const bootstrapStats = JSON.parse(JSON.stringify(a.stats.commands))

  a._repingAndSwap(a.table.get(b.id), a.table.get(c.id))
  // allow to run in background
  await new Promise((resolve) => setTimeout(resolve, 100))

  a._repingAndSwap(a.table.get(c.id), a.table.get(b.id))
  // allow to run in background
  await new Promise((resolve) => setTimeout(resolve, 100))

  t.is(a.stats.commands.ping.tx - bootstrapStats.ping.tx, 1, 'didnt send more than ratelimit')

  // ensure ontick doesn't make requests
  if ((a._tick + 1) % 8 === 0) a._tick++
  if (a._refreshTicks <= 1) a._refreshTicks = 60
  a._ontick() // Simulate waiting for tick
  t.comment('tick')

  a._repingAndSwap(a.table.get(c.id), a.table.get(b.id))
  // allow to run in background
  await new Promise((resolve) => setTimeout(resolve, 100))

  t.is(a.stats.commands.ping.tx - bootstrapStats.ping.tx, 2, 'rate limit was reset on tick')
})

test('ratelimit pingNat while bootstrapping', async function (t) {
  const [, a] = await makeSwarm(2, t, { internalCommandsRateLimit: { pingNat: 0 } })
  t.plan(1)

  t.is(a.stats.commands.pingNat.tx, 0, 'didnt send more than ratelimit')
})

test('shorthand commit', async function (t) {
  const swarm = await makeSwarm(40, t)

  let tokens = 0
  let notTokens = 0

  for (const node of swarm) {
    node.on('request', function (req) {
      if (req.token) tokens++
      else notTokens++
      req.reply(null)
    })
  }

  const q = swarm[0].query({ command: 42, target: Buffer.alloc(32) }, { commit: true })

  await q.finished()

  t.is(tokens, 20)
  t.ok(notTokens >= tokens)
})

test('after fullyBootstrapped it is always bound', async function (t) {
  t.plan(2)

  const node = createDHT()

  node.on('listening', function () {
    t.pass('is listening')
  })

  await node.fullyBootstrapped()
  const addr = node.address()

  t.ok(typeof addr.port, 'is number')

  await node.destroy()
})

test('timeouts when commiting', async function (t) {
  const [, a, b] = await makeSwarm(3, t)
  let tries = 0
  const NOPE = 41

  b.on('request', function (req) {
    if (req.command === NOPE) {
      tries++
      t.pass('ignoring request')
    }
  })

  const q = a.query({ command: NOPE, target: Buffer.alloc(32) }, { commit: true })
  let error = null

  try {
    await q.finished()
  } catch (err) {
    error = err
  }

  t.ok(error, 'commit should fail')
  t.is(tries, 3)
})

test('toArray', async function (t) {
  const [bootstrap, a, b] = await makeSwarm(3, t)

  t.alike(a.toArray(), [{ host: '127.0.0.1', port: b.address().port }])
  t.alike(b.toArray(), [{ host: '127.0.0.1', port: a.address().port }])
  t.alike(
    bootstrap.toArray().sort(cmpNodes),
    [
      { host: '127.0.0.1', port: a.address().port },
      { host: '127.0.0.1', port: b.address().port }
    ].sort(cmpNodes)
  )

  t.alike(bootstrap.toArray({ limit: 0 }), [])
  t.alike(bootstrap.toArray({ limit: 1 }), [{ host: '127.0.0.1', port: b.address().port }])
  t.alike(
    bootstrap.toArray({ limit: 2 }).sort(cmpNodes),
    [
      { host: '127.0.0.1', port: a.address().port },
      { host: '127.0.0.1', port: b.address().port }
    ].sort(cmpNodes)
  )
  t.alike(
    bootstrap.toArray({ limit: 10 }).sort(cmpNodes),
    [
      { host: '127.0.0.1', port: a.address().port },
      { host: '127.0.0.1', port: b.address().port }
    ].sort(cmpNodes)
  )
})

test('addNode / nodes option', async function (t) {
  const [bootstrap, a] = await makeSwarm(2, t)

  a.on('request', function (req) {
    t.is(req.value, null, 'expected data')
    req.reply(Buffer.from('world'))
  })

  await bootstrap.fullyBootstrapped()
  await a.fullyBootstrapped()

  const b = createDHT({
    ephemeral: false,
    nodes: [{ host: '127.0.0.1', port: a.address().port }]
  })
  await b.fullyBootstrapped()

  const bNodes = b.toArray()

  t.alike(bNodes, [{ host: '127.0.0.1', port: a.address().port }])

  const responses = []
  for await (const data of b.query({ command: 52, target: a.id })) {
    responses.push(data)
  }

  t.is(responses.length, 1, 'one response')
  t.alike(responses[0].value, Buffer.from('world'), 'responded')

  const aNodes = a.toArray()

  t.alike(aNodes, [{ host: '127.0.0.1', port: b.address().port }])

  await b.destroy()
})

test('set bind', async function (t) {
  const port = await freePort()

  const a = createDHT({ port, firewalled: false })
  await a.fullyBootstrapped()

  t.alike(a.address().port, port, 'bound to explicit port')

  const b = createDHT({ port })
  await b.fullyBootstrapped()

  t.not(b.address().port, port, 'bound to different port as explicit one is taken')

  await a.destroy()
  await b.destroy()
})

test('passing in a port gets translated into a 5-port range', async function (t) {
  const port = await freePort()
  const a = createDHT({ port, firewalled: false })
  t.alike(a.io.portRange, [port, port + 5])

  await a.fullyBootstrapped()
  t.alike(a.address().port, port, 'passed-in port gets precedence')

  await a.destroy()
})

test.skip('bind with port range', async function (t) {
  // WARNING: flaky tests (assumes the entire port range is free)
  // So best to skip when run in CI's
  const port = await freePort()
  const portRange = [port, port + 3]

  const a = createDHT({ port: portRange, firewalled: false })
  await a.fullyBootstrapped()
  t.alike(a.address().port, port, 'bound to explicit port')

  const b = createDHT({ port: portRange, firewalled: false })
  await b.fullyBootstrapped()
  t.is(b.address().port, port + 1, 'bound to next port')

  const c = createDHT({ port: portRange, firewalled: false })
  await c.fullyBootstrapped()
  t.is(c.address().port, port + 2, 'bound to next port')

  const d = createDHT({ port: portRange, firewalled: false })
  await d.fullyBootstrapped()
  // Note: flaky, since it could still bind to that port randomly
  t.not(d.address().port, port + 3, 'not bound to next port')

  await a.destroy()
  await b.destroy()
  await c.destroy()
  await d.destroy()
})

test('relay', async function (t) {
  const [, a, b, c] = await makeSwarm(4, t)

  const ROUTE = 1

  b.on('request', function (req) {
    t.is(req.command, ROUTE, 'b got request')
    t.is(req.from.port, a.address().port, 'from a')
    const value = Buffer.concat([req.value, Buffer.from('b')])
    req.relay(value, { host: '127.0.0.1', port: c.address().port })
  })

  c.on('request', function (req) {
    t.is(req.command, ROUTE, 'c got request')
    t.is(req.from.port, b.address().port, 'from b')
    const value = Buffer.concat([req.value, Buffer.from('c')])
    req.reply(value, { to: { host: '127.0.0.1', port: a.address().port } })
  })

  const res = await a.request(
    { command: ROUTE, value: Buffer.from('a') },
    { host: '127.0.0.1', port: b.address().port }
  )

  t.alike(res.value, Buffer.from('abc'))
  t.is(res.from.port, c.address().port)
  t.is(res.to.port, a.address().port)
})

test('filter nodes from routing table', async function (t) {
  const [a, b, c] = await makeSwarm(3, t)

  const node = createDHT({
    ephemeral: false,
    bootstrap: [a],
    filterNode(from) {
      return from.port !== b.port
    }
  })

  t.teardown(() => node.destroy())

  const q = node.findNode(c.id)
  await q.finished()

  t.absent(node.table.has(b.id), 'should not have b')
})

test('request session, destroy all', async function (t) {
  const [, a, b] = await makeSwarm(3, t)

  a.on('request', () => t.fail())

  const s = b.session()
  const p = [s.request({ command: 42 }, a), s.request({ command: 42 }, a)]

  const err = new Error('destroyed')

  s.destroy(err)

  for (const { status, reason } of await Promise.allSettled(p)) {
    t.is(status, 'rejected')
    t.is(reason, err)
  }
})

test('close event', async function (t) {
  t.plan(1)

  const node = createDHT()

  node.once('close', function () {
    t.pass('node closed')
  })

  await node.destroy()
})

test('close event is only emitted once', async function (t) {
  t.plan(2)

  const node = createDHT()
  let count = 0

  node.on('close', function () {
    if (++count >= 2) t.fail('close was emitted more than once')
    else t.pass('node closed')
  })

  await Promise.all([node.destroy(), node.destroy()])

  await node.destroy()
  await node.destroy()

  t.pass()
})

test('local address', async function (t) {
  t.plan(4)

  const node = createDHT()
  t.is(node.localAddress(), null)

  await node.fullyBootstrapped()
  t.comment('Local address (host): ' + node.localAddress().host)
  t.ok(node.localAddress().host.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/))
  t.is(node.localAddress().port, node.io.serverSocket.address().port)

  await node.destroy()

  t.pass()
})

test('remote address without peers', async function (t) {
  t.plan(3)

  const node = createDHT()
  t.is(node.remoteAddress(), null)

  await node.fullyBootstrapped()
  t.is(node.remoteAddress(), null)

  await node.destroy()

  t.pass()
})

test('remote address with peers', async function (t) {
  t.plan(6)

  const a = createDHT({ ephemeral: false, firewalled: false })
  t.is(a.remoteAddress(), null)
  await a.fullyBootstrapped()
  t.is(a.remoteAddress(), null)

  const bootstrap = ['localhost:' + a.address().port]
  const b = createDHT({ ephemeral: false, bootstrap })
  t.is(b.remoteAddress(), null)
  await b.fullyBootstrapped()
  t.is(b.remoteAddress().host, '127.0.0.1')

  t.is(a.remoteAddress().host, '127.0.0.1')

  await a.destroy()
  await b.destroy()

  t.pass()
})

test('nat update event', async function (t) {
  t.plan(4)

  const a = createDHT({ ephemeral: false, firewalled: false })
  await a.fullyBootstrapped()

  const bootstrap = ['localhost:' + a.address().port]
  const b = createDHT({ ephemeral: false, bootstrap })

  b.once('nat-update', function (host, port) {
    t.is(host, '127.0.0.1')
    t.is(port, b.io.clientSocket.address().port)

    b.once('nat-update', function (host, port) {
      t.is(host, '127.0.0.1')
      t.is(port, b.io.serverSocket.address().port)
    })
  })

  await b.fullyBootstrapped()

  await a.destroy()
  await b.destroy()
})

test('suspend - random port', async function (t) {
  const a = createDHT({ ephemeral: false, firewalled: false })
  await a.fullyBootstrapped()
  const bootstrap = ['localhost:' + a.address().port]

  const serverPortBefore = a.io.serverSocket.address().port
  const clientPortBefore = a.io.clientSocket.address().port

  await a.suspend()
  await a.resume()

  const serverPortAfter = a.io.serverSocket.address().port
  const clientPortAfter = a.io.clientSocket.address().port

  t.is(serverPortBefore, serverPortAfter)
  t.is(clientPortBefore, clientPortAfter)

  // Very basic check that the rebinded node still works
  const c = createDHT({ ephemeral: false, bootstrap })
  t.is(c.remoteAddress(), null)
  await c.fullyBootstrapped()
  t.is(c.remoteAddress().host, '127.0.0.1')
  await c.destroy()

  await a.destroy()
})

test('suspend - custom port', async function (t) {
  const port = await freePort()

  const a = createDHT({
    ephemeral: false,
    firewalled: false,
    port,
    anyPort: false
  })
  await a.fullyBootstrapped()

  const b = createDHT({ ephemeral: false, firewalled: false, port })
  await b.fullyBootstrapped()
  const bootstrap = ['localhost:' + b.address().port]

  await a.destroy()

  const serverPortBefore = b.io.serverSocket.address().port
  const clientPortBefore = b.io.clientSocket.address().port

  await a.suspend()
  await a.resume()

  const serverPortAfter = b.io.serverSocket.address().port
  const clientPortAfter = b.io.clientSocket.address().port

  t.is(serverPortBefore, serverPortAfter)
  t.is(clientPortBefore, clientPortAfter)

  t.not(serverPortBefore, port)

  // Very basic check that the rebinded node still works
  const c = createDHT({ ephemeral: false, bootstrap })
  t.is(c.remoteAddress(), null)
  await c.fullyBootstrapped()
  t.is(c.remoteAddress().host, '127.0.0.1')
  await c.destroy()

  await b.destroy()
})

test('suspend - fully suspends I/O', { deadlock: false }, async function (t) {
  const dht = createDHT({ ephemeral: false, firewalled: false })
  await dht.fullyBootstrapped()

  const s = await suspend()
  await dht.suspend()
  t.pass('suspended')

  await s.idle()
  t.pass('became idle')

  await s.resume()
  await dht.resume()
  t.pass('resumed')

  await dht.destroy()
})

test('response includes roundtrip time', async function (t) {
  const [, a, b] = await makeSwarm(3, t)
  const NOPE = 442
  const response = await a.request({ command: NOPE }, { host: '127.0.0.1', port: b.address().port })
  t.ok(response.rtt !== undefined)
})

test('bootstrap with reachable suggested-IP and skip DNS', async function (t) {
  const ip = '127.0.0.1'
  const domain = 'invalid'
  const port = await freePort()
  const bootstrapSyntax = [ip + '@' + domain + ':' + port]

  const bootstrap = createDHT({ port, ephemeral: false, firewalled: false })
  await bootstrap.fullyBootstrapped()

  const a = createDHT({ bootstrap: bootstrapSyntax, ephemeral: false })
  await a.fullyBootstrapped()

  const b = createDHT({ bootstrap: bootstrapSyntax, ephemeral: false })
  await b.fullyBootstrapped()

  const host = '127.0.0.1'
  t.alike(a.toArray(), [{ host, port: b.address().port }])
  t.alike(b.toArray(), [{ host, port: a.address().port }])
  t.alike(
    bootstrap.toArray().sort(cmpNodes),
    [
      { host, port: a.address().port },
      { host, port: b.address().port }
    ].sort(cmpNodes)
  )

  bootstrap.destroy()
  a.destroy()
  b.destroy()
})

test('bootstrap with unreachable suggested-IP and fallback to DNS (reachable)', async function (t) {
  const ip = '127.0.0.255'
  const domain = 'localhost'
  const port = await freePort()
  const bootstrapSyntax = [ip + '@' + domain + ':' + port]

  const bootstrap = createDHT({ port, ephemeral: false, firewalled: false })
  await bootstrap.fullyBootstrapped()

  const a = createDHT({ bootstrap: bootstrapSyntax, ephemeral: false })
  await a.fullyBootstrapped()

  const b = createDHT({ bootstrap: bootstrapSyntax, ephemeral: false })
  await b.fullyBootstrapped()

  const host = '127.0.0.1'
  t.alike(a.toArray(), [{ host, port: b.address().port }])
  t.alike(b.toArray(), [{ host, port: a.address().port }])
  t.alike(
    bootstrap.toArray().sort(cmpNodes),
    [
      { host, port: a.address().port },
      { host, port: b.address().port }
    ].sort(cmpNodes)
  )

  bootstrap.destroy()
  a.destroy()
  b.destroy()
})

test('Populate DHT with options.nodes', async function (t) {
  const a = createDHT({ bootstrap: [] })
  await a.fullyBootstrapped()

  const b = createDHT({ bootstrap: [] })
  await b.fullyBootstrapped()

  const nodes = [
    { host: '127.0.0.1', port: a.address().port },
    { host: '127.0.0.1', port: b.address().port }
  ]

  const c = createDHT({ nodes, bootstrap: [] })
  await c.fullyBootstrapped()

  t.alike(c.toArray(), nodes)

  a.destroy()
  b.destroy()
  c.destroy()
})

test('peer ids do not retain a slab', async function (t) {
  const swarm = await makeSwarm(2, t)
  t.is(swarm[1].id.buffer.byteLength, 32)
})

test('health - window wraps around', async (t) => {
  const dht = createDHT({ maxHealthWindow: 4 })

  t.alike(dht.health._window, [])

  fillHealthWindow(dht)

  t.alike(dht.health._window, [
    { responses: 0, timeouts: 0 }, // tail
    { responses: 0, timeouts: 0 },
    { responses: 0, timeouts: 0 },
    { responses: 0, timeouts: 0 } // head
  ])

  dht.stats.requests.responses++
  dht.health.update()

  t.alike(dht.health._window, [
    { responses: 1, timeouts: 0 }, // head
    { responses: 0, timeouts: 0 },
    { responses: 0, timeouts: 0 },
    { responses: 0, timeouts: 0 } // tail
  ])

  dht.destroy()
})

test('health - online', async (t) => {
  const dht = createDHT({ maxHealthWindow: 4 })

  t.is(dht.online, true, 'online initially')

  fillHealthWindow(dht)

  t.is(dht.online, true, 'online after initially idle')

  dht.health.online = false

  dht.stats.requests.responses = 1
  dht.stats.requests.timeouts = 0
  dht.health.update()

  t.is(dht.online, true, 'online after offline')
  t.is(dht.degraded, false)

  dht.destroy()
})

test('health - degraded', async (t) => {
  const dht = createDHT({ maxHealthWindow: 4 })

  t.is(dht.degraded, false, 'not degraded initially')

  fillHealthWindow(dht)

  t.is(dht.degraded, false, 'not degraded after initially idle')

  dht.stats.requests.responses = 0
  dht.stats.requests.timeouts = 20
  dht.health.update()

  t.is(dht.degraded, false, 'not degraded when responses < sanity')

  dht.stats.requests.responses = 80
  dht.stats.requests.timeouts = 40
  dht.health.update()

  t.is(dht.degraded, true, 'degraded when responses > sanity and timeouts > 25%')

  dht.stats.requests.responses = 200
  dht.stats.requests.timeouts = 40
  dht.health.update()

  t.is(dht.degraded, false, 'not degraded when timeout rate < 25%')

  dht.destroy()
})

test('health - offline', async (t) => {
  const dht = createDHT({ maxHealthWindow: 4 })

  fillHealthWindow(dht)

  dht.stats.requests.responses = 0
  dht.stats.requests.timeouts = 20
  dht.health.update()

  t.is(dht.online, false, 'offline when no responses & timeouts > sanity')

  dht.health.degraded = true

  dht.health.update()

  t.is(dht.online, false, 'offline when no responses & timeouts > sanity')
  t.is(dht.degraded, false, 'not degraded when offline')

  dht.health.reset()
  fillHealthWindow(dht)
  dht.health.online = false

  dht.stats.requests.responses = 0
  dht.stats.requests.timeouts = 1
  dht.health.update()

  t.is(dht.online, false, 'should stay offline when timeouts < sanity')

  dht.destroy()
})

test('health - resume', async (t) => {
  const dht = createDHT({ maxHealthWindow: 4 })

  fillHealthWindow(dht)

  dht.health.online = false

  await dht.suspend()
  await dht.resume()

  t.is(dht.health._window.length, 0, 'window is empty after resume')
  t.is(dht.online, true, 'online after resume')
  t.is(dht.degraded, false, 'not degraded after resume')

  dht.destroy()
})

function fillHealthWindow(dht) {
  for (let i = 0; i < 4; i++) {
    dht.health.update()
  }
}

async function freePort() {
  const udx = new UDX()
  const sock = udx.createSocket()
  sock.bind(0, '127.0.0.1')
  const port = sock.address().port
  await sock.close()
  return port
}

async function makeSwarm(n, t, opts = {}) {
  const node = createDHT({ ...opts, ephemeral: false, firewalled: false })
  await node.fullyBootstrapped()
  const all = [node]
  const bootstrap = ['localhost:' + node.address().port]
  while (all.length < n) {
    const node = createDHT({ ...opts, ephemeral: false, bootstrap })
    await node.fullyBootstrapped()
    all.push(node)
  }
  t.teardown(async function () {
    for (const node of all) await node.destroy()
  })
  return all
}

function cmpNodes(a, b) {
  return a.port - b.port
}

function createDHT(opts) {
  return new DHT({ ...opts, host: '127.0.0.1' })
}

function createBootstrapper(port, opts) {
  return DHT.bootstrapper(port, '127.0.0.1', { ...opts, host: '127.0.0.1' })
}
