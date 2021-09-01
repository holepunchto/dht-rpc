// TODO: move to module so we can have udp+tcp mode also on the same port etc etc

const dgram = require('dgram')

module.exports = async function bind (port) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4')
    let tries = 1

    socket.bind(port)
    socket.on('listening', onlistening)
    socket.on('error', onerror)

    function onlistening () {
      cleanup()
      resolve(socket)
    }

    function onerror (err) {
      if (port === 0 || tries >= 5) {
        cleanup()
        reject(err)
        return
      }

      if (++tries < 5) {
        socket.bind(++port)
      } else {
        port = 0
        socket.bind(0)
      }
    }

    function cleanup () {
      socket.removeListener('error', onerror)
      socket.removeListener('listening', onlistening)
    }
  })
}
