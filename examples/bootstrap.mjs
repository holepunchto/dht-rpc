import DHT from '../index.js'

const bootstrap = new DHT({ ephemeral: false, firewalled: false, port: 10001 })
await bootstrap.ready()
console.log(bootstrap.address())
