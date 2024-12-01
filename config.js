const defaultConfig = {
  mac: {
    // DNS settings
    dnsPort: 5355,
    domain: 'multipass',
    
    // Reverse proxy settings
    timeout: 5000,  // Global timeout in ms
    
    // Resolver settings
    resolverDir: '/etc/resolver',
    
    // Optional fixed IP override (if not set, will default to 127.0.0.1)
    localIP: null,

    // Global ports that work for all instances
    globalPorts: [80, 443],

    // Per-instance configurations
    instances: {
      // Example:
      // myinstance: {
      //   ports: [3000, 8080],  // List of ports to proxy to
      //   timeout: 10000        // Override global timeout
      // }
    },

    // Process management
    daemon: false  // Run in background if true
  }
};

function loadConfig() {
  let userConfig = {};
  
  // First try runtime config (from CLI)
  if (process.env.UNIFYPASS_RUNTIME_CONFIG) {
    try {
      return require(process.env.UNIFYPASS_RUNTIME_CONFIG);
    } catch (e) {
      // Fall back to user config if runtime config fails
    }
  }
  
  // Then try user config
  try {
    userConfig = require(process.cwd() + '/unify.config.js');
  } catch (e) {
    // No user config found, using defaults
  }

  // Merge configs with instances and globalPorts being complete overrides
  const instances = userConfig.mac?.instances || defaultConfig.mac.instances;
  const globalPorts = userConfig.mac?.globalPorts || defaultConfig.mac.globalPorts;
  
  return {
    mac: {
      ...defaultConfig.mac,
      ...(userConfig.mac || {}),
      instances, // Override instances completely rather than merging
      globalPorts // Override global ports completely rather than merging
    }
  };
}

module.exports = {
  defaultConfig,
  loadConfig,
};