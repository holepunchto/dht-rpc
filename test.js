const test = require('brittle')
const dgram = require('dgram')
const DHT = require('./')

test('make tiny swarm', async function (t) {
  await makeSwarm(2, t)
  t.pass('could make swarm')
})

test('make bigger swarm', async function (t) {
  const swarm = await makeSwarm(500, t)

  const targetNode = swarm[25]
  const target = targetNode.id

  let q = swarm[499].query({ command: 'find_node', target })
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

  q = swarm[490].query({ command: 'find_node', target }, { nodes: q.closestNodes })
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

  q = swarm[470].query({ command: 'find_node', target }, { replies })
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
})

test('commit after query', async function (t) {
  const swarm = await makeSwarm(100, t)

  let commits = 0

  for (const node of swarm) {
    node.on('request', function (req) {
      if (req.command === 'before') {
        return req.reply(null)
      }
      if (req.command === 'after' && req.token) {
        commits++
        return req.reply(null)
      }
    })
  }

  const q = swarm[42].query({ command: 'before', target: swarm[0].table.id }, {
    commit (m, dht, query) {
      return dht.request({ command: 'after', target: query.target, token: m.token }, m.from)
    }
  })

  await q.finished()

  t.is(commits, swarm[42].table.k)
})

test('map query stream', async function (t) {
  const swarm = await makeSwarm(10, t)

  const expected = []
  const q = swarm[0].query({ command: 'find_node', target: swarm[0].table.id }, {
    map (data) {
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

  b.on('request', function (req) {
    if (req.command === 'nope') {
      tries++
      t.pass('ignoring request')
    }
  })

  const q = a.query({ command: 'nope', target: Buffer.alloc(32) })
  await q.finished()

  t.is(tries, 3)
})

test('request with/without retries', async function (t) {
  const [, a, b] = await makeSwarm(3, t)
  let tries = 0

  b.on('request', function (req) {
    if (req.command === 'nope') {
      tries++
      t.pass('ignoring request')
    }
  })

  try {
    await a.request({ command: 'nope' }, { host: '127.0.0.1', port: b.address().port })
  } catch {
    // do nothing
  }

  t.is(tries, 3)

  try {
    await a.request({ command: 'nope' }, { host: '127.0.0.1', port: b.address().port }, { retry: false })
  } catch {
    // do nothing
  }

  t.is(tries, 4)
})

test('reply onflush', async function (t) {
  const [, a, b] = await makeSwarm(3, t)

  let flushed = false

  b.on('request', function (req) {
    req.reply(null, {
      onflush () {
        flushed = true
      }
    })
  })

  await a.request({ command: 'hello' }, { host: '127.0.0.1', port: b.address().port })
  t.ok(flushed)
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

  const q = swarm[0].query({ command: 'hello', target: Buffer.alloc(32) }, { commit: true })

  await q.finished()

  t.is(tokens, 20)
  t.ok(notTokens >= tokens)
})

test('after ready it is always bound', async function (t) {
  t.plan(2)

  const node = new DHT()

  node.on('listening', function () {
    t.pass('is listening')
  })

  await node.ready()
  const addr = node.address()

  t.ok(typeof addr.port, 'is number')

  await node.destroy()
})

test('timeouts when commiting', async function (t) {
  const [, a, b] = await makeSwarm(3, t)
  let tries = 0

  b.on('request', function (req) {
    if (req.command === 'nope') {
      tries++
      t.pass('ignoring request')
    }
  })

  const q = a.query({ command: 'nope', target: Buffer.alloc(32) }, { commit: true })
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
  t.alike(bootstrap.toArray().sort(), [{ host: '127.0.0.1', port: a.address().port }, { host: '127.0.0.1', port: b.address().port }].sort())
})

test('addNode / nodes option', async function (t) {
  const [bootstrap, a] = await makeSwarm(2, t)

  a.on('request', function (req) {
    t.is(req.value, null, 'expected data')
    req.reply(Buffer.from('world'))
  })

  await bootstrap.ready()
  await a.ready()

  const b = new DHT({ ephemeral: false, nodes: [{ host: '127.0.0.1', port: a.address().port }] })
  await b.ready()

  const bNodes = b.toArray()

  t.alike(bNodes, [{ host: '127.0.0.1', port: a.address().port }])

  const responses = []
  for await (const data of b.query({ command: 'hello', target: a.id })) {
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

  const a = new DHT({ bind: port, firewalled: false })
  await a.ready()

  t.alike(a.address().port, port, 'bound to explicit port')

  const b = new DHT({ bind: port })
  await b.ready()

  t.not(b.address().port, port, 'bound to different port as explicit one is taken')

  await a.destroy()
  await b.destroy()
})

test('relay', async function (t) {
  const [, a, b, c] = await makeSwarm(4, t)

  b.on('request', function (req) {
    t.is(req.command, 'route', 'b got request')
    t.is(req.from.port, a.address().port, 'from a')
    const value = Buffer.concat([req.value, Buffer.from('b')])
    req.relay(value, { host: '127.0.0.1', port: c.address().port })
  })

  c.on('request', function (req) {
    t.is(req.command, 'route', 'c got request')
    t.is(req.from.port, b.address().port, 'from b')
    const value = Buffer.concat([req.value, Buffer.from('c')])
    req.reply(value, { to: { host: '127.0.0.1', port: a.address().port } })
  })

  const res = await a.request({ command: 'route', value: Buffer.from('a') }, { host: '127.0.0.1', port: b.address().port })

  t.alike(res.value, Buffer.from('abc'))
  t.is(res.from.port, c.address().port)
  t.is(res.to.port, a.address().port)
})

function freePort () {
  return new Promise(resolve => {
    const socket = dgram.createSocket('udp4')

    socket.bind(0)
    socket.on('listening', function () {
      const { port } = socket.address()
      socket.close(() => resolve(port))
    })
  })
}

async function makeSwarm (n, t) {
  const node = DHT.bootstrapper()
  await node.ready()
  const all = [node]
  const bootstrap = ['localhost:' + node.address().port]
  while (all.length < n) {
    const node = new DHT({ ephemeral: false, bootstrap })
    await node.ready()
    all.push(node)
  }
  t.teardown(async function () {
    for (const node of all) await node.destroy()
  })
  return all
}
