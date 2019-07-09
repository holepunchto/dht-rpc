const dht = require('../')

// Set ephemeral: true so other peers do not add us to the peer list, simply bootstrap
const bootstrap = dht({ ephemeral: true })

bootstrap.listen(10001)
