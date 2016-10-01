var xor = require('xor-distance')

var arr = []

var a = require('crypto').randomBytes(32)

for (var i = 0; i < 100; i++) {
  var node = require('crypto').randomBytes(32)
  arr.push({
    dist: xor(node, a),
    node: node
  })
}


arr.sort(function (a, b) {
  return xor.compare(a.dist, b.dist)
})

console.log(a)
console.log(arr)
