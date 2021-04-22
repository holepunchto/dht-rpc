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
    if (data.nodeId.equals(targetNode.id)) {
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
    if (data.nodeId.equals(targetNode.id)) {
      found = true
      break
    }
  }

  t.ok(found, 'found target again in ' + messages + ' message(s)')

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
    const node = new DHT({ bootstrap })
    await node.ready()
    all.push(node)
  }
  return all
}
