const express = require('express');
const config = require('./config');
const { build: buildBot } = require('./bot');
const { buildRouter } = require('./webhook');
const scheduler = require('./scheduler');

async function main() {
  const { bot, notifier } = buildBot();

  const app = express();
  app.disable('x-powered-by');
  app.use(buildRouter());

  app.listen(config.port, () => {
    console.log(`✅ HTTP server listening on :${config.port}`);
    console.log(
      `   Webhook URL: http://<host>:${config.port}/amo/webhook/${config.webhookSecret}`
    );
    console.log(
      `   OAuth callback: http://<host>:${config.port}/amo/oauth`
    );
  });

  bot.launch().then(() => {
    console.log('✅ Telegram bot started (long polling)');
  }).catch((err) => {
    console.error(`❌ Failed to start Telegram bot: ${err.message}`);
    process.exit(1);
  });

  scheduler.start(notifier);

  const shutdown = (sig) => {
    console.log(`\n${sig} received, shutting down…`);
    try { bot.stop(sig); } catch (_) {}
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(`❌ Fatal: ${err.message}`);
  process.exit(1);
});
