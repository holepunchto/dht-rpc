exports.UNKNOWN_COMMAND = 1
exports.INVALID_TOKEN = 2

exports.createTimeoutError = () => {
  const timeoutErr = new Error('Request timed out')
  timeoutErr.code = 'ETIMEDOUT'
  return timeoutErr
}

exports.createSuspendError = () => {
  const suspendErr = new Error('Suspended')
  suspendErr.code = 'ESUSPENDED'
  return suspendErr
}

exports.createDestroyedError = () => {
  const destroyErr = new Error('Request destroyed')
  destroyErr.code = 'EDESTROYED'
  return destroyErr
}
