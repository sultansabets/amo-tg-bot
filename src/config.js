require('dotenv').config();

const required = ['TELEGRAM_BOT_TOKEN', 'AMO_DOMAIN'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`❌ Missing required env: ${key}`);
    process.exit(1);
  }
}

const intEnv = (key, def) => {
  const v = parseInt(process.env[key], 10);
  return Number.isFinite(v) ? v : def;
};

const listEnv = (key) =>
  (process.env[key] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseInt(s, 10))
    .filter(Number.isFinite);

module.exports = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,

  amo: {
    domain: process.env.AMO_DOMAIN,
    clientId: process.env.AMO_CLIENT_ID || '',
    clientSecret: process.env.AMO_CLIENT_SECRET || '',
    redirectUri: process.env.AMO_REDIRECT_URI || '',
    accessToken: process.env.AMO_ACCESS_TOKEN || '',
    refreshToken: process.env.AMO_REFRESH_TOKEN || '',
  },

  port: intEnv('PORT', 3000),
  webhookSecret: process.env.WEBHOOK_SECRET || 'changeme',

  staleLeadMinutes: intEnv('STALE_LEAD_MINUTES', 60),
  unansweredMessageMinutes: intEnv('UNANSWERED_MESSAGE_MINUTES', 15),
  cronIntervalMinutes: intEnv('CRON_INTERVAL_MINUTES', 10),
  notificationCooldownMinutes: intEnv('NOTIFICATION_COOLDOWN_MINUTES', 60),

  monitoredStageIds: listEnv('MONITORED_STAGE_IDS'),
  ignoredStageIds: listEnv('IGNORED_STAGE_IDS'),

  timezone: 'Asia/Almaty',
};
