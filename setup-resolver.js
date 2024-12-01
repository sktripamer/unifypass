const fs = require('fs');
const { execSync } = require('child_process');
const sudo = require('sudo-prompt');
const { loadConfig } = require('./config');

const config = loadConfig();

const options = {
  name: 'Multipass Resolver Setup',
};

const resolverFile = `${config.mac.resolverDir}/${config.mac.domain}`;
const resolverConfig = `nameserver 127.0.0.1
port ${config.mac.dnsPort}
`;

const setupResolver = () => {
  // Check if we're running as root/sudo
  const isRoot = process.getuid && process.getuid() === 0;
  
  if (!fs.existsSync(resolverFile)) {
    const command = `mkdir -p ${config.mac.resolverDir} && echo "${resolverConfig}" > ${resolverFile}`;
    
    if (isRoot) {
      // If running as sudo, execute directly
      try {
        execSync(command);
        console.log(`Resolver configuration created at ${resolverFile}`);
      } catch (error) {
        console.error('Failed to set up resolver:', error.message);
        process.exit(1);
      }
    } else {
      // If not running as sudo, use sudo-prompt
      sudo.exec(command, options, (error) => {
        if (error) {
          console.error('Failed to set up resolver:', error);
          process.exit(1);
        } else {
          console.log(`Resolver configuration created at ${resolverFile}`);
        }
      });
    }
  } else {
    console.log('Resolver configuration already exists.');
  }
};

// If this script is run directly (not required as a module)
if (require.main === module) {
  setupResolver();
}

module.exports = { setupResolver };