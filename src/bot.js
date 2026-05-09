const { Telegraf } = require('telegraf');
const config = require('./config');
const amocrm = require('./amocrm');
const { userMapping, stageTracking, messageTracking } = require('./db');
const {
  buildStaleMessage,
  makeNotifier,
  escapeMd,
} = require('./notifier');

function build() {
  const bot = new Telegraf(config.telegramToken);
  const notifier = makeNotifier(bot);

  bot.start(async (ctx) => {
    const chatId = ctx.chat.id;
    await ctx.reply(
      `Привет!\n` +
        `Это amo-tg-bot — уведомляет о зависших лидах и пропущенных сообщениях.\n\n` +
        `Ваш chat_id: ${chatId}\n\n` +
        `Чтобы получать уведомления, привяжите свой amoCRM user_id командой:\n` +
        `/addme <amo_user_id>`
    );
  });

  bot.command('addme', async (ctx) => {
    const parts = (ctx.message.text || '').trim().split(/\s+/);
    const amoId = parseInt(parts[1], 10);
    if (!amoId) {
      return ctx.reply('Использование: /addme <amo_user_id>');
    }
    const name =
      (ctx.from && (ctx.from.first_name || '') + ' ' + (ctx.from.last_name || '')).trim() ||
      ctx.from.username ||
      '';
    userMapping.upsert(amoId, ctx.chat.id, name);
    await ctx.reply(`✅ Сохранено: amo_user_id=${amoId} → chat_id=${ctx.chat.id}`);
  });

  bot.command('whoami', async (ctx) => {
    const m = userMapping.byChatId(ctx.chat.id);
    if (!m) {
      return ctx.reply(
        `Вы не привязаны.\nВаш chat_id: ${ctx.chat.id}\nИспользуйте /addme <amo_user_id>`
      );
    }
    await ctx.reply(
      `amo_user_id: ${m.amo_user_id}\nchat_id: ${m.telegram_chat_id}\nИмя: ${m.name || '—'}`
    );
  });

  bot.command('list', async (ctx) => {
    const list = userMapping.list();
    if (!list.length) return ctx.reply('Пока никто не привязан.');
    const lines = list.map(
      (m) => `• amo=${m.amo_user_id} → tg=${m.telegram_chat_id}  ${m.name || ''}`
    );
    await ctx.reply(`Активные привязки:\n${lines.join('\n')}`);
  });

  bot.command('status', async (ctx) => {
    const text =
      `📊 Статус\n\n` +
      `Лидов в трекинге этапов: ${stageTracking.count()}\n` +
      `Неотвеченных сообщений: ${messageTracking.count()}\n` +
      `Привязанных пользователей: ${userMapping.count()}\n\n` +
      `⏱️ Пороги:\n` +
      `  STALE_LEAD_MINUTES = ${config.staleLeadMinutes}\n` +
      `  UNANSWERED_MESSAGE_MINUTES = ${config.unansweredMessageMinutes}\n` +
      `  CRON_INTERVAL_MINUTES = ${config.cronIntervalMinutes}\n` +
      `  NOTIFICATION_COOLDOWN_MINUTES = ${config.notificationCooldownMinutes}\n\n` +
      `🎯 Stages:\n` +
      `  monitored: ${config.monitoredStageIds.join(',') || '(все)'}\n` +
      `  ignored: ${config.ignoredStageIds.join(',') || '—'}`;
    await ctx.reply(text);
  });

  bot.command('test', async (ctx) => {
    const parts = (ctx.message.text || '').trim().split(/\s+/);
    const leadId = parseInt(parts[1], 10);
    if (!leadId) return ctx.reply('Использование: /test <lead_id>');

    const info = await amocrm.getLeadFullInfo(leadId);
    if (!info) {
      return ctx.reply(`❌ Не удалось получить лид ${leadId} из amoCRM`);
    }

    const text = buildStaleMessage({
      leadId,
      stageName: info.stageName,
      leadName: info.lead.name || info.contactName || '',
      phone: info.phone,
      enteredAt: info.lead.updated_at || info.lead.created_at || Math.floor(Date.now() / 1000),
      hasOpenTask: info.hasOpenTask,
    });

    const ok = await notifier.sendToChat(ctx.chat.id, text, {
      lead_id: leadId,
      type: 'test',
    });
    if (!ok) await ctx.reply('❌ Не удалось отправить тестовое уведомление');
  });

  bot.on('message', async (ctx, next) => {
    if (ctx.message.text && ctx.message.text.startsWith('/')) return next();
    const m = userMapping.byChatId(ctx.chat.id);
    if (!m) {
      await ctx.reply(
        `Вы пока не привязаны к amoCRM-пользователю.\n` +
          `Ваш chat_id: ${ctx.chat.id}\n` +
          `Привяжите аккаунт: /addme <amo_user_id>`
      );
    }
  });

  bot.catch((err, ctx) => {
    console.error(`❌ Bot error in update ${ctx && ctx.updateType}: ${err.message}`);
  });

  return { bot, notifier };
}

module.exports = { build };
