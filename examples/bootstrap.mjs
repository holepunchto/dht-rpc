import DHT from '../index.js'

const bootstrap = DHT.bootstrapper(10001, '127.0.0.1')
await bootstrap.ready()
console.log(bootstrap.address())
