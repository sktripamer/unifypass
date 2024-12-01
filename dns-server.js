const dns2 = require('dns2');
const { Packet } = dns2;
const sudo = require('sudo-prompt');
const os = require('os');
const { loadConfig } = require('./config');

const config = loadConfig();

const options = {
  name: 'Multipass DNS Server',
};

const dnsPort = config.mac.dnsPort;

function log(level, message, ...args) {
  const timestamp = new Date().toISOString();
  console[level](`[DNS ${timestamp}] ${message}`, ...args);
}

const server = dns2.createServer({
  udp: true,
  tcp: true,
  handle: async (request, send, rinfo) => {
    const response = Packet.createResponseFromRequest(request);
    const [question] = request.questions;
    const { name } = question;

    log('info', `DNS Query received from ${rinfo.address}:${rinfo.port} for ${name}`);

    if (name.endsWith(`.${config.mac.domain}`)) {
      const address = config.mac.localIP || '127.0.0.1';
      log('info', `Resolving ${name} to ${address}`);
      
      response.answers.push({
        name,
        type: Packet.TYPE.A,
        class: Packet.CLASS.IN,
        ttl: 300,
        address: address,
      });
      send(response);
    } else {
      // Forward other DNS queries to the default resolver
      try {
        log('info', `Forwarding query for ${name} to default resolver`);
        const answers = await dns2.resolveA(name);
        response.answers = answers;
        send(response);
      } catch (error) {
        log('error', `Error resolving ${name}:`, error.message);
        send(response);
      }
    }
  },
});



function startDNSServer() {
  try {
    server.listen({
      udp: { port: dnsPort, address: '127.0.0.1' },
      tcp: { port: dnsPort, address: '127.0.0.1' }
    });
    log('info', `DNS server listening on port ${dnsPort}`);
  } catch (error) {
    log('error', 'Failed to start DNS server:', error);
    process.exit(1);
  }
}

// Start the server if we're running with sudo
if (process.getuid && process.getuid() === 0) {
  startDNSServer();
} else {
  log('error', 'DNS server must be run as root');
  process.exit(1);
}