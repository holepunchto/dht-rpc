const xor = require('xor-distance')

class QueryTable {
  constructor (id, target) {
    this.k = 20
    this.id = id
    this.target = target
    this.closest = []
    this.unverified = []
  }

  addUnverified (node, referrer) {
    if (node.id.equals(this.id)) return

    node.distance = xor(this.target, node.id)
    node.referrer = referrer

    insertSorted(node, this.k, this.unverified)
  }

  addVerified (message, peer) {
    if (!message.id || !message.roundtripToken || message.id.equals(this.id)) {
      return
    }

    var prev = getNode(message.id, this.unverified)

    if (!prev) {
      prev = {
        id: message.id,
        host: peer.host,
        port: peer.port,
        distance: xor(message.id, this.target)
      }
    }

    prev.roundtripToken = message.roundtripToken
    insertSorted(prev, this.k, this.closest)
  }
}

module.exports = QueryTable

function getNode (id, list) {
  // find id in the list.
  // technically this would be faster with binary search (against distance)
  // but this list is always small, so meh

  for (var i = 0; i < list.length; i++) {
    if (list[i].id.equals(id)) return list[i]
  }

  return null
}

function insertSorted (node, max, list) {
  if (list.length === max && !xor.lt(node.distance, list[max - 1].distance)) return
  if (getNode(node.id, list)) return

  if (list.length < max) list.push(node)
  else list[max - 1] = node

  var pos = list.length - 1
  while (pos && xor.gt(list[pos - 1].distance, node.distance)) {
    list[pos] = list[pos - 1]
    list[pos - 1] = node
    pos--
  }
}
