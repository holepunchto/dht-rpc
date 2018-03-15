var dht = require('./')
var blake2b = require('./blake2b')

var node = dht({
  bootstrap: 'localhost:49737',
  ephemeral: !!process.argv[2]
})

var values = {}

node.on('update:store', function (query, cb) {
  console.log('(onupdate)')
  if (!query.value) return cb()
  var key = blake2b(query.value).toString('hex')
  values[key] = query.value
  console.log('Storing', key, '-->', query.value.toString())
  cb()
})

node.on('query:lookup', function (query, cb) {
  console.log('(onquery)')
  var value = values[query.target.toString('hex')]
  cb(null, value)
})

if (process.argv.length > 3) {
  var val = process.argv.slice(3).join(' ')
  if (process.argv[2] === 'put') {
    node.update({command: 'store', target: blake2b(Buffer.from(val)), value: val}, function (err) {
      if (err) throw err
      console.log('Inserted', blake2b(Buffer.from(val)).toString('hex'))
    })
  }
  if (process.argv[2] === 'get') {
    node.query({command: 'lookup', target: Buffer.from(val, 'hex')})
      .on('data', function (data) {
        if (data.value && blake2b(data.value).toString('hex') === val) {
          console.log(val, '-->', data.value.toString())
          this.destroy()
        }
      })
      .on('end', function () {
        console.log('(query finished)')
      })
  }
}
