const DHT = require('../')

// Set ephemeral: true so other peers do not add us to the peer list, simply bootstrap
const bootstrap = new DHT({ ephemeral: true })

bootstrap.bind(10001)
