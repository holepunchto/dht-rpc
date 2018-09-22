const dht = require('./')

const bootstrap = dht()
bootstrap.listen(10001)

const nodes = []
var swarm = 1000
loop(null)

function loop (err) {
  if (err) throw err
  if (swarm--) addNode(loop)
  else done()
}

function done () {
  console.log('executing hi update')

  const i = Math.floor(Math.random() * nodes.length)
  const rs = nodes[i].update('hi', Buffer.alloc(32))

  rs.resume()
  rs.on('end', function () {
    setTimeout(done, 2000)
  })
}

function addNode (cb) {
  const node = dht({
    bootstrap: [
      10001
    ]
  })

  var hits = 0
  node.command('hi', {
    update (query, cb) {
      console.log('hi', ++hits)
      cb(null)
    },
    query (query, cb) {
      cb(null)
    }
  })

  node.once('ready', function () {
    nodes.push(node)
    cb()
  })
}
