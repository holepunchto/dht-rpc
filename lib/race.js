module.exports = async function race (p, min = 1, max = p.length) {
  let errors = 0
  const results = []
  // avoid unhandled rejections after early return/throw
  for (const promise of p) promise.catch(() => {})
  for (let i = 0; i < p.length; i++) {
    try {
      const res = await p[i]
      if (results.length < max) results.push(res)
      if (results.length >= max) return results
      if (results.length + errors === p.length) return results
    } catch {
      if ((p.length - ++errors) < min) throw new Error('Too many requests failed')
    }
  }
}
