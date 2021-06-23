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

  let q = swarm[499].query(targetNode.id, 'find_node', null)
  let messages = 0
  let found = false

  for await (const data of q) {
    messages++
    if (data.id && data.id.equals(targetNode.id)) {
      found = true
      break
    }
  }

  t.ok(found, 'found target in ' + messages + ' message(s)')

  q = swarm[490].query(targetNode.id, 'find_node', null, { nodes: q.closestNodes })
  messages = 0
  found = false

  for await (const data of q) {
    messages++
    if (data.id && data.id.equals(targetNode.id)) {
      found = true
      break
    }
  }

  t.ok(found, 'found target again in ' + messages + ' message(s)')

  const { type, host, port } = swarm[490].remoteAddress()

  t.same(type, DHT.NAT_OPEN)
  t.same(port, swarm[490].address().port)
  t.ok(host)

  destroy(swarm)
})

tape('nat sample promise', async function (t) {
  const swarm = await makeSwarm(5)

  const node = new DHT({
    bootstrap: [{ host: '127.0.0.1', port: swarm[0].address().port }]
  })

  let ready = false
  node.ready().then(() => {
    ready = true
  })

  await node.sampledNAT()
  t.ok(node._nat.length >= 3, 'min 3 samples')
  t.notOk(ready, 'before ready')
  await node.ready()
  t.ok(ready, 'after ready')

  node.destroy()
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
      if (req.command === 'after' && req.commit) {
        commits++
        return req.reply(null)
      }
    })
  }

  const q = swarm[42].query(swarm[0].table.id, 'before', null, {
    commit (m, dht, query) {
      return dht.request(query.target, 'after', null, m.from, { token: m.token })
    }
  })

  await q.finished()

  t.same(commits, swarm[42].table.k)

  destroy(swarm)
})

tape('map query stream', async function (t) {
  const swarm = await makeSwarm(10)

  const expected = []
  const q = swarm[0].query(swarm[0].table.id, 'find_node', null, {
    map (data) {
      if (expected.length > 3) return null
      expected.push(data.id)
      return data.id
    }
  })

  const buf = []
  q.on('data', (data) => buf.push(data))

  await q.finished()

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

  const q = a.query(Buffer.alloc(32), 'nope')
  await q.finished()

  t.same(tries, 4)

  bootstrap.destroy()
  a.destroy()
  b.destroy()
})

tape('shorthand commit', async function (t) {
  const swarm = await makeSwarm(40)
  let tokens = 0

  for (const node of swarm) {
    node.on('request', function (req) {
      if (req.commit) tokens++
      req.reply(null)
    })
  }

  const q = swarm[0].query(Buffer.alloc(32), 'nope', null, { commit: true })

  await q.finished()

  t.same(tokens, 20)

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

  const q = a.query(Buffer.alloc(32), 'nope', null, { commit: true })
  let error = null

  try {
    await q.finished()
  } catch (err) {
    error = err
  }

  t.ok(error, 'commit should fail')
  t.same(tries, 4)

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

  t.deepEqual(bNodes, [{ host: '127.0.0.1', port: a.address().port }])

  const responses = []
  for await (const data of b.query(a.id, 'hello')) {
    responses.push(data)
  }

  t.same(responses.length, 1, 'one response')
  t.same(responses[0].value, Buffer.from('world'), 'responded')

  const aNodes = a.toArray()

  t.deepEqual(aNodes, [{ host: '127.0.0.1', port: b.address().port }])

  a.destroy()
  b.destroy()
  bootstrap.destroy()
})

tape('set bind', async function (t) {
  const port = await freePort()

  const a = new DHT({ bind: port })
  await a.ready()

  t.same(a.address().port, port, 'bound to explicit port')

  const b = new DHT({ bind: port })
  await b.ready()

  t.notSame(b.address().port, port, 'bound to different port as explicit one is taken')

  a.destroy()
  b.destroy()
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
  const node = new DHT()
  await node.bind(0)
  const all = [node]
  const bootstrap = ['localhost:' + node.address().port]
  while (all.length < n) {
    const node = new DHT({ ephemeral: false, bootstrap })
    await node.ready()
    all.push(node)
  }
  return all
}
