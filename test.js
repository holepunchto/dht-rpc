const tape = require('tape')
const dht = require('./')
const blake2b = require('./lib/blake2b')

tape('simple update', function (t) {
  bootstrap(function (port, node) {
    const a = dht({ bootstrap: port })
    const b = dht({ bootstrap: port })

    a.command('echo', {
      query (data, callback) {
        t.fail('should not query')
        callback(new Error('nope'))
      },
      update (data, callback) {
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

tape('query and update', function (t) {
  bootstrap(function (port, node) {
    const a = dht({ bootstrap: port })
    const b = dht({ bootstrap: port })

    a.command('hello', {
      query (data, callback) {
        t.same(data.value, null, 'expected query data')
        callback(null, Buffer.from('world'))
      },
      update (data, callback) {
        t.same(data.value, null, 'expected update data')
        callback(null, Buffer.from('world'))
      }
    })

    a.ready(function () {
      b.queryAndUpdate('hello', a.id, function (err, responses) {
        a.destroy()
        b.destroy()
        node.destroy()

        t.error(err, 'no errors')
        t.same(responses.length, 2, 'two responses')
        t.same(responses[0].value, Buffer.from('world'), 'responded')
        t.same(responses[1].value, Buffer.from('world'), 'responded')
        t.ok(responses[0].type !== responses[1].type, 'not the same type')
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

tape('holepunch api', function (t) {
  bootstrap(function (port, node) {
    const a = dht({ bootstrap: port })
    const b = dht({ bootstrap: port })
    var holepunched = false

    a.ready(function () {
      b.ready(function () {
        node.on('holepunch', function (from, to) {
          t.same(from.port, a.address().port)
          t.same(to.port, b.address().port)
          holepunched = true
        })
        a.holepunch({
          host: '127.0.0.1',
          port: b.address().port,
          referrer: {
            host: '127.0.0.1',
            port: node.address().port
          }
        }, function (err) {
          t.error(err, 'no error')
          t.ok(holepunched)
          t.end()

          node.destroy()
          a.destroy()
          b.destroy()
        })
      })
    })
  })
})

tape('timeouts', function (t) {
  bootstrap(function (port, node) {
    const a = dht({ bootstrap: port, ephemeral: true })
    const b = dht({ bootstrap: port })

    var tries = 0

    b.command('nope', {
      update (query, cb) {
        tries++
        t.pass('ignoring update')
      }
    })

    b.ready(function () {
      a.update('nope', Buffer.alloc(32), function (err) {
        t.ok(err, 'errored')
        t.same(tries, 3)
        t.end()
        node.destroy()
        a.destroy()
        b.destroy()
      })
    })
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
