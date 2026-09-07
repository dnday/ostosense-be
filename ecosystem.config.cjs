module.exports = {
  apps: [{
    name: 'ostosense-api',
    script: 'dist/main.js',
    cwd: __dirname,
    env: { NODE_ENV: 'production' },
  }],
};
