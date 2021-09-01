exports.UNKNOWN_COMMAND = 1
exports.BAD_COMMAND = 2
exports.INVALID_TOKEN = 3

exports.TIMEOUT = new Error('Request timed out')
exports.TIMEOUT.code = 'ETIMEDOUT'

exports.DESTROY = new Error('Request destroyed')
exports.DESTROY.code = 'EDESTROYED'
