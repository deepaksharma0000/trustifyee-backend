const path = require("path");

module.exports = {
  apps: [
    {
      name: "trustifyee-backend",
      script: "dist/index.js",
      cwd: path.resolve(__dirname, ".."),
      env_file: path.resolve(__dirname, "../.env"),
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "700M",
      min_uptime: "20s",
      restart_delay: 3000,
      kill_timeout: 10000,
      listen_timeout: 10000,
      env: {
        NODE_ENV: "production",
        TZ: "Asia/Kolkata",
        NODE_OPTIONS: "--dns-result-order=ipv4first",
        FORCE_SHARED_VPS_ROUTE: "true"
      },
      error_file: "./logs/pm2-error.log",
      out_file: "./logs/pm2-out.log",
      merge_logs: true,
      time: true
    }
  ]
};
