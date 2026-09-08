module.exports = {
  apps: [
    {
      name: 'xeko-runner',
      script: 'start.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '900M',
      restart_delay: 5000,
      kill_timeout: 12000,
      min_uptime: 10000,
      max_restarts: 15,
      time: true,
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
