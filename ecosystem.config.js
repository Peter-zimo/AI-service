module.exports = {
  apps: [
    {
      name: 'ai-cs',
      script: 'server/index.js',
      cwd: 'D:/AI应用/workbuddy files/ai-customer-service',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 3456
      },
      // 日志配置
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-err.log',
      merge_logs: true,
      // 崩溃重启策略：最多连续重启5次
      max_restarts: 5,
      restart_delay: 3000
    }
  ]
};
