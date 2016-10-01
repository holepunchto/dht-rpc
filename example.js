require('crypto').randomBytes = randomBytes = require('random-bytes-seed')()
// new Buffer('bc2cee9806f1408a4d09821a2478f593d8f08e27b4000c61e3672a1b6a42a5fa', 'hex')

var dht = require('./')

// bootstrap
dht().listen(10000)

var hash = require('crypto').createHash('sha256').update('hello world').digest()
var missing = 1000
var KBucket = require('k-bucket')
var bingo = (0.6 * missing) | 0 //(Math.random() * missing) | 0
var t

loop(0)

function createNode (i) {
  var node = dht({bootstrap: 10000})

  node.on('query', function (query, cb) {
    if (query.command === 'put' && query.roundtripToken) {
      console.log('got put command', query)
      return cb()
    }

    if (query.command === 'get') {
      console.log('got get command', query)
      return cb()
    }

    cb()
  })

  return node
}

function loop (i) {
  var node = createNode()

  node.on('ready', function () {
    console.log('node ' + i + ' is ready')
    if (i === missing) test()
    else loop(i + 1)
  })
  // var node = dht({bootstrap: 10000, id: i === bingo ? hash : undefined, debug: i === bingo})

  // if (i === bingo) t = node

  // node.on('ready', function () {
  //   console.log('node ' + i + ' is ready', i === bingo ? '(is target node)' : '')
  //   if (i === missing) test()
  //   else loop(i + 1)
  // })
}

function update (node, nodes, request, cb) {
  var missing = nodes.length

  for (var i = 0; i < nodes.length; i++) {
    var req = {
      id: node.id,
      command: request.command,
      target: request.target,
      value: request.value,
      roundtripToken: nodes[i].roundtripToken
    }

    node._request(req, nodes[i], done)
  }

  function done (err, res) {
    if (--missing) return
    cb()
  }
}

function test () {
  var node = dht({bootstrap: 10000})

  node.on('ready', function () {
    console.log('ready')

    var messages = 0
    var qs = require('./query-stream')(node, {
      command: '_find_node',
      target: hash
    }, {
      concurrency: 3
    })

    qs.on('data', function (data) {
      messages++
    })

    qs.on('end', function () {
      console.log('(end)', '(used ' + messages + ')')
      console.log('seed', randomBytes.seed.toString('hex'))

      console.log('closest', qs.closest)

      // node._closest({command: '_find_node', target: hash}, onresponse, function () {
      //   console.log('(end2)')
      // })

      // function onresponse (data) {
      //   console.log('hash ', hash)
      //   console.log('value', data.id)
      // }
    })
  })
}
