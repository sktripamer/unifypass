# UnifyPass

Get Multipass instances with local domains on macOS. One command to get up and running:

```bash
npm install -g unifypass
sudo unifypass start
```

Now try accessing your instance with http://my-multipass-instance.multipass

By default, ports 80 and 443 are used. Need a specific port? Try this:
```bash
sudo unifypass start --ports 8010,8011 # Comma-separated
```

Now you can access http://my-multipass-instance.multipass:8010

NOTE: Heavy WIP, but the basic start/stop/configs should be working.

## Features

- **Automatic Resolution**: Easy way to permanently access Multipass instances via `instancename.multipass`
- **HTTP/HTTPS Support**: Automatic protocol detection and SSL passthrough
- **WebSocket Support**: Full WebSocket proxy support
- **Process Management**: Run as a daemon with PM2

## Installation

```bash
npm install -g unifypass
```

## Quick Start

1. Start UnifyPass:
```bash
sudo unifypass start
```

2. Access your instances:
```
http://myinstance.multipass   # HTTP
https://myinstance.multipass  # HTTPS (if your instance uses SSL)
```

## Configuration

Create `unify.config.js` in your home directory:

```javascript
module.exports = {
  mac: {
    // DNS settings
    dnsPort: 5355,
    domain: 'multipass', // Setting to local can cause issues
    
    // Proxy settings
    timeout: 5000,  // Global timeout in ms
    
    // Instance configurations
    instances: {
      'instancename': {
        port: 3000,      // Custom port (default: 80 for HTTP, 443 for HTTPS)
        timeout: 10000   // Instance-specific timeout
      }
    }
  }
};
```

## SSL Support

SSL works automatically:

- HTTP traffic is proxied normally
- HTTPS traffic is passed through to your instance
- No configuration needed in UnifyPass

To use SSL:
1. Configure SSL in your instance/application
2. Access via `https://instancename.multipass`

## Commands

```bash
# Start UnifyPass
unifypass start

# Start as daemon
unifypass start --daemon

# Stop UnifyPass
unifypass stop

# View logs
unifypass logs

# View status
unifypass status

# Configure instance
unifypass instance myapp --port 3000
```

## Troubleshooting

### Common Issues

1. **Connection Refused**
   - Check if your instance is running
   - Verify the port configuration
   - Ensure your app is listening on all interfaces (0.0.0.0)

2. **DNS Resolution**
   - Run `sudo unifypass setup` to configure DNS resolver
   - Check `/etc/resolver/local` exists
   - Flush DNS cache: `sudo killall -HUP mDNSResponder`

3. **SSL Issues**
   - Ensure your instance has SSL properly configured
   - Check your SSL certificates are valid
   - Verify your app is listening on HTTPS

Need help? [Open an issue](https://github.com/sktripamer/unifypass/issues)
