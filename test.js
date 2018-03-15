var tape = require('tape')
var dht = require('./')
var blake2b = require('./blake2b')

tape('simple update', function (t) {
  bootstrap(function (port, node) {
    var a = dht({bootstrap: port})
    var b = dht({bootstrap: port})

    a.on('update:echo', function (data, callback) {
      t.ok(data.roundtripToken, 'has roundtrip token')
      t.same(data.value, Buffer.from('Hello, World!'), 'expected data')
      callback(null, data.value)
    })

    a.ready(function () {
      var data = {
        command: 'echo',
        target: a.id,
        value: Buffer.from('Hello, World!')
      }

      b.update(data, function (err, responses) {
        a.destroy()
        b.destroy()
        node.destroy()

        t.error(err, 'no errors')
        t.same(responses.length, 1, 'one response')
        t.same(responses[0].value, Buffer.from('Hello, World!'), 'echoed data')
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
      callback(null, Buffer.from('world'))
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
        t.same(responses[0].value, Buffer.from('world'), 'responded')
        t.end()
      })
    })
  })
})

tape('targeted query', function (t) {
  bootstrap(function (port, node) {
    var a = dht({bootstrap: port})

    a.on('query:echo', function (data, cb) {
      t.pass('in echo')
      cb(null, data.value)
    })

    var b = dht({bootstrap: port})

    b.on('query:echo', function (data, cb) {
      t.fail('should not hit me')
      cb()
    })

    a.ready(function () {
      b.ready(function () {
        var client = dht({bootstrap: port})

        client.query({
          command: 'echo',
          value: Buffer.from('hi'),
          target: client.id
        }, {
          node: {
            port: a.address().port,
            host: '127.0.0.1'
          }
        }, function (err, responses) {
          client.destroy()
          a.destroy()
          b.destroy()
          node.destroy()

          t.error(err, 'no error')
          t.same(responses.length, 1, 'one response')
          t.same(responses[0].value, Buffer.from('hi'), 'echoed')
          t.end()
        })
      })
    })
  })
})

tape('targeted update', function (t) {
  bootstrap(function (port, node) {
    var a = dht({bootstrap: port})

    a.on('update:echo', function (data, cb) {
      t.pass('in echo')
      cb(null, data.value)
    })

    var b = dht({bootstrap: port})

    b.on('update:echo', function (data, cb) {
      t.fail('should not hit me')
      cb()
    })

    a.ready(function () {
      b.ready(function () {
        var client = dht({bootstrap: port})

        client.update({
          command: 'echo',
          value: Buffer.from('hi'),
          target: client.id
        }, {
          node: {
            port: a.address().port,
            host: '127.0.0.1'
          }
        }, function (err, responses) {
          client.destroy()
          a.destroy()
          b.destroy()
          node.destroy()

          t.error(err, 'no error')
          t.same(responses.length, 1, 'one response')
          t.same(responses[0].value, Buffer.from('hi'), 'echoed')
          t.end()
        })
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
      var key = blake2b(Buffer.from('hello'))
      var me = dht({bootstrap: port})

      me.update({command: 'kv', target: key, value: Buffer.from('hello')}, function (err, responses) {
        t.error(err, 'no error')
        t.same(closest, 20, '20 closest nodes')
        t.same(responses.length, 20, '20 responses')

        var stream = me.query({command: 'kv', target: key})

        stream.on('data', function (data) {
          if (data.value) {
            t.same(data.value, Buffer.from('hello'), 'echoed value')
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

      node.on('update:kv', function (data, cb) {
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

  node.listen(function () {
    done(node.address().port, node)
  })
}
