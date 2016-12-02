# dht-rpc

Make RPC calls over a Kademlia based DHT.

```
npm install dht-rpc
```

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

## License

MIT
