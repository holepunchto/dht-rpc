# dht-rpc

Make RPC calls over a [Kademlia](https://pdos.csail.mit.edu/~petar/papers/maymounkov-kademlia-lncs.pdf) based DHT.

```
npm install dht-rpc
```

[![build status](http://img.shields.io/travis/mafintosh/dht-rpc.svg?style=flat)](http://travis-ci.org/mafintosh/dht-rpc)

## Key Features

* UDP hole punching support
* Easily add any command to your DHT
* Streaming queries and updates

## Usage

Here is an example implementing a simple key value store

First spin up a bootstrap node. You can make multiple if you want for redundancy.

``` js
const dht = require('dht-rpc')

// Set ephemeral: true so other peers do not add us to the peer list, simply bootstrap
const bootstrap = dht({ ephemeral: true })

bootstrap.listen(10001)
```

Now lets make some dht nodes that can store values in our key value store.

``` js
const dht = require('dht-rpc')
const crypto = require('crypto')

// Let's create 100 dht nodes for our example.
for (var i = 0; i < 100; i++) createNode()

function createNode () {
  const node = dht({
    bootstrap: [
      'localhost:10001'
    ]
  })

  const values = new Map()

  node.command('values', {
    // When we are the closest node and someone is sending us a "store" command
    update (query, cb) {
      if (!query.value) return cb()

      // Use the hash of the value as the key
      const key = sha256(query.value).toString('hex')
      values.set(key, query.value)
      console.log('Storing', key, '-->', query.value.toString())
      cb()
    },
    // When someone is querying for a "lookup" command
    query (query, cb) {
      const value = values.get(query.target.toString('hex'))
      cb(null, value)
    }
  })
}

function sha256 (val) {
  return crypto.createHash('sha256').update(val).digest()
}
```

To insert a value into this dht make another script that does this following

``` js
// Set ephemeral: true as we are not part of the network.
const node = dht({ ephemeral: true })

node.update('values', sha256(val), value, function (err, res) {
  if (err) throw err
  console.log('Inserted', sha256(val).toString('hex'))
})
```

Then after inserting run this script to query for a value

``` js
node.query('values', Buffer.from(hexFromAbove, 'hex'))
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

#### `const node = dht([options])`

Create a new DHT node.

Options include:

```js
{
  // Whether or not this node is ephemeral or should join the routing table
  ephemeral: false,
  // A list of bootstrap nodes
  bootstrap: [ 'bootstrap-node.com:24242', ... ],
  // Optionally pass in your own UDP socket to use.
  socket: udpSocket
}
```

#### `node.command(name, cmd)`

Define a new RPC command. `cmd` should look like this

```js
{
  // Query handler
  query (query, cb),
  // Update handler. only triggered when we are one of the closest nodes to the target
  update (query, cb),
  // Optional value encoding for the query/update incoming value. Defaults to binary.
  inputEncoding: 'json', 'utf-8', object,
  // Optional value encoding for the query/update outgoing value. Defaults to binary.
  outputEncoding: (same as above),
  valueEncoding: (sets both input/output encoding to this)
}
```

The `query` object in the query/update function looks like this:

```js
{
  // always the same as your command def
  command: 'command-name',
  // the node who sent the query/update
  node: { port, host, id },
  // the query/update target (32 byte target)
  target: Buffer,
  // the query/update payload decoded with the inputEncoding
  value
}
```

You should call the query/update callback with `(err, value)` where
value will be encoded using the outputEncoding and returned to the node.

#### `const stream = node.query(name, target, [value], [callback])`

Send a query command.

If you set a valueEncoding when defining the command the value will be encoded.

Returns a result stream that emits data that looks like this:

```js
{
  // was this a query/update response
  type: dht.QUERY,
  // who sent this response
  node: { peer, host, id },
  // the response payload decoded using the outputEncoding
  value
}
```

If you pass a callback the stream will be error handled and buffered
and the content passed as an array.

#### `const stream = node.update(name, target, [value], [callback])`

Send a update command

Same options/results as above but the response data will have `type`
set to `dht.UPDATE`.

#### `const stream = node.queryAndUpdate(name, target, [value], [callback])`

Send a combined query and update command.

Will keep querying until it finds the closest nodes to the target and then
issue an update. More efficient than doing a query/update yourself.

Same options/results as above but the response data will include both
query and update results.

#### `node.destroy(onclose)`

Fully destroys the dht node.

#### `node.bootstrap(cb)`

Re-bootstrap the DHT node. Normally you shouldn't have to call this.

#### `node.holepunch(peer, cb)`

UDP holepunch to another peer. The DHT does this automatically
when it cannot reach another peer but you can use this yourself also.

Peer should look like this:

```js
{
  port,
  host,
  // referrer should be the node/peer that
  // told you about this node.
  referrer: { port, host }
}
```

#### `node.holepunchable()`

Returns `true` if your current network is holepunchable.
Relies on a heuristic interally based on remote node information.

It's usually best to wait for the `initial-nodes` or `ready` event before checking this
as it is more reliable the more routing information the node has.

#### `{ host, port } = node.remoteAddress()`

Returns your remote IP and port.
Relies on a heuristic interally based on remote node information.

If your IP could not be inferred `null` is returned.
If your IP could be inferred but your port not, `{ host, port: 0 }` is returned.

It's usually best to wait for the `initial-nodes` or `ready` event before checking this
as it is more reliable the more routing information the node has.


#### `node.listen([port], [address], [onlistening])`

Explicitly bind the dht node to a certain port/address.

#### `node.persistent()`

Dynamically convert the node from ephemeral to non-ephemeral (join the DHT).

#### `const nodes = node.getNodes()`

Get the list of peer nodes as an array of objects with fields `{ id, host, port }`.

#### `node.addNodes(nodes)`

Given an array of `{ id, host, port }` objects, adds those in the list of
peer nodes.

#### `node.on('ready')`

Emitted when the node is fully bootstrapped. You can make queries/updates before.

#### `node.on('initial-nodes')`

Emitted when the routing table has been initially populated.

#### `node.on('listening')`

Emitted when the node starts listening on a udp port.

#### `node.on('close')`

Emitted when the node is fully closed.

#### `node.on('holepunch', fromPeer, toPeer)`

Emitted when the node is helping `fromPeer` udp holepunch to `toPeer`.
