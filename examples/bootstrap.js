const DHT = require('../')

// Set ephemeral: true since this does not implement any APIs
DHT.bootstrapper(10001, { ephemeral: true })
