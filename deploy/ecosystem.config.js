// deploy/ecosystem.config.js
//
// PRODUCTION DEPLOYMENT — PM2 process supervisor config.
//
// Runs the app as a managed, auto-restarting process (crash recovery,
// log rotation via pm2-logrotate, `pm2 reload` for zero-downtime
// restarts). This is AUTOMATED tooling (checked into the repo), but
// starting/enabling it on the actual server is a MANUAL step — see
// DEPLOYMENT.md "Deployment commands".
//
// Single instance ("fork" mode), not cluster mode: the tenant
// connection manager (src/services/tenantConnectionManager.js) caches
// per-tenant Sequelize connections in an in-process Map. Cluster mode
// would give each worker its own disjoint cache and its own idle-sweep
// timer, multiplying tenant DB connections per tenant by the worker
// count with no coordination between workers. If horizontal scaling is
// needed later, scale by running this same app on multiple SEPARATE
// hosts/containers behind the load balancer, not via PM2 cluster mode
// on one host.
module.exports = {
  apps: [
    {
      name: "procur-backend",
      script: "src/app.js",
      cwd: __dirname + "/..",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      min_uptime: "30s",
      watch: false,
      env_production: {
        NODE_ENV: "production",
      },
      out_file: "logs/out.log",
      error_file: "logs/error.log",
      merge_logs: true,
      time: true,
    },
  ],
};
