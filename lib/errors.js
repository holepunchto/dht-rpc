exports.UNKNOWN_COMMAND = 1
exports.INVALID_TOKEN = 2

exports.createTimeoutError = () => {
  const timeoutErr = new Error('Request timed out')
  timeoutErr.code = 'ETIMEDOUT'
  return timeoutErr
}

exports.createDestroyedError = () => {
  const destroyErr = new Error('Request destroyed')
  destroyErr.code = 'EDESTROYED'
  return destroyErr
}
