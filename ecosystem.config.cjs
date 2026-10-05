/**
 * PM2 configuration.
 *
 *   npm run build
 *   npx pm2 start ecosystem.config.cjs
 *   npx pm2 save
 *
 * The app binds to 127.0.0.1 by default, which is correct when nginx (or
 * another reverse proxy) terminates TLS and proxies to it. To serve the app
 * directly, start pm2 with CHATA_HOSTNAME=0.0.0.0.
 */
// Do not use the generic HOSTNAME environment variable here: Linux/systemd
// commonly sets it to the machine name, which is not necessarily a bindable
// interface. Use an app-specific override and default to loopback for nginx.
const hostname = process.env.CHATA_HOSTNAME || "127.0.0.1";
const port = process.env.PORT || "8010";

module.exports = {
  apps: [
    {
      name: "chata",
      cwd: __dirname,
      script: "./node_modules/next/dist/bin/next",
      args: `start --hostname ${hostname} --port ${port}`,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "512M",
      // .env is loaded by Next.js itself; keep secrets out of this file.
      env: {
        NODE_ENV: "production",
      },
      out_file: "./logs/pm2-out.log",
      error_file: "./logs/pm2-error.log",
      merge_logs: true,
      time: true,
    },
  ],
};
