var xor = require('xor-distance')

module.exports = QueryTable

function QueryTable (target) {
  if (!(this instanceof QueryTable)) return new QueryTable(target)

  this.target = target
  this.nodes = []
}

QueryTable.prototype.add = function (node) {
  for (var i = 0; i < this.nodes.length; i++) {
    if (this.nodes[i].id.equals(node.id)) return node
  }
  node.distance = xor(this.target, node.id)
  this.nodes.push(node)
  this.nodes.sort(function (a, b) {
    return xor.compare(a.distance, b.distance)
  })

  return node
}

QueryTable.prototype.closest = function (n) {
  return this.nodes.slice(0, n)
}
