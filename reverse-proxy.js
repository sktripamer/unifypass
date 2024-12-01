const net = require('net');
const { exec } = require('child_process');
const { promisify } = require('util');
const { loadConfig } = require('./config');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(exec);
const config = loadConfig();

// Cache for resolved instance IPs
const instanceCache = new Map();
const CACHE_TTL = 30000; // 30 seconds

// Enhanced logging function
function log(level, message, ...args) {
  const timestamp = new Date().toISOString();
  console[level](`[${timestamp}] ${message}`, ...args);
}

// Sanitize instance names to prevent command injection
function sanitizeInstanceName(name) {
  console.log('sanitizing instance name:', name);
  return name.replace(/[^a-zA-Z0-9_-]/g, '');
}

// Resolve instance IP with caching
async function resolveInstanceIP(instanceName) {
  const now = Date.now();
  const cached = instanceCache.get(instanceName);

  if (cached && (now - cached.timestamp) < CACHE_TTL) {
    log('info', `Cache hit for instance "${instanceName}"`);
    return cached.ip;
  }

  try {
    log('info', `Resolving IP for instance "${instanceName}"`);
    const { stdout } = await execAsync(`multipass info ${instanceName} --format json`);
    const info = JSON.parse(stdout);
    const ip = info.info[instanceName].ipv4[0];

    instanceCache.set(instanceName, { ip, timestamp: now });
    return ip;
  } catch (error) {
    log('error', `Error resolving IP for instance "${instanceName}": ${error.message}`);
    return null;
  }
}

// Get list of running instances asynchronously
async function getRunningInstances() {
  try {
    log('info', 'Fetching list of running instances');
    const { stdout } = await execAsync('multipass list --format json');
    const list = JSON.parse(stdout);
    return Object.entries(list.list).map(([name, info]) => ({
      name,
      ipv4: info.ipv4[0],
    }));
  } catch (error) {
    log('error', `Error getting running instances: ${error.message}`);
    return [];
  }
}

// Load HTML templates for error responses
const templatesDir = path.join(__dirname, 'templates');
const notFoundHtml = fs.readFileSync(path.join(templatesDir, 'not-found.html'), 'utf8');
const timeoutHtml = fs.readFileSync(path.join(templatesDir, 'timeout.html'), 'utf8');
const connectionRefusedHtml = fs.readFileSync(path.join(templatesDir, 'connection-refused.html'), 'utf8');

// Send error response over socket
async function sendSocketErrorResponse(socket, statusCode, htmlContent, isTLS) {
  if (isTLS) {
    // For TLS connections, it's not feasible to send an HTTP response without decrypting
    socket.end();
  } else {
    const response = `HTTP/1.1 ${statusCode} ${getStatusMessage(statusCode)}\r\nContent-Type: text/html\r\nContent-Length: ${Buffer.byteLength(htmlContent)}\r\n\r\n${htmlContent}`;
    socket.end(response);
  }
}

// Utility to get status message from code
function getStatusMessage(statusCode) {
  const statusMessages = {
    404: 'Not Found',
    502: 'Bad Gateway',
    504: 'Gateway Timeout',
  };
  return statusMessages[statusCode] || 'Error';
}

// Global error handler for sockets
function handleSocketError(socket, error, targetHost, isTLS) {
  if (error.code === 'ECONNREFUSED') {
    log('error', `Connection refused to ${targetHost}`);
    sendSocketErrorResponse(socket, 502, connectionRefusedHtml.replace(/loading\.\.\./g, targetHost || 'Unknown'), isTLS);
  } else if (error.code === 'ETIMEDOUT') {
    log('error', `Timeout connecting to ${targetHost} after ${config.mac.timeout || 5000}ms`);
    sendSocketErrorResponse(socket, 504, timeoutHtml.replace(/loading\.\.\./g, targetHost || 'Unknown').replace(/TIMEOUT_MS/g, config.mac.timeout || 5000), isTLS);
  } else {
    log('error', `Socket error: ${error.message}`);
    sendSocketErrorResponse(socket, 502, 'Bad Gateway', isTLS);
  }
}

// Function to extract hostname from TLS Client Hello
function extractHostnameFromTLS(buffer) {
  let offset = 0;

  // Check if it's a TLS ClientHello
  if (buffer.length < 5 || buffer.readUInt8(0) !== 0x16) {
    return null;
  }

  offset += 5; // Skip the record header

  // Skip TLS handshake header
  if (buffer.length < offset + 4) return null;
  const handshakeType = buffer.readUInt8(offset);
  const handshakeLength = buffer.readUIntBE(offset + 1, 3);
  offset += 4;

  if (handshakeType !== 0x01) { // ClientHello
    return null;
  }

  // Skip client version
  offset += 2;

  // Skip random
  offset += 32;

  // Skip session ID
  if (buffer.length < offset + 1) return null;
  const sessionIdLength = buffer.readUInt8(offset);
  offset += 1 + sessionIdLength;

  // Skip cipher suites
  if (buffer.length < offset + 2) return null;
  const cipherSuitesLength = buffer.readUInt16BE(offset);
  offset += 2 + cipherSuitesLength;

  // Skip compression methods
  if (buffer.length < offset + 1) return null;
  const compressionMethodsLength = buffer.readUInt8(offset);
  offset += 1 + compressionMethodsLength;

  // Read extensions
  if (buffer.length < offset + 2) return null;
  const extensionsLength = buffer.readUInt16BE(offset);
  offset += 2;

  const extensionsEnd = offset + extensionsLength;
  while (offset + 4 <= extensionsEnd) {
    const extType = buffer.readUInt16BE(offset);
    const extLength = buffer.readUInt16BE(offset + 2);
    offset += 4;

    if (extType === 0x00) { // Server Name extension
      if (buffer.length < offset + 2) return null;
      const serverNameListLength = buffer.readUInt16BE(offset);
      offset += 2;

      const serverNameEnd = offset + serverNameListLength;
      while (offset + 3 <= serverNameEnd) {
        const nameType = buffer.readUInt8(offset);
        const nameLength = buffer.readUInt16BE(offset + 1);
        offset += 3;

        if (nameType === 0x00) { // host_name
          if (buffer.length < offset + nameLength) return null;
          const hostname = buffer.toString('utf8', offset, offset + nameLength);
          return hostname;
        } else {
          offset += nameLength;
        }
      }
    } else {
      offset += extLength;
    }
  }

  return null;
}

// Function to extract hostname from HTTP headers
function extractHostnameFromHttp(buffer) {
  const data = buffer.toString();
  const match = data.match(/Host:\s*([^\r\n]+)/i);
  if (match) {
    return match[1].trim().split(':')[0]; // Remove port if present
  }
  return null;
}

// Function to send Not Found over Socket
async function sendNotFoundSocket(socket, instanceName, isTLS) {
  log('warn', `No matching Multipass instance for "${instanceName}"`);
  const runningInstances = await getRunningInstances();
  console.log('No matching Multipass instance for', instanceName);
  let html = notFoundHtml.replace(/loading\.\.\./g, instanceName || 'Unknown');

  if (runningInstances.length > 0) {
    const instanceListHtml = `
      <div class="tip" style="background: #34c75915; border-left-color: #34c759;">
        <strong>Running Instances:</strong><br>
        <table style="width: 100%; border-collapse: collapse; margin-top: 0.5rem;">
          <tr style="text-align: left; border-bottom: 1px solid #34c75940;">
            <th style="padding: 0.5rem;">Name</th>
            <th style="padding: 0.5rem;">IP</th>
            <th style="padding: 0.5rem;">URL</th>
          </tr>
          ${runningInstances.map(instance => `
            <tr style="border-bottom: 1px solid #34c75920;">
              <td style="padding: 0.5rem;"><code>${instance.name}</code></td>
              <td style="padding: 0.5rem;"><code>${instance.ipv4}</code></td>
              <td style="padding: 0.5rem;"><code>https://${instance.name}.${config.mac.domain}</code></td>
            </tr>
          `).join('')}
        </table>
        <small style="display: block; margin-top: 0.5rem;">These are your currently running Multipass instances.</small>
      </div>`;

    html = html.replace('</div></body>', `${instanceListHtml}</div></body>`);
  }

  if (isTLS) {
    // Cannot send HTTP response over SSL connection without decryption
    socket.end();
  } else {
    const response = `HTTP/1.1 404 Not Found\r\nContent-Type: text/html\r\nContent-Length: ${Buffer.byteLength(html)}\r\n\r\n${html}`;
    socket.end(response);
  }
}

// Function to handle HTTP proxying
function handleHttpProxy(clientSocket, buffer, targetIP, targetPort) {
  const serverSocket = net.connect(targetPort, targetIP, () => {
    serverSocket.write(buffer); // Write the initial data
    clientSocket.pipe(serverSocket);
    serverSocket.pipe(clientSocket);
  });

  serverSocket.on('error', (err) => {
    handleSocketError(clientSocket, err, `${targetIP}:${targetPort}`, false);
    serverSocket.end();
    clientSocket.end();
  });

  clientSocket.on('error', (err) => {
    log('error', `Client socket error: ${err.message}`);
    serverSocket.end();
  });
}

function handleConnection(socket, config) {
  // Buffer to store the first few bytes
  let buffer = Buffer.alloc(0);
  console.log('New connection received on port:', socket.localPort);

  // Handle incoming data
  const onData = async (data) => {
    buffer = Buffer.concat([buffer, data]);
    console.log('Received data:', buffer.toString().split('\n')[0]); // Log first line of request

    // Determine protocol based on the first few bytes
    let isTLS = false;
    let hostname = null;

    // Attempt to extract hostname if it's TLS
    hostname = extractHostnameFromTLS(buffer);
    if (hostname) {
      isTLS = true;
      console.log('TLS connection detected, hostname:', hostname);
    } else {
      // Try to extract hostname from HTTP Host header
      hostname = extractHostnameFromHttp(buffer);
      console.log('HTTP connection detected, hostname:', hostname);
    }

    // Determine the port being connected to
    const listeningPort = socket.localPort;
    console.log('Listening port:', listeningPort);

    // Determine target instance and port based on configuration
    let targetInstance = null;
    let targetPort = null;

    // Check per-instance ports first
    for (const [instanceName, instanceConfig] of Object.entries(config.mac.instances)) {
      if (instanceConfig.ports.includes(listeningPort)) {
        targetInstance = instanceName;
        targetPort = listeningPort;
        console.log('Found instance-specific port configuration:', instanceName, targetPort);
        break;
      }
    }

    // Check globalPorts
    if (!targetInstance && config.mac.globalPorts.includes(listeningPort)) {
      targetInstance = sanitizeInstanceName(hostname ? hostname.split('.')[0] : 'Unknown');
      targetPort = listeningPort;
      console.log('Using global port configuration:', targetInstance, targetPort);
    }

    // Handle default ports
    if (!targetInstance && listeningPort === 80) {
      targetInstance = sanitizeInstanceName(hostname ? hostname.split('.')[0] : 'Unknown');
      targetPort = listeningPort;
      console.log('Using default HTTP port configuration:', targetInstance, targetPort);
    } else if (!targetInstance && listeningPort === 443) {
      targetInstance = sanitizeInstanceName(hostname ? hostname.split('.')[0] : 'Unknown');
      targetPort = listeningPort;
      console.log('Using default HTTPS port configuration:', targetInstance, targetPort);
    }

    if (!targetInstance) {
      // Could not determine target
      log('warn', `No target instance found for port ${listeningPort}`);
      if (isTLS) {
        sendNotFoundSocket(socket, 'Unknown', true);
      } else {
        sendNotFoundSocket(socket, 'Unknown', false);
      }
      socket.end();
      return;
    }

    const targetIP = await resolveInstanceIP(targetInstance);

    if (!targetIP) {
      if (isTLS) {
        sendNotFoundSocket(socket, targetInstance, true);
      } else {
        sendNotFoundSocket(socket, targetInstance, false);
      }
      socket.end();
      return;
    }

    // Determine the target host and port
    const targetHost = `${targetIP}:${targetPort}`;

    log('info', `Forwarding ${isTLS ? 'HTTPS' : 'HTTP'} traffic for "${targetInstance}" to ${targetHost}`);

    if (isTLS) {
      // SSL Passthrough
      const backendSocket = net.connect(targetPort, targetIP, () => {
        socket.pipe(backendSocket);
        backendSocket.pipe(socket);
      });

      backendSocket.on('error', (err) => {
        handleSocketError(socket, err, targetHost, true);
        backendSocket.end();
        socket.end();
      });

      socket.on('error', (err) => {
        log('error', `Client socket error: ${err.message}`);
        backendSocket.end();
      });

      // Push the initial data chunk to the backend
      backendSocket.write(buffer);
    } else {
      // HTTP Proxying
      handleHttpProxy(socket, buffer, targetIP, targetPort);
    }

    // Remove the data listener after handling the first chunk
    socket.removeListener('data', onData);
  };

  socket.on('data', onData);
}

function startTcpProxy(config) {
  const { instances = {}, globalPorts = [], localIP } = config.mac;
  console.log('Starting TCP proxy with config:', {
    instances: Object.keys(instances),
    globalPorts,
    localIP
  });
  
  // Get all instance-specific ports
  const instancePorts = Object.values(instances)
    .flatMap(instance => instance.ports || []);

  // Standard ports that should always be included
  const standardPorts = [80, 443];

  const portsToListen = Array.from(new Set([...standardPorts, ...globalPorts, ...instancePorts]));
  console.log('Ports to listen on:', portsToListen);

  // Start listening on all determined ports
  portsToListen.forEach(port => {
    // Create a new server for each port
    const tcpServer = net.createServer((socket) => {
      handleConnection(socket, config);
    });

    tcpServer.listen(port, () => {
      log('info', `TCP proxy listening on port ${port}`);
    });

    tcpServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        log('error', `Port ${port} is already in use`);
      } else {
        log('error', `Error on port ${port}: ${err.message}`);
      }
    });
  });
}

// Start both HTTP and TCP proxies
function startProxies(config) {
  // Start the TCP proxy to handle both HTTP and HTTPS
  startTcpProxy(config);
}

// Only start the servers if this file is run directly
if (require.main === module) {
  startProxies(config);
}

module.exports = {
  startProxies,
  resolveInstanceIP, // Exported for testing
};