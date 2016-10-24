var seed = new Buffer('2fd346fe907c29d215838c1bac0719f05010dda530a825dcac36081040db6acb', 'hex')
require('crypto').randomBytes = require('random-bytes-seed')(seed)
// new Buffer('bc2cee9806f1408a4d09821a2478f593d8f08e27b4000c61e3672a1b6a42a5fa', 'hex')

var dht = require('./')

// bootstrap
dht().listen(10000)

var value = new Buffer('hello world')
var hash = require('crypto').createHash('sha256').update(value).digest()
var missing = 1000
var KBucket = require('k-bucket')
var bingo = (0.6 * missing) | 0 //(Math.random() * missing) | 0
var t

loop(0)

function createNode (i) {
  var node = dht({bootstrap: 10000})
  var store = {}

  node.on('closest:store', function (request, cb) {
    console.log('storing')
    store[request.target.toString('hex')] = request.value
    cb()
  })

  node.on('query:lookup', function (request, cb) {
    var value = store[request.target.toString('hex')]
    cb(null, value)
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

function test () {
  var node = dht({bootstrap: 10000})

  node.on('ready', function () {
    console.log('ready')

    node.closest({
      command: 'store',
      target: hash,
      value: value
    }, function (err, responses) {
      console.log(err)
      console.log('stored on ' + responses.length + ' peers')

      var peers = 0
      var node2 = dht({bootstrap: 10000})

      node2.on('ready', function () {
        console.log('ready to query')

        var s = node2.query({
          command: 'lookup',
          target: hash
        })
        // s._debug = true

        s.on('data', function (data) {
          peers++
          if (data.value) {
            console.log(hash.toString('hex') + ' --> ' + data.value.toString(), '(' + peers + ' messages)')
            console.log(data)
            s.destroy()
          }
        })

        s.on('end', function () {
          console.log('(no more data)')
        })
      })
    })

    return

    // var qs = node.query({
    //   command: '_find_node',
    //   target: hash
    // }, {
    //   concurrency: 1
    // })

    // qs.on('end', function () {
    //   console.log('(end)')
    // })

    // loop()

    // function loop () {
    //   var data = qs.read()
    //   if (data) console.log('data', data)
    //   setTimeout(loop, 1000)
    // }

    // return

    var messages = 0
    var qs = node.query({
      command: '_find_node',
      target: hash
    })

    qs.on('data', function (data) {
      messages++
    })

    qs.on('end', function () {
      console.log('(end)', '(used ' + messages + ')')
      console.log('seed', randomBytes.seed.toString('hex'))

      // console.log('closest', qs.closest)
      update(node, qs.closest, {command: 'put', target: hash, value: value}, function () {
        node.query({
          command: 'get',
          target: hash
        }).on('data', function (data) {
          if (data.value) {
            console.log('->', data.value)
            this.destroy()
          }
        }).on('end', function () {
          console.log('(get query done)')
        })
      })


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
