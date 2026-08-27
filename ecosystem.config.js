module.exports = {
  apps: [{
    name: 'kinobot',
    script: 'index.js',
    instances: 1,
    autorestart: true,
    max_memory_restart: '300M',
    time: true
  }]
};