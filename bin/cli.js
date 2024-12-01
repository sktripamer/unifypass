#!/usr/bin/env node

const { program } = require('commander');
const pm2 = require('pm2');
const path = require('path');
const fs = require('fs');
const sudo = require('sudo-prompt');
const { defaultConfig } = require('../config');

// Initialize PM2
const initPM2 = () => {
  return new Promise((resolve, reject) => {
    pm2.connect((err) => {
      if (err) {
        console.error('Error connecting to PM2:', err);
        reject(err);
        return;
      }
      resolve();
    });
  });
};

// Start a process with PM2
const startPM2Process = (name, script, args = []) => {
  return new Promise((resolve, reject) => {
    pm2.start({
      script,
      name,
      args,
      watch: false,
      env: {
        NODE_ENV: 'production'
      }
    }, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
};

// Stop a PM2 process
const stopPM2Process = (name) => {
  return new Promise((resolve, reject) => {
    pm2.delete(name, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
};

// Check if unifypass is running
const isRunning = () => {
  return new Promise((resolve) => {
    pm2.list((err, list) => {
      if (err) {
        resolve(false);
        return;
      }
      resolve(list.some(proc => proc.name === 'unifypass-dns' || proc.name === 'unifypass-proxy'));
    });
  });
};

// Check if running with sudo
const isSudo = () => {
  return process.getuid && process.getuid() === 0;
};

// Request sudo if needed
const requestSudo = (command) => {
  return new Promise((resolve, reject) => {
    if (isSudo()) {
      resolve();
      return;
    }

    const options = {
      name: 'UnifyPass',
    };

    const fullCommand = `${process.execPath} ${command}`;
    
    sudo.exec(fullCommand, options, (error, stdout, stderr) => {
      if (error) {
        console.error('Sudo error:', error);
        console.error('Stderr:', stderr);
        reject(new Error('Failed to get sudo permissions'));
        return;
      }
      resolve(stdout);
    });
  });
};

program
  .name('unifypass')
  .description('UnifyPass - Access Multipass instances via local domains on MacOS')
  .version('1.0.0');

// Process management commands
program
  .command('start')
  .description('Start UnifyPass in the background')
  .action(async () => {
    try {
      console.log('UnifyPass needs admin privileges to set up DNS. Requesting sudo access...');
      
      // Get the full path to the current script
      const scriptPath = path.join(__dirname, 'cli.js');
      const args = process.argv.slice(2).join(' ');
      
      if (!isSudo()) {
        await requestSudo(`${scriptPath} ${args}`);
        return;
      }

      await initPM2();
      const isAlreadyRunning = await isRunning();
      
      if (isAlreadyRunning) {
        console.error('UnifyPass is already running. Use "unifypass logs" to view logs or "unifypass stop" to stop it.');
        process.exit(1);
      }

      // Start DNS server
      const dnsServerPath = path.join(__dirname, '..', 'dns-server.js');
      await startPM2Process('unifypass-dns', dnsServerPath);
      
      // Start reverse proxy
      const proxyServerPath = path.join(__dirname, '..', 'reverse-proxy.js');
      await startPM2Process('unifypass-proxy', proxyServerPath);
      
      console.log('UnifyPass started successfully! DNS and reverse proxy are running.');
    } catch (error) {
      console.error('Failed to start UnifyPass:', error.message);
      process.exit(1);
    }
  });

program
  .command('stop')
  .description('Stop UnifyPass')
  .action(async () => {
    try {
      await initPM2();
      await stopPM2Process('unifypass-dns');
      await stopPM2Process('unifypass-proxy');
      console.log('UnifyPass stopped.');
      pm2.disconnect();
    } catch (err) {
      console.error('Failed to stop UnifyPass:', err);
      process.exit(1);
    }
  });

program
  .command('restart')
  .description('Restart UnifyPass')
  .action(async () => {
    try {
      await initPM2();
      if (!(await isRunning())) {
        console.error('UnifyPass is not running. Use "unifypass start" to start it.');
        process.exit(1);
      }
      await stopPM2Process('unifypass-dns');
      await stopPM2Process('unifypass-proxy');
      const dnsServerPath = path.join(__dirname, '..', 'dns-server.js');
      await startPM2Process('unifypass-dns', dnsServerPath);
      const proxyServerPath = path.join(__dirname, '..', 'reverse-proxy.js');
      await startPM2Process('unifypass-proxy', proxyServerPath);
      console.log('UnifyPass restarted.');
      pm2.disconnect();
    } catch (err) {
      console.error('Failed to restart UnifyPass:', err);
      process.exit(1);
    }
  });

program
  .command('logs')
  .description('Show UnifyPass logs')
  .option('-f, --follow', 'Follow log output')
  .action(async (options) => {
    try {
      await initPM2();
      if (!(await isRunning())) {
        console.error('UnifyPass is not running. Use "unifypass start" to start it.');
        process.exit(1);
      }
      const logs = await pm2.logs('unifypass-dns', { err: options.follow ? 'pipe' : 'ignore' });
      if (options.follow) {
        logs.stdout.on('data', (data) => {
          console.log(data.toString());
        });
        logs.stderr.on('data', (data) => {
          console.error(data.toString());
        });
      } else {
        console.log(logs.stdout.toString());
        console.error(logs.stderr.toString());
      }
      pm2.disconnect();
    } catch (err) {
      console.error('Failed to show UnifyPass logs:', err);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show UnifyPass status')
  .action(async () => {
    try {
      await initPM2();
      if (!(await isRunning())) {
        console.log('UnifyPass is not running.');
        process.exit(1);
      }
      const status = await pm2.describe('unifypass-dns');
      console.log(status);
      pm2.disconnect();
    } catch (err) {
      console.error('Failed to show UnifyPass status:', err);
      process.exit(1);
    }
  });

// Global options
program
  .option('-p, --proxy-port <port>', 'Set reverse proxy port', defaultConfig.mac.proxyPort)
  .option('-d, --dns-port <port>', 'Set DNS server port', defaultConfig.mac.dnsPort)
  .option('-D, --domain <domain>', 'Set domain suffix', defaultConfig.mac.domain)
  .option('-i, --ip <ip>', 'Override local IP address')
  .option('--ports <ports>', 'Set global ports (comma-separated)', val => val.split(',').map(p => parseInt(p.trim(), 10)))
  .option('--resolver-dir <dir>', 'Set resolver directory', defaultConfig.mac.resolverDir)
  .option('--timeout <ms>', 'Set global timeout in milliseconds', defaultConfig.mac.timeout)
  .option('--daemon', 'Run in background', defaultConfig.mac.daemon)

// Load config
const loadConfig = () => {
  const configPath = path.join(process.cwd(), 'unify.config.js');
  try {
    return require(configPath);
  } catch (error) {
    return defaultConfig;
  }
};

// Save config
const saveConfig = (config) => {
  const configPath = path.join(process.cwd(), 'unify.config.js');
  const configContent = `module.exports = ${JSON.stringify(config, null, 2)};`;
  fs.writeFileSync(configPath, configContent, 'utf8');
};

// Instance configuration command
program
  .command('instance <name>')
  .description('Configure a specific instance')
  .option('-p, --ports <ports>', 'Set instance ports (comma-separated list)')
  .option('--timeout <ms>', 'Set instance timeout in milliseconds')
  .action(async (name, options) => {
    try {
      const config = loadConfig();
      
      // Create instance config if it doesn't exist
      if (!config.mac.instances[name]) {
        config.mac.instances[name] = {
          ports: [],
          timeout: 5000
        };
      }

      // Handle ports
      if (options.ports) {
        const ports = options.ports.split(',').map(p => parseInt(p.trim(), 10));
        if (ports.some(p => isNaN(p))) {
          console.error('Invalid port number provided');
          process.exit(1);
        }
        config.mac.instances[name].ports = ports;
      }

      // Handle timeout
      if (options.timeout) {
        const timeout = parseInt(options.timeout, 10);
        if (isNaN(timeout)) {
          console.error('Invalid timeout value');
          process.exit(1);
        }
        config.mac.instances[name].timeout = timeout;
      }

      // Save config
      saveConfig(config);
      console.log(`Instance "${name}" configured with:`, config.mac.instances[name]);

    } catch (error) {
      console.error('Error configuring instance:', error);
      process.exit(1);
    }
  });

program
  .command('global-ports')
  .description('Configure global ports that work for all instances')
  .option('-p, --ports <ports>', 'Set global ports (comma-separated list)')
  .option('-l, --list', 'List current global ports')
  .option('-r, --remove <ports>', 'Remove ports from global list (comma-separated list)')
  .action(async (options) => {
    try {
      const config = loadConfig();
      
      // Initialize global ports if not exists
      if (!config.mac.globalPorts) {
        config.mac.globalPorts = [];
      }

      if (options.list) {
        console.log('Current global ports:', config.mac.globalPorts);
        return;
      }

      if (options.ports) {
        const ports = options.ports.split(',').map(p => parseInt(p.trim(), 10));
        if (ports.some(p => isNaN(p))) {
          console.error('Invalid port number provided');
          process.exit(1);
        }
        config.mac.globalPorts = Array.from(new Set([...config.mac.globalPorts, ...ports]));
      }

      if (options.remove) {
        const portsToRemove = options.remove.split(',').map(p => parseInt(p.trim(), 10));
        if (portsToRemove.some(p => isNaN(p))) {
          console.error('Invalid port number provided');
          process.exit(1);
        }
        config.mac.globalPorts = config.mac.globalPorts.filter(p => !portsToRemove.includes(p));
      }

      // Save config
      saveConfig(config);
      console.log('Global ports updated:', config.mac.globalPorts);

    } catch (error) {
      console.error('Error configuring global ports:', error);
      process.exit(1);
    }
  });

// Parse command line arguments
program.parse();

const options = program.opts();

// If ports are specified, validate them
if (options.ports) {
  if (options.ports.some(p => isNaN(p) || p < 1 || p > 65535)) {
    console.error('Invalid port number provided. Ports must be between 1 and 65535.');
    process.exit(1);
  }
  // Load current config
  const config = loadConfig();
  // Update the config with the new ports
  config.mac.globalPorts = options.ports;
  // Save the updated config
  saveConfig(config);
}

// If no command is specified and --daemon is true, start in background
if (!process.argv.slice(2).some(arg => ['start', 'stop', 'restart', 'logs', 'status'].includes(arg))) {
  if (options.daemon) {
    initPM2().then(() => {
      if (isRunning()) {
        console.error('UnifyPass is already running. Use "unifypass logs" to view logs or "unifypass stop" to stop it.');
        process.exit(1);
      }
      const dnsServerPath = path.join(__dirname, '..', 'dns-server.js');
      startPM2Process('unifypass-dns', dnsServerPath).then(() => {
        const proxyServerPath = path.join(__dirname, '..', 'reverse-proxy.js');
        startPM2Process('unifypass-proxy', proxyServerPath).then(() => {
          console.log('UnifyPass started in background. Use these commands to manage it:');
          console.log('  unifypass logs    # View logs');
          console.log('  unifypass stop    # Stop the service');
          console.log('  unifypass status  # Check status');
          process.exit(0);
        }).catch((err) => {
          console.error('Failed to start UnifyPass:', err);
          process.exit(1);
        });
      }).catch((err) => {
        console.error('Failed to start UnifyPass:', err);
        process.exit(1);
      });
    }).catch((err) => {
      console.error('Failed to initialize PM2:', err);
      process.exit(1);
    });
  }

  // Create runtime config based on command line options
  const runtimeConfig = {
    mac: {
      ...defaultConfig.mac,
      proxyPort: parseInt(options.proxyPort),
      dnsPort: parseInt(options.dnsPort),
      domain: options.domain,
      resolverDir: options.resolverDir,
      localIP: options.ip || null,
      timeout: parseInt(options.timeout),
      daemon: options.daemon
    }
  };

  // Save runtime config to temp file
  const runtimeConfigPath = path.join(process.cwd(), '.unifypass-runtime.js');
  fs.writeFileSync(runtimeConfigPath, `module.exports = ${JSON.stringify(runtimeConfig, null, 2)};`);
  process.env.UNIFYPASS_RUNTIME_CONFIG = runtimeConfigPath;

  // Run in foreground
  require('../server');

  // Cleanup runtime config on exit
  process.on('exit', () => {
    try {
      fs.unlinkSync(runtimeConfigPath);
    } catch (e) {
      // Ignore cleanup errors
    }
  });
}
