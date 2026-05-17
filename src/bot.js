const { Telegraf, Markup } = require('telegraf');
const config = require('./config');
const settings = require('./settings');
const amocrm = require('./amocrm');
const scheduler = require('./scheduler');
const settingsUI = require('./settingsUI');
const { userMapping, stageTracking, messageTracking, db, adminChats } = require('./db');
const {
  buildStaleMessage,
  makeNotifier,
  escapeMd,
  buildLeadUrl,
} = require('./notifier');

function build() {
  const bot = new Telegraf(config.telegramToken);
  const notifier = makeNotifier(bot);

  bot.start(async (ctx) => {
    const chatId = ctx.chat.id;
    await ctx.reply(
      `👋 Привет!\n\n` +
        `Я amo-tg-bot. Я слежу за лидами в amoCRM и пишу менеджеру, ` +
        `когда лид завис на этапе или клиент остался без ответа.\n\n` +
        `🆔 Ваш chat_id: ${chatId}\n\n` +
        `Чтобы получать уведомления — привяжите свой amoCRM user_id:\n` +
        `/addme <amo_user_id>\n\n` +
        `📘 Полная справка: /help`
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

    if (config.adminAmoUserIds.includes(amoId)) {
      // Admin path: many telegram chats may share the same amo_user_id
      adminChats.upsert(ctx.chat.id, amoId, name);
      // Make sure this chat isn't also tracked as a manager
      db.prepare('DELETE FROM user_mapping WHERE telegram_chat_id = ?').run(ctx.chat.id);
      return ctx.reply(
        `✅ Ты зарегистрирован как администратор. Будешь получать уведомления по всем менеджерам.`
      );
    }

    // Manager path
    userMapping.upsert(amoId, ctx.chat.id, name, 'manager');
    adminChats.remove(ctx.chat.id);
    await ctx.reply(
      `✅ Ты зарегистрирован как менеджер. Будешь получать уведомления только по своим лидам.`
    );
  });

  bot.command('whoami', async (ctx) => {
    const a = adminChats.byChatId(ctx.chat.id);
    if (a) {
      return ctx.reply(
        `amo_user_id: ${a.amo_user_id}\nchat_id: ${a.telegram_chat_id}\nИмя: ${a.name || '—'}\nРоль: админ 🔑`
      );
    }
    const m = userMapping.byChatId(ctx.chat.id);
    if (!m) {
      return ctx.reply(
        `Вы не привязаны.\nВаш chat_id: ${ctx.chat.id}\nИспользуйте /addme <amo_user_id>`
      );
    }
    await ctx.reply(
      `amo_user_id: ${m.amo_user_id}\nchat_id: ${m.telegram_chat_id}\nИмя: ${m.name || '—'}\nРоль: менеджер`
    );
  });

  bot.command('list', async (ctx) => {
    const managers = userMapping.list();
    const admins = adminChats.list();

    if (!managers.length && !admins.length) return ctx.reply('Пока никто не привязан.');

    const lines = [];
    for (const a of admins) {
      const name = a.name || '—';
      lines.push(
        `🔑 ${name} — amo: ${a.amo_user_id} → tg: ${a.telegram_chat_id} — админ`
      );
    }
    for (const m of managers) {
      const name = m.name || '—';
      lines.push(
        `👤 ${name} — amo: ${m.amo_user_id} → tg: ${m.telegram_chat_id} — менеджер`
      );
    }

    await ctx.reply(`👥 Зарегистрированные пользователи:\n${lines.join('\n')}`);
  });

  bot.command('status', async (ctx) => {
    const s = settings.snapshot();
    const text =
      `📊 Статус\n\n` +
      `Лидов в трекинге этапов: ${stageTracking.count()}\n` +
      `Неотвеченных сообщений: ${messageTracking.count()}\n` +
      `Менеджеров: ${userMapping.count()}\n` +
      `Админов: ${adminChats.count()}\n\n` +
      `⏱️ Пороги:\n` +
      `  STALE_LEAD_MINUTES = ${s.STALE_LEAD_MINUTES}\n` +
      `  UNANSWERED_MESSAGE_MINUTES = ${s.UNANSWERED_MESSAGE_MINUTES}\n` +
      `  CRON_INTERVAL_MINUTES = ${s.CRON_INTERVAL_MINUTES}\n` +
      `  NOTIFICATION_COOLDOWN_MINUTES = ${s.NOTIFICATION_COOLDOWN_MINUTES}\n\n` +
      `🎯 Stages:\n` +
      `  monitored: ${s.MONITORED_STAGE_IDS.join(',') || '(все)'}\n` +
      `  ignored: ${s.IGNORED_STAGE_IDS.join(',') || '—'}\n\n` +
      `Изменить настройки: /settings`;
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

    const res = await notifier.sendToChat(ctx.chat.id, text, {
      lead_id: leadId,
      type: 'test',
    });
    if (!res || !res.ok) await ctx.reply('❌ Не удалось отправить тестовое уведомление');
  });

  function isAdminChat(chatId) {
    return Boolean(adminChats.byChatId(chatId));
  }

  bot.command('report', async (ctx) => {
    if (!isAdminChat(ctx.chat.id)) {
      return ctx.reply('⛔ Недостаточно прав');
    }

    const managers = userMapping.listManagers();
    if (!managers.length) {
      return ctx.reply('❌ Нет зарегистрированных менеджеров');
    }

    const buttons = [[Markup.button.callback('📋 Общий по всем', 'report_all')]];
    for (const m of managers) {
      buttons.push([
        Markup.button.callback(
          `👤 ${m.name || `amo=${m.amo_user_id}`}`,
          `report_manager_${m.amo_user_id}`
        ),
      ]);
    }

    await ctx.reply('Выберите отчёт:', Markup.inlineKeyboard(buttons));
  });

  // ----- Admin settings (interactive UI) -----
  const ui = settingsUI.register(bot, isAdminChat);

  bot.action('report_all', async (ctx) => {
    try {
      if (!isAdminChat(ctx.chat.id)) {
        await ctx.answerCbQuery('⛔ Недостаточно прав', { show_alert: true });
        return;
      }

      const managers = userMapping.listManagers();
      const lines = ['📊 Общий отчёт — необработанные лиды', ''];

      const leadsByManager = db
        .prepare(
          `SELECT lead_id, responsible_user_id FROM stage_tracking ORDER BY entered_at`
        )
        .all();

      for (const m of managers) {
        const list = leadsByManager.filter(
          (r) => r.responsible_user_id === m.amo_user_id
        );
        if (!list.length) {
          lines.push(`👤 ${m.name || 'amo=' + m.amo_user_id} (0): ✅ чисто`);
        } else {
          lines.push(`👤 ${m.name || 'amo=' + m.amo_user_id} (${list.length}):`);
          for (const row of list) {
            lines.push(buildLeadUrl(row.lead_id));
          }
        }
        lines.push('');
      }

      await ctx.reply(lines.join('\n').trim(), {
        link_preview_options: { is_disabled: true },
      });
      await ctx.answerCbQuery();
    } catch (err) {
      console.error(`❌ report_all failed: ${err.message}`);
      try {
        await ctx.answerCbQuery('Ошибка');
      } catch (_) {}
    }
  });

  bot.action(/^report_manager_(\d+)$/, async (ctx) => {
    try {
      if (!isAdminChat(ctx.chat.id)) {
        await ctx.answerCbQuery('⛔ Недостаточно прав', { show_alert: true });
        return;
      }
      const amoUserId = parseInt(ctx.match[1], 10);
      const m = userMapping.byAmoId(amoUserId);
      const managerName = (m && m.name) || `amo=${amoUserId}`;

      const list = db
        .prepare(
          `SELECT lead_id FROM stage_tracking WHERE responsible_user_id = ? ORDER BY entered_at`
        )
        .all(amoUserId);

      let text;
      if (!list.length) {
        text = `📊 ${managerName} — ✅ необработанных нет`;
      } else {
        const urls = list.map((r) => buildLeadUrl(r.lead_id));
        text = `📊 ${managerName} (${list.length}):\n${urls.join('\n')}`;
      }
      await ctx.reply(text, { link_preview_options: { is_disabled: true } });
      await ctx.answerCbQuery();
    } catch (err) {
      console.error(`❌ report_manager failed: ${err.message}`);
      try {
        await ctx.answerCbQuery('Ошибка');
      } catch (_) {}
    }
  });

  bot.on('message', async (ctx, next) => {
    if (ctx.message.text && ctx.message.text.startsWith('/')) return next();

    // Pending "custom value" flow in /settings menu
    if (isAdminChat(ctx.chat.id) && ui && ui.maybeHandleCustomInput) {
      const handled = await ui.maybeHandleCustomInput(ctx);
      if (handled) return;
    }

    if (isAdminChat(ctx.chat.id)) return;
    const m = userMapping.byChatId(ctx.chat.id);
    if (!m) {
      await ctx.reply(
        `Вы пока не привязаны к amoCRM-пользователю.\n` +
          `Ваш chat_id: ${ctx.chat.id}\n` +
          `Привяжите аккаунт: /addme <amo_user_id>\n\n` +
          `Если не знаете свой amo_user_id — спросите у админа или используйте /help`
      );
    }
  });

  bot.catch((err, ctx) => {
    console.error(`❌ Bot error in update ${ctx && ctx.updateType}: ${err.message}`);
  });

  return { bot, notifier };
}

module.exports = { build };
