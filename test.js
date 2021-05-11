const tape = require('tape')
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
    if (data.id.equals(targetNode.id)) {
      found = true
      break
    }
  }

  t.ok(found, 'found target in ' + messages + ' message(s)')

  q = swarm[490].query(targetNode.id, 'find_node', null, { closest: q.closest })
  messages = 0
  found = false

  for await (const data of q) {
    messages++
    if (data.id.equals(targetNode.id)) {
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
    commit (node, dht, query) {
      return dht.request(query.target, 'after', null, node)
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

function destroy (list) {
  for (const node of list) node.destroy()
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
