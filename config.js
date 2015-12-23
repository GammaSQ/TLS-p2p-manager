fs = require('fs');

module.exports = {
  useTLS:true,
  defaultOptions: {
    'useCache': true,
    'lsiten': true,
    'port': 8333,
    'magic': 0xD9B4BEF9,
    'minPeers': 3,
    'targetPeers': 10,
    'maxPeers': 20,
    'idleTimeout': 30*60*1000 //time out if we haven't heard anything from peer in half an hour
  },
  TLS_server_options: {
    key: fs.readFileSync('key.pem'),
    cert: fs.readFileSync('cert.pem'),
    rejectUnauthorized:false,
    requestCert:true
  },
  TLS_connection_options: {
    key: fs.readFileSync('key.pem'),
    cert: fs.readFileSync('cert.pem'),
    rejectUnauthorized:false
  },
  TIMEOUT: 5*1000,
  checkInterval:60*1000 //1 minute
}