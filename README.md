# dht-rpc

Make RPC calls over a [Kademlia](https://pdos.csail.mit.edu/~petar/papers/maymounkov-kademlia-lncs.pdf) based DHT.

```
npm install dht-rpc
```

## Key Features

* NAT type detection
* Easily add any command to your DHT
* Streaming queries and updates

Note that internally V5 of dht-rpc differs significantly from V4, due to a series
of improvements to NAT detection, secure routing IDs and more.

## Usage

Here is an example implementing a simple key value store

First spin up a bootstrap node. You can make multiple if you want for redundancy.

``` js
const DHT = require('dht-rpc')

// Set ephemeral: true so other peers never add us to their routing table, simply bootstrap
const bootstrap = new DHT({ ephemeral: true })

bootstrap.bind(10001)
```

Now lets make some dht nodes that can store values in our key value store.

``` js
const DHT = require('dht-rpc')
const crypto = require('crypto')

// Let's create 100 dht nodes for our example.
for (var i = 0; i < 100; i++) createNode()

function createNode () {
  const node = new DHT({
    bootstrap: [
      'localhost:10001'
    ]
  })

  const values = new Map()

  node.on('request', function (req) {
    if (req.command === 'values') {
      if (req.commit) { // if we are the closest node store the value (ie the node sent a roundtrip token)
        const key = sha256(req.value).toString('hex')
        values.set(key, req.value)
        console.log('Storing', key, '-->', req.value.toString())
        return req.reply(null)
      }

      const value = values.get(req.target.toString('hex'))
      req.reply(value)
    }
  })
}

function sha256 (val) {
  return crypto.createHash('sha256').update(val).digest()
}
```

To insert a value into this dht make another script that does this following

``` js
const node = new DHT()

await node.query(sha256(val), 'values', value, { commit: true }).finished()
```

Then after inserting run this script to query for a value

``` js
for await (const data of node.query(Buffer.from(hexFromAbove, 'hex'))) {
  if (data.value && sha256(data.value).toString('hex') === hexFromAbove) {
    // We found the value! Destroy the query stream as there is no need to continue.
    console.log(val, '-->', data.value.toString())
    break
  }
}
console.log('(query finished)')
```

## API

#### `const node = new DHT([options])`

Create a new DHT node.

Options include:

``` js
{
  // Whether or not this node is ephemeral or should join the routing table
  ephemeral: false,
  // If you don't explicitly specific the ephemerality, the node will automatically
  // figure it out in adaptive mode, based on your NAT settings, uptime and some other heuristics
  adaptive: true,
  // A list of bootstrap nodes
  bootstrap: [ 'bootstrap-node.com:24242', ... ],
  // Optionally pass in your own UDP socket to use.
  socket: udpSocket,
  // Optionally pass in array of { host, port } to add to the routing table if you know any peers
  nodes: [{ host, port }, ...]
}
```

Note that adaptive mode is very conservative, so it might take ~20-30 mins for the node to turn persistent.
For the majority of use-cases you should always use adaptive mode to ensure good DHT health.

Your DHT routing id is `hash(publicIp + publicPort)` and will be autoconfigured internally.

#### `await node.ready()`

Wait for the node to be fully bootstrapped etc.
You don't have to wait for this method, but can be useful during testing.

#### `await node.bind(port)`

Bind to a specific UDP port instead of a random one.

#### `node.id`

Get your own routing ID. Only available when the node is not ephemeral.

#### `node.ephemeral`

A boolean indicating if you are currently epheremal or not

#### `node.on('bootstrap')`

Emitted when the routing table is fully bootstrapped. Emitted as a conveinience.

#### `node.on('persistent')`

Emitted when the node is no longer in ephemeral mode.
All nodes start in ephemeral mode, as they figure out their NAT settings.
If you set `ephemeral: false` then this is emitted during the bootstrap phase, assuming
you are on an open NAT.

#### `node.on('wake-up')`

Emitted when the node has detected that the computer has gone to sleep. If this happens,
it will switch from persistent mode to ephemeral again.

#### `node.refresh()`

Refresh the routing table by looking up a random node in the background.
This is called internally periodically, but exposed in-case you want to force a refresh.

#### `{ type, host, port } = node.remoteAddress()`

Get your node's public ip, public port and the NAT type based on a series of internal
statistics (see the nat-analyzer code for more info).

This is extremely useful to figure out a relevant NAT holepunching technique as well if you want to connect
peers behind the DHT later on.

`type` is an enum symbol

* `DHT.NAT_UNKNOWN` - not enough data to figure out the NAT
* `DHT.NAT_OPEN` - fully open nat (ie a server) - a requirement for adaptive nodes to go persistent.
* `DHT.NAT_PORT_CONSISTENT` - NAT sessions appear consistent across multiple peers.
* `DHT.NAT_PORT_INCREMENTING` - NAT sessions appear to have an incremeting port across sessions.
* `DHT.NAT_PORT_RANDOMIZED` - NAT sessions appear randomized across sessions.

#### `await node.sampledNAT()`

Helper to indicate when the NAT analyzer has enough data to determine your NAT type as that happens much
faster than the bootstrapping promise returned by `ready()`.

#### `node.on('request', req)`

Emitted when an incoming DHT request is received. This is where you can add your own RPC methods.

* `req.target` - the dht target the peer is looking (routing is handled behind the scene)
* `req.command` - the RPC command name
* `req.value` - the RPC value buffer
* `req.token` - If the remote peer echoed back a valid roundtrip token, proving their "from address" this is set
* `req.commit` - Boolean set as a convenience if a valid token was provided
* `req.from` - who sent this request (host, port)

To reply to a request use the `req.reply(value)` method and to reply with an error code use `req.error(errorCode)`.
Error codes are up to the user to define. `dht-rpc` defines `0` as OK (ie no error), `1` as `UNKNOWN_COMMAND`,
both available as `DHT.OK` and `DHT.UNKNOWN_COMMAND`.

The DHT has a couple of built in commands for bootstrapping and general DHT health management.
Those are:

* `find_node` - Find the closest DHT nodes to a specific target with no side-effects.
* `ping` - Ping another node to see if it is alive.
* `ping_nat` - Ping another node, but have it reply on a different UDP session to see if you are firewalled.

#### `reply = await node.request(target, command, value, to, [options])`

Send a request to a specific node specified by the to address (`{ host, port }`).

Options include:

```js
{
  token: roundtripTokenFromAReply,
  retry: true, // whether the request should retry on timeout
  expectOk: true // expect the reply to have status 0 or error
}
```

Normally you'd set the token when commiting to the dht in the query's commit hook.

#### `reply = await node.ping(to)`

Sugar for `dht.request(null, 'ping', null, to)`

#### `replies = await node.requestAll(target, command, value, toArray, [options])`

Conveinience method for requesting many nodes at once.

#### `stream = node.query(target, command, [value], [options])`

Query the DHT. Will move as close as possible to the `target` provided, which should be a 32-byte uniformly distributed buffer (ie a hash).

* `command` - the method you want to invoke
* `value` - optional binary payload to send with it

If you want to modify state stored in the dht, you can use the commit flag to signal the closest
nodes.

``` js
{
  // "commit" the query to the 20 closest nodes so they can modify/update their state
  commit: true
}
```

Commiting a query will just re-request your command to the closest nodes once those are verified.
If you want to do some more specific logic with the closest nodes you can specify a function instead,
that is called for each close reply.

``` js
{
  async commit (closestReply, dht, query) {
    // normally you'd send back the roundtrip token here, to prove to the remote that you own
    // your ip/port
    await dht.request(myTarget, myCommand, myValue, closestReply.from, { token: closestReply.token })
  }
}
```

Other options include:

``` js
{
  nodes: [
    // start the query by querying these nodes
    // useful if you are re-doing a query from a set of closest nodes.
  ],
  map (reply) {
    // map the reply into what you want returned on the stram
    return { onlyValue: reply.value }
  }
}
```

The query method returns a stream encapsulating the query, that is also an async iterator. Each `data` event contain a DHT reply.
If you just want to wait for the query to finish, you can use the `await stream.finished()` helper. After completion the closest
nodes are stored in `stream.closestNodes` array.

#### `node.destroy()`

Shutdown the DHT node.

#### `node.toArray()`

Get the routing table peers out as an array of `{ host, port}`

#### `node.addNode({ host, port })`

Manually add a node to the routing table.

## License

MIT
