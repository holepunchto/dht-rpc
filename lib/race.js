module.exports = function race (p, min, max) {
  min = typeof min === 'number' ? min : 1
  max = typeof max === 'number' ? max : p.length

  let errors = 0
  const results = []

  return new Promise((resolve, reject) => {
    for (let i = 0; i < p.length; i++) p[i].then(ondone, onerror)

    function ondone (res) {
      if (results.length < max) results.push(res)
      if (results.length >= max) return resolve(results)
      if (results.length + errors === p.length) return resolve(results)
    }

    function onerror () {
      if ((p.length - ++errors) < min) reject(new Error('Too many requests failed'))
    }
  })
}
