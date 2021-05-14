const DHT = require('../')
const crypto = require('crypto')

// Let's create 100 dht nodes for our example.
const swarm = []
for (let i = 0; i < 100; i++) swarm[i] = createNode()

function createNode () {
  const node = new DHT({
    ephemeral: false,
    bootstrap: [
      'localhost:10001'
    ]
  })

  const values = new Map()

  node.on('request', function (req) {
    if (req.command === 'values') {
      if (req.commit) {
        const key = sha256(req.value).toString('hex')
        values.set(key, req.value)
        console.log('Storing', key, '-->', req.value.toString())
        return req.reply(null)
      }

      const value = values.get(req.target.toString('hex'))
      req.reply(value)
    }
  })

  return node
}

function sha256 (val) {
  return crypto.createHash('sha256').update(val).digest()
}
