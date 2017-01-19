# dht-rpc

Make RPC calls over a Kademlia based DHT.

```
npm install dht-rpc
```
[![build status](http://img.shields.io/travis/mafintosh/dht-rpc.svg?style=flat)](http://travis-ci.org/mafintosh/dht-rpc)

## Usage

Here is an example implementing a simple key value store

First spin up a bootstrap node. You can make multiple if you want for redundancy.

``` js
var dht = require('dht-rpc')

// Set ephemeral: true so other peers do not add us to the peer list, simply bootstrap
var bootstrap = dht({ephemeral: true})

bootstrap.listen(10001)
```

Now lets make some dht nodes that can store values in our key value store.

``` js
var dht = require('dht-rpc')
var crypto = require('crypto')

// Let's create 100 dht nodes for our example.
for (var i = 0; i < 100; i++) createNode()

function createNode () {
  var node = dht({
    bootstrap: ['localhost:10001']
  })

  var values = {}

  // When we are the closest node and someone is sending us a "store" command
  node.on('closest:store', function (query, cb) {
    if (!query.value) return cb()

    // Use the hash of the value as the key
    var key = sha256(query.value).toString('hex')
    values[key] = query.value
    console.log('Storing', key, '-->', query.value.toString())
    cb()
  })

  // When someone is querying for a "lookup" command
  node.on('query:lookup', function (query, cb) {
    var value = values[query.target.toString('hex')]
    cb(null, value)
  })
}

function sha256 (val) {
  return crypto.createHash('sha256').update(val).digest('hex')
}
```

To insert a value into this dht make another script that does this following

``` js
// Set ephemeral: true as we are not part of the network.
var node = dht({ephemeral: true})

node.closest({command: 'store', target: sha256(val), value: val}, function (err, res) {
  if (err) throw err
  console.log('Inserted', sha256(val).toString('hex'))
})
```

Then after inserting run this script to query for a value

``` js
node.query({command: 'lookup', target: new Buffer(hexFromAbove, 'hex')})
  .on('data', function (data) {
    if (data.value && sha256(data.value).toString('hex') === hexFromAbove) {
      // We found the value! Destroy the query stream as there is no need to continue.
      console.log(val, '-->', data.value.toString())
      this.destroy()
    }
  })
  .on('end', function () {
    console.log('(query finished)')
  })
```

## API

#### `var node = dht([options])`

Create a new DHT node. Options include

``` js
{
  id: nodeId, // id of the node
  ephemeral: false, // will this node answer queries?
  bootstrap: ['host:port'], // bootstrap nodes
  socket: udpSocket // optional udp socket
}
```

#### `var stream = node.query(query, [options], [callback])`

Create a new query. Query should look like this

``` js
{
  command: 'command-to-run',
  target: new Buffer('32 byte target'),
  value: new Buffer('some payload')
}
```

And options include

``` js
{
  nodes: [{host: 'example.com', port: 4224}], // only contact these nodes
  holepunching: true // set to false to disable hole punching
}
```

The stream will emit query results as they arrive. If you backpressure the query it will backpressure the query as well.
Call `.destroy()` on the stream to cancel the query. If you pass the callback the streams payload will be buffered and passed to that.

#### `var stream = node.closest(query, [options], [callback])`

Same as a query but will trigger a closest query on the 20 closest nodes (distance between node ids and target) after the query finishes.
Per default the stream will only contain results from the closest query. To include the query results also pass the `verbose: true` option.

#### `node.on('query:{command}', data, callback)`

Called when a specific query is invoked on a node. `data` contains the same values as in the query above and also a `.node` property with info about the node invoking the query.

Call the callback with `(err, value)` to respond.

#### `node.on('closest:{command}', data, callback)`

Called when a closest query is invoked. The `data.node` is also guaranteed to have roundtripped to this dht before, meaning that you can trust that the host, port was not spoofed.

#### `node.ready(callback)`

Makes sure the initial bootstrap table has been built. You do not need to wait for this before querying.

#### `node.holepunch(peer, referrer, callback)`

UDP hole punch to another peer using the `referrer` as a STUN server.

#### `node.destroy()`

Destroy the dht node. Releases all resources.

## License

MIT
