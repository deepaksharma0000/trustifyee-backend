/**
 * PM2 Ecosystem Configuration — Production Grade
 *
 * Deploy:
 *   pm2 start ecosystem.config.js --env production
 *   pm2 save
 *   pm2 startup
 *
 * Logs:
 *   pm2 logs trustifyee-backend
 *   pm2 monit
 */
module.exports = {
  apps: [
    {
      name: "trustifyee-api",
      script: "dist/index.js",
      cwd: "./",
      instances: 1,
      exec_mode: "fork",
      node_args: "--max-old-space-size=1024",
      env_production: {
        NODE_ENV: "production",
        PORT: 5000,
        PROCESS_ROLE: "api",
      },
      autorestart: true,
      watch: false,
      max_memory_restart: "900M",
      restart_delay: 5000,
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      kill_timeout: 15000,
      listen_timeout: 10000,
      log_date_format: "YYYY-MM-DD HH:mm:ss.SSS Z",
      out_file: "./logs/pm2-api-out.log",
      error_file: "./logs/pm2-api-error.log",
      merge_logs: true,
      cron_restart: "30 3 * * *",
      source_map_support: true,
      env: {
        NODE_ENV: "production",
        PROCESS_ROLE: "api",
      },
    },
    {
      name: "trustifyee-workers",
      script: "dist/index.js",
      cwd: "./",
      instances: 1,
      exec_mode: "fork",
      node_args: "--max-old-space-size=768",
      env_production: {
        NODE_ENV: "production",
        PROCESS_ROLE: "workers",
      },
      autorestart: true,
      watch: false,
      max_memory_restart: "700M",
      restart_delay: 5000,
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      kill_timeout: 15000,
      log_date_format: "YYYY-MM-DD HH:mm:ss.SSS Z",
      out_file: "./logs/pm2-workers-out.log",
      error_file: "./logs/pm2-workers-error.log",
      merge_logs: true,
      env: {
        NODE_ENV: "production",
        PROCESS_ROLE: "workers",
      },
    },
    {
      name: "trustifyee-backend",
      script: "dist/index.js",
      cwd: "./",
      instances: 1,
      exec_mode: "fork",
      node_args: "--max-old-space-size=1024",
      env_production: {
        NODE_ENV: "production",
        PORT: 5000,
        PROCESS_ROLE: "all",
      },

      // Restart Policy
      autorestart: true,
      watch: false,          // Never watch in production — causes restart loops
      max_memory_restart: "900M",

      // Restart delay — prevents rapid restart loops on boot failures
      restart_delay: 5000,

      // Exponential backoff restart — critical for preventing Angel One AB1008 lockout
      // from rapid re-logins during crash loops
      exp_backoff_restart_delay: 100,
      max_restarts: 10,       // After 10 restarts, PM2 stops auto-restarting

      // Graceful shutdown — let BullMQ workers drain their current job before exit
      kill_timeout: 15000,    // 15 seconds for graceful shutdown
      listen_timeout: 10000,  // Wait 10s for the server to start listening

      // Log Configuration
      log_date_format: "YYYY-MM-DD HH:mm:ss.SSS Z",
      out_file: "./logs/pm2-out.log",
      error_file: "./logs/pm2-error.log",
      merge_logs: true,

      // Log rotation (requires pm2-logrotate module: pm2 install pm2-logrotate)
      log_type: "json",

      // Health monitoring — PM2 will restart if /health returns non-2xx
      // Uncomment after confirming health endpoint works
      // health_check_interval: 30000,
      // health_check_http: { url: "http://localhost:5000/health", timeout: 5000 },

      // Cron restart — daily restart at 3:30 AM IST to clear memory leaks
      // Angel One sessions naturally expire at midnight IST, so 3:30 AM ensures
      // all token refresh cycles complete before market opens at 9:15 AM
      cron_restart: "30 3 * * *",

      // Source map support for TypeScript stack traces in production logs
      source_map_support: true,

      // Environment variables passed to the process
      env: {
        NODE_ENV: "production",
        PROCESS_ROLE: "all",
      },
    },
  ],
};
