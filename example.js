var dht = require('./')
var crypto = require('crypto')

var node = dht({
  bootstrap: 'dht.mafintosh.com:10000'
})

var values = {}

node.on('closest:store', function (query, cb) {
  if (!query.value) return cb()
  var key = sha256(query.value).toString('hex')
  values[key] = query.value
  console.log('Storing', key, '-->', query.value.toString())
  cb()
})

node.on('query:lookup', function (query, cb) {
  var value = values[query.target.toString('hex')]
  cb(null, value)
})

if (process.argv.length > 3) {
  var val = process.argv.slice(3).join(' ')
  if (process.argv[2] === 'put') {
    node.closest({command: 'store', target: sha256(val), value: val}, function (err) {
      if (err) throw err
      console.log('Inserted', sha256(val).toString('hex'))
    })
  }
  if (process.argv[2] === 'get') {
    node.query({command: 'lookup', target: new Buffer(val, 'hex')})
      .on('data', function (data) {
        if (data.value && sha256(data.value).toString('hex') === val) {
          console.log(val, '-->', data.value.toString())
          this.destroy()
        }
      })
      .on('end', function () {
        console.log('(query finished)')
      })
  }
}

function sha256 (val) {
  return crypto.createHash('sha256').update(val).digest()
}
