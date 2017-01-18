var tape = require('tape')
var dht = require('./')
var crypto = require('crypto')

tape('simple closest', function (t) {
  bootstrap(function (port, node) {
    var a = dht({bootstrap: port})
    var b = dht({bootstrap: port})

    a.on('closest:echo', function (data, callback) {
      t.ok(data.roundtripToken, 'has roundtrip token')
      t.same(data.value, new Buffer('Hello, World!'), 'expected data')
      callback(null, data.value)
    })

    a.ready(function () {
      var data = {
        command: 'echo',
        target: a.id,
        value: new Buffer('Hello, World!')
      }

      b.closest(data, function (err, responses) {
        a.destroy()
        b.destroy()
        node.destroy()

        t.error(err, 'no errors')
        t.same(responses.length, 1, 'one response')
        t.same(responses[0].value, new Buffer('Hello, World!'), 'echoed data')
        t.end()
      })
    })
  })
})

tape('simple query', function (t) {
  bootstrap(function (port, node) {
    var a = dht({bootstrap: port})
    var b = dht({bootstrap: port})

    a.on('query:hello', function (data, callback) {
      t.same(data.value, null, 'expected data')
      callback(null, new Buffer('world'))
    })

    a.ready(function () {
      var data = {
        command: 'hello',
        target: a.id
      }

      b.query(data, function (err, responses) {
        a.destroy()
        b.destroy()
        node.destroy()

        t.error(err, 'no errors')
        t.same(responses.length, 1, 'one response')
        t.same(responses[0].value, new Buffer('world'), 'responded')
        t.end()
      })
    })
  })
})

tape('swarm query', function (t) {
  bootstrap(function (port, node) {
    var swarm = []
    var closest = 0

    loop()

    function done () {
      t.pass('created swarm')
      var key = crypto.createHash('sha256').update('hello').digest()
      var me = dht({bootstrap: port})

      me.closest({command: 'kv', target: key, value: new Buffer('hello')}, function (err, responses) {
        t.error(err, 'no error')
        t.same(closest, 20, '20 closest nodes')
        t.same(responses.length, 20, '20 responses')

        var stream = me.query({command: 'kv', target: key})

        stream.on('data', function (data) {
          if (data.value) {
            t.same(data.value, new Buffer('hello'), 'echoed value')
            t.end()
            swarm.forEach(function (node) {
              node.destroy()
            })
            me.destroy()
            node.destroy()
            stream.destroy()
          }
        })
      })
    }

    function loop () {
      if (swarm.length === 256) return done()
      var node = dht({bootstrap: port})
      swarm.push(node)

      var value = null

      node.on('closest:kv', function (data, cb) {
        closest++
        value = data.value
        cb()
      })
      node.on('query:kv', function (data, cb) {
        cb(null, value)
      })

      node.ready(loop)
    }
  })
})

function bootstrap (done) {
  var node = dht({
    ephemeral: true
  })

  node.listen(10000, function () {
    done(node.address().port, node)
  })
}
