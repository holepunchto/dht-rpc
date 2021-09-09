const tape = require('tape')
const dgram = require('dgram')
const DHT = require('./')

tape('make tiny swarm', async function (t) {
  const swarm = await makeSwarm(2)
  t.pass('could make swarm')
  destroy(swarm)
})

tape('make bigger swarm', async function (t) {
  const swarm = await makeSwarm(500)

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

  const { firewalled, host, port } = swarm[490]

  t.same(firewalled, false)
  t.same(port, swarm[490].address().port)
  t.ok(host)

  destroy(swarm)
})

tape('commit after query', async function (t) {
  const swarm = await makeSwarm(100)

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

  t.same(commits, swarm[42].table.k)

  destroy(swarm)
})

tape('map query stream', async function (t) {
  const swarm = await makeSwarm(10)

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
  t.same(buf, expected)

  destroy(swarm)
})

tape('timeouts', async function (t) {
  const [bootstrap, a, b] = await makeSwarm(3)
  let tries = 0

  b.on('request', function (req) {
    if (req.command === 'nope') {
      tries++
      t.pass('ignoring request')
    }
  })

  const q = a.query({ command: 'nope', target: Buffer.alloc(32) })
  await q.finished()

  t.same(tries, 3)

  bootstrap.destroy()
  a.destroy()
  b.destroy()
})

tape('request with/without retries', async function (t) {
  const [bootstrap, a, b] = await makeSwarm(3)
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

  t.same(tries, 3)

  try {
    await a.request({ command: 'nope' }, { host: '127.0.0.1', port: b.address().port }, { retry: false })
  } catch {
    // do nothing
  }

  t.same(tries, 4)

  bootstrap.destroy()
  a.destroy()
  b.destroy()
})

tape('reply onflush', async function (t) {
  const [bootstrap, a, b] = await makeSwarm(3)

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

  bootstrap.destroy()
  a.destroy()
  b.destroy()
})

tape('shorthand commit', async function (t) {
  const swarm = await makeSwarm(40)

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

  t.same(tokens, 20)
  t.ok(notTokens >= tokens)

  destroy(swarm)
})

tape('after ready it is always bound', async function (t) {
  t.plan(2)

  const node = new DHT()

  node.on('listening', function () {
    t.pass('is listening')
  })

  await node.ready()
  const addr = node.address()

  t.ok(typeof addr.port, 'is number')

  node.destroy()
})

tape('timeouts when commiting', async function (t) {
  const [bootstrap, a, b] = await makeSwarm(3)
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
  t.same(tries, 3)

  bootstrap.destroy()
  a.destroy()
  b.destroy()
})

tape('toArray', async function (t) {
  const [bootstrap, a, b] = await makeSwarm(3)

  t.same(a.toArray(), [{ host: '127.0.0.1', port: b.address().port }])
  t.same(b.toArray(), [{ host: '127.0.0.1', port: a.address().port }])
  t.same(bootstrap.toArray().sort(), [{ host: '127.0.0.1', port: a.address().port }, { host: '127.0.0.1', port: b.address().port }].sort())

  a.destroy()
  b.destroy()
  bootstrap.destroy()
})

tape('addNode / nodes option', async function (t) {
  const [bootstrap, a] = await makeSwarm(2)

  a.on('request', function (req) {
    t.same(req.value, null, 'expected data')
    req.reply(Buffer.from('world'))
  })

  await bootstrap.ready()
  await a.ready()

  const b = new DHT({ ephemeral: false, nodes: [{ host: '127.0.0.1', port: a.address().port }] })
  await b.ready()

  const bNodes = b.toArray()

  t.same(bNodes, [{ host: '127.0.0.1', port: a.address().port }])

  const responses = []
  for await (const data of b.query({ command: 'hello', target: a.id })) {
    responses.push(data)
  }

  t.same(responses.length, 1, 'one response')
  t.same(responses[0].value, Buffer.from('world'), 'responded')

  const aNodes = a.toArray()

  t.same(aNodes, [{ host: '127.0.0.1', port: b.address().port }])

  a.destroy()
  b.destroy()
  bootstrap.destroy()
})

tape('set bind', async function (t) {
  const port = await freePort()

  const a = new DHT({ bind: port, firewalled: false })
  await a.ready()

  t.same(a.address().port, port, 'bound to explicit port')

  const b = new DHT({ bind: port })
  await b.ready()

  t.notSame(b.address().port, port, 'bound to different port as explicit one is taken')

  a.destroy()
  b.destroy()
})

tape('relay', async function (t) {
  const [bootstrap, a, b, c] = await makeSwarm(4)

  b.on('request', function (req) {
    t.same(req.command, 'route', 'b got request')
    t.same(req.from.port, a.address().port, 'from a')
    const value = Buffer.concat([req.value, Buffer.from('b')])
    req.relay(value, { host: '127.0.0.1', port: c.address().port })
  })

  c.on('request', function (req) {
    t.same(req.command, 'route', 'c got request')
    t.same(req.from.port, b.address().port, 'from b')
    const value = Buffer.concat([req.value, Buffer.from('c')])
    req.reply(value, { to: { host: '127.0.0.1', port: a.address().port } })
  })

  const res = await a.request({ command: 'route', value: Buffer.from('a') }, { host: '127.0.0.1', port: b.address().port })

  t.same(res.value, Buffer.from('abc'))
  t.same(res.from.port, c.address().port)
  t.same(res.to.port, a.address().port)

  bootstrap.destroy()
  a.destroy()
  b.destroy()
  c.destroy()
})

function destroy (list) {
  for (const node of list) node.destroy()
}

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

async function makeSwarm (n) {
  const node = DHT.bootstrapper()
  await node.ready()
  const all = [node]
  const bootstrap = ['localhost:' + node.address().port]
  while (all.length < n) {
    const node = new DHT({ ephemeral: false, bootstrap })
    await node.ready()
    all.push(node)
  }
  return all
}
