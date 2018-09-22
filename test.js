const tape = require('tape')
const dht = require('./')
const blake2b = require('./lib/blake2b')

tape('simple update', function (t) {
  bootstrap(function (port, node) {
    const a = dht({ bootstrap: port })
    const b = dht({ bootstrap: port })

    a.command('echo', {
      update (data, callback) {
        t.ok(data.roundtripToken, 'has roundtrip token')
        t.same(data.value, Buffer.from('Hello, World!'), 'expected data')
        callback(null, data.value)
      }
    })

    a.ready(function () {
      b.update('echo', a.id, Buffer.from('Hello, World!'), function (err, responses) {
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
    const a = dht({ bootstrap: port })
    const b = dht({ bootstrap: port })

    a.command('hello', {
      query (data, callback) {
        t.same(data.value, null, 'expected data')
        callback(null, Buffer.from('world'))
      }
    })

    a.ready(function () {
      b.query('hello', a.id, function (err, responses) {
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

tape('swarm query', function (t) {
  bootstrap(function (port, node) {
    const swarm = []
    var closest = 0

    loop()

    function done () {
      t.pass('created swarm')

      const key = blake2b(Buffer.from('hello'))
      const me = dht({ bootstrap: port })

      me.update('kv', key, Buffer.from('hello'), function (err, responses) {
        t.error(err, 'no error')
        t.same(closest, 20, '20 closest nodes')
        t.same(responses.length, 20, '20 responses')

        const stream = me.query('kv', key)

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
      const node = dht({ bootstrap: port })
      swarm.push(node)

      var value = null

      node.command('kv', {
        update (data, cb) {
          closest++
          value = data.value
          cb()
        },
        query (data, cb) {
          cb(null, value)
        }
      })

      node.ready(loop)
    }
  })
})

function bootstrap (done) {
  const node = dht({
    ephemeral: true
  })

  node.listen(0, function () {
    done(node.address().port, node)
  })
}
