// Interactive settings UI for Telegram admins.
// All actions go through inline keyboard callbacks plus a small per-chat
// "pending custom input" state for free-form values (e.g. typing a custom
// number of minutes).

const { Markup } = require('telegraf');
const settings = require('./settings');
const amocrm = require('./amocrm');
const scheduler = require('./scheduler');

// Human-readable labels and friendly descriptions for each setting key.
const META = {
  STALE_LEAD_MINUTES: {
    label: '⏰ Когда считать лид зависшим',
    short: 'Зависший лид',
    unit: 'минут',
    presets: [30, 60, 120, 180, 360, 720],
    help:
      'Если лид находится в одном этапе дольше указанного времени и в нём ' +
      'ничего не происходит, бот пингует менеджера. Меньше значение — раньше ' +
      'алёрт. Часто используют 60–360 (1–6 часов).',
  },
  UNANSWERED_MESSAGE_MINUTES: {
    label: '💬 Когда напомнить о неотвеченном клиенте',
    short: 'Неотвеченное сообщение',
    unit: 'минут',
    presets: [5, 10, 15, 30, 60, 120],
    help:
      'Клиент написал или позвонил, менеджер не ответил в течение указанного ' +
      'времени — бот шлёт алёрт. Обычно ставят 5–15 минут — клиенту важна ' +
      'быстрая реакция.',
  },
  CRON_INTERVAL_MINUTES: {
    label: '🔄 Как часто бот проверяет',
    short: 'Интервал проверки',
    unit: 'минут',
    presets: [1, 5, 10, 15, 30],
    help:
      'Каждые N минут бот пробегает по всем отслеживаемым лидам и шлёт ' +
      'просроченные алёрты. Меньше — точнее, но больше нагрузка на amoCRM ' +
      'API. 10 минут — разумный дефолт.',
  },
  NOTIFICATION_COOLDOWN_MINUTES: {
    label: '🔁 Минимальная пауза между повторами (на этап)',
    short: 'Cooldown',
    unit: 'минут',
    presets: [15, 30, 60, 180, 360],
    help:
      'Сейчас бот всё равно шлёт только ОДНО уведомление на этап, поэтому ' +
      'этот параметр почти не используется. Оставьте 60 — это безопасный ' +
      'дефолт.',
  },
};

// Pending input map: chat_id → { key, message_id_of_prompt }
const pendingInput = new Map();

function escapeMd(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

function mainText() {
  const s = settings.snapshot();
  return (
    `⚙️ *Настройки бота*\n\n` +
    `${META.STALE_LEAD_MINUTES.label}\n` +
    `  Сейчас: *${s.STALE_LEAD_MINUTES} мин* \\(${formatMinutes(s.STALE_LEAD_MINUTES)}\\)\n\n` +
    `${META.UNANSWERED_MESSAGE_MINUTES.label}\n` +
    `  Сейчас: *${s.UNANSWERED_MESSAGE_MINUTES} мин* \\(${formatMinutes(s.UNANSWERED_MESSAGE_MINUTES)}\\)\n\n` +
    `${META.CRON_INTERVAL_MINUTES.label}\n` +
    `  Сейчас: *${s.CRON_INTERVAL_MINUTES} мин*\n\n` +
    `${META.NOTIFICATION_COOLDOWN_MINUTES.label}\n` +
    `  Сейчас: *${s.NOTIFICATION_COOLDOWN_MINUTES} мин*\n\n` +
    `🚫 *Игнорируемые этапы*\n` +
    `  ${s.IGNORED_STAGE_IDS.length ? escapeMd(s.IGNORED_STAGE_IDS.join(', ')) : '\\(нет\\)'}\n\n` +
    `🎯 *Мониторим только эти этапы*\n` +
    `  ${s.MONITORED_STAGE_IDS.length ? escapeMd(s.MONITORED_STAGE_IDS.join(', ')) : 'все этапы'}\n\n` +
    `Выберите что хотите изменить:`
  );
}

function formatMinutes(n) {
  if (n < 60) return `${n} мин`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  if (m === 0) return `${h} ч`;
  return `${h} ч ${m} мин`;
}

function mainKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⏰ Зависший лид', 'st_edit_STALE_LEAD_MINUTES')],
    [
      Markup.button.callback(
        '💬 Неотвеченное сообщение',
        'st_edit_UNANSWERED_MESSAGE_MINUTES'
      ),
    ],
    [
      Markup.button.callback(
        '🔄 Интервал проверки',
        'st_edit_CRON_INTERVAL_MINUTES'
      ),
    ],
    [
      Markup.button.callback(
        '🔁 Cooldown',
        'st_edit_NOTIFICATION_COOLDOWN_MINUTES'
      ),
    ],
    [Markup.button.callback('🚫 Игнорируемые этапы', 'st_stages')],
    [Markup.button.callback('❓ Что это всё значит?', 'st_help')],
  ]);
}

function editText(key) {
  const meta = META[key];
  const current = settings.getInt(key);
  return (
    `${meta.label}\n\n` +
    `*Текущее значение:* ${current} ${meta.unit} \\(${escapeMd(formatMinutes(current))}\\)\n\n` +
    `_${escapeMd(meta.help)}_\n\n` +
    `Выберите пресет или нажмите «Своё значение»:`
  );
}

function editKeyboard(key) {
  const meta = META[key];
  const rows = [];
  // 2 presets per row
  for (let i = 0; i < meta.presets.length; i += 2) {
    const row = [];
    for (let j = i; j < Math.min(i + 2, meta.presets.length); j++) {
      const n = meta.presets[j];
      row.push(Markup.button.callback(`${n} мин`, `st_set_${key}_${n}`));
    }
    rows.push(row);
  }
  rows.push([Markup.button.callback('✏️ Своё значение', `st_custom_${key}`)]);
  rows.push([
    Markup.button.callback('↩️ Сброс к .env', `st_reset_${key}`),
    Markup.button.callback('◀️ Назад', 'st_main'),
  ]);
  return Markup.inlineKeyboard(rows);
}

function helpText() {
  return (
    `❓ *Что значит каждая настройка*\n\n` +
    Object.entries(META)
      .map(
        ([key, m]) =>
          `*${escapeMd(m.label)}*\n${escapeMd(m.help)}\n`
      )
      .join('\n') +
    `\n*🚫 Игнорируемые этапы*\n` +
    escapeMd(
      'ID этапов amoCRM, по которым бот ничего не делает. Обычно это финальные ' +
        'статусы — «Успешно реализовано» (142), «Закрыто и не реализовано» (143). ' +
        'Если у вас несколько воронок, у каждой свои ID — нажмите кнопку, бот ' +
        'покажет список.'
    ) +
    `\n\n*🎯 Мониторим только эти этапы*\n` +
    escapeMd(
      'Если пусто — бот следит за всеми этапами (кроме игнорируемых). ' +
        'Если указан список — следит только за ним. Обычно оставляют пустым.'
    )
  );
}

function helpKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('◀️ Назад к настройкам', 'st_main')],
  ]);
}

async function renderMain(ctx) {
  try {
    await ctx.editMessageText(mainText(), {
      parse_mode: 'MarkdownV2',
      reply_markup: mainKeyboard().reply_markup,
    });
  } catch (_) {
    await ctx.reply(mainText(), {
      parse_mode: 'MarkdownV2',
      reply_markup: mainKeyboard().reply_markup,
    });
  }
}

async function renderEdit(ctx, key) {
  try {
    await ctx.editMessageText(editText(key), {
      parse_mode: 'MarkdownV2',
      reply_markup: editKeyboard(key).reply_markup,
    });
  } catch (_) {
    await ctx.reply(editText(key), {
      parse_mode: 'MarkdownV2',
      reply_markup: editKeyboard(key).reply_markup,
    });
  }
}

async function renderHelp(ctx) {
  try {
    await ctx.editMessageText(helpText(), {
      parse_mode: 'MarkdownV2',
      reply_markup: helpKeyboard().reply_markup,
    });
  } catch (_) {
    await ctx.reply(helpText(), {
      parse_mode: 'MarkdownV2',
      reply_markup: helpKeyboard().reply_markup,
    });
  }
}

// ----- Stages UI -----

async function renderStages(ctx, page = 0) {
  const data = await amocrm.request('GET', '/api/v4/leads/pipelines');
  if (!data || !data._embedded) {
    return ctx.reply(
      '❌ Не удалось получить воронки из amoCRM.\n\nВозможно проблема с токеном или временной блок API.'
    );
  }

  const ignored = new Set(settings.getIdList('IGNORED_STAGE_IDS'));

  // Flatten stages into a single list with pipeline labels
  const items = [];
  for (const p of data._embedded.pipelines || []) {
    for (const s of (p._embedded && p._embedded.statuses) || []) {
      items.push({
        pipeline: p.name,
        id: s.id,
        name: s.name,
        closed: s.type === 1,
      });
    }
  }

  const PAGE = 8;
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE));
  page = Math.max(0, Math.min(page, totalPages - 1));
  const slice = items.slice(page * PAGE, page * PAGE + PAGE);

  let lines = [
    '🚫 *Игнорируемые этапы*',
    '',
    'Этапы, помеченные ✅, бот игнорирует — по ним нет уведомлений\\.',
    'Обычно это финальные статусы \\(закрытые сделки\\)\\.',
    'Жмите на этап, чтобы переключить\\.',
    '',
    `_Страница ${page + 1} из ${totalPages}_`,
    '',
  ];
  for (const it of slice) {
    const mark = ignored.has(it.id) ? '✅' : '⬜️';
    const closed = it.closed ? ' 🔒' : '';
    lines.push(
      `${mark} *${escapeMd(it.name)}*${closed} _\\(${escapeMd(it.pipeline)}\\)_`
    );
  }

  // Buttons: one per stage
  const rows = slice.map((it) => {
    const mark = ignored.has(it.id) ? '✅' : '⬜️';
    return [
      Markup.button.callback(
        `${mark} ${truncate(it.name, 30)}`,
        `st_stg_${it.id}_${page}`
      ),
    ];
  });

  // Pagination row
  const nav = [];
  if (page > 0) nav.push(Markup.button.callback('◀️', `st_stgp_${page - 1}`));
  nav.push(Markup.button.callback(`${page + 1}/${totalPages}`, 'st_noop'));
  if (page < totalPages - 1)
    nav.push(Markup.button.callback('▶️', `st_stgp_${page + 1}`));
  if (nav.length) rows.push(nav);

  rows.push([Markup.button.callback('◀️ К настройкам', 'st_main')]);

  const text = lines.join('\n');
  const kb = Markup.inlineKeyboard(rows);

  try {
    await ctx.editMessageText(text, {
      parse_mode: 'MarkdownV2',
      reply_markup: kb.reply_markup,
    });
  } catch (_) {
    await ctx.reply(text, {
      parse_mode: 'MarkdownV2',
      reply_markup: kb.reply_markup,
    });
  }
}

function truncate(s, n) {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

// ----- Wiring -----

function register(bot, isAdminChat) {
  function guard(ctx) {
    if (!isAdminChat(ctx.chat.id)) {
      ctx.answerCbQuery('⛔ Недостаточно прав', { show_alert: true }).catch(() => {});
      return false;
    }
    return true;
  }

  bot.command('settings', async (ctx) => {
    if (!isAdminChat(ctx.chat.id)) return ctx.reply('⛔ Недостаточно прав');
    await ctx.reply(mainText(), {
      parse_mode: 'MarkdownV2',
      reply_markup: mainKeyboard().reply_markup,
    });
  });

  bot.command('stages', async (ctx) => {
    if (!isAdminChat(ctx.chat.id)) return ctx.reply('⛔ Недостаточно прав');
    await renderStages(ctx, 0);
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(buildHelp(isAdminChat(ctx.chat.id)), {
      parse_mode: 'MarkdownV2',
      link_preview_options: { is_disabled: true },
    });
  });

  bot.action('st_main', async (ctx) => {
    if (!guard(ctx)) return;
    pendingInput.delete(ctx.chat.id);
    await renderMain(ctx);
    await ctx.answerCbQuery();
  });

  bot.action(/^st_edit_(.+)$/, async (ctx) => {
    if (!guard(ctx)) return;
    const key = ctx.match[1];
    if (!META[key]) return ctx.answerCbQuery();
    pendingInput.delete(ctx.chat.id);
    await renderEdit(ctx, key);
    await ctx.answerCbQuery();
  });

  bot.action(/^st_set_(.+)_(\d+)$/, async (ctx) => {
    if (!guard(ctx)) return;
    const key = ctx.match[1];
    const value = parseInt(ctx.match[2], 10);
    if (!META[key] || !Number.isFinite(value) || value < 1) {
      return ctx.answerCbQuery('Неверное значение');
    }
    settings.set(key, value);
    if (key === 'CRON_INTERVAL_MINUTES') scheduler.restart();
    await ctx.answerCbQuery(`✅ ${formatMinutes(value)}`);
    await renderMain(ctx);
  });

  bot.action(/^st_custom_(.+)$/, async (ctx) => {
    if (!guard(ctx)) return;
    const key = ctx.match[1];
    if (!META[key]) return ctx.answerCbQuery();
    pendingInput.set(ctx.chat.id, { key, ts: Date.now() });
    await ctx.answerCbQuery();
    await ctx.reply(
      `Отправьте число минут для «${META[key].short}» одним сообщением.\nНапример: 90`
    );
  });

  bot.action(/^st_reset_(.+)$/, async (ctx) => {
    if (!guard(ctx)) return;
    const key = ctx.match[1];
    if (!META[key] && !['IGNORED_STAGE_IDS', 'MONITORED_STAGE_IDS'].includes(key)) {
      return ctx.answerCbQuery();
    }
    settings.reset(key);
    if (key === 'CRON_INTERVAL_MINUTES') scheduler.restart();
    await ctx.answerCbQuery('↩️ сброшено к .env');
    await renderMain(ctx);
  });

  bot.action('st_help', async (ctx) => {
    if (!guard(ctx)) return;
    await renderHelp(ctx);
    await ctx.answerCbQuery();
  });

  bot.action('st_stages', async (ctx) => {
    if (!guard(ctx)) return;
    await renderStages(ctx, 0);
    await ctx.answerCbQuery();
  });

  bot.action(/^st_stgp_(\d+)$/, async (ctx) => {
    if (!guard(ctx)) return;
    const page = parseInt(ctx.match[1], 10) || 0;
    await renderStages(ctx, page);
    await ctx.answerCbQuery();
  });

  bot.action(/^st_stg_(\d+)_(\d+)$/, async (ctx) => {
    if (!guard(ctx)) return;
    const stageId = parseInt(ctx.match[1], 10);
    const page = parseInt(ctx.match[2], 10) || 0;
    const ignored = settings.getIdList('IGNORED_STAGE_IDS');
    const idx = ignored.indexOf(stageId);
    if (idx >= 0) {
      ignored.splice(idx, 1);
      await ctx.answerCbQuery('Этап снят с игнора');
    } else {
      ignored.push(stageId);
      await ctx.answerCbQuery('Этап добавлен в игнор');
    }
    settings.set('IGNORED_STAGE_IDS', ignored.join(','));
    await renderStages(ctx, page);
  });

  bot.action('st_noop', async (ctx) => {
    await ctx.answerCbQuery();
  });

  // Intercept plain text for pending custom-value flow.
  // This is a function returning bool: handled? — used by bot.js to short-circuit
  // the catch-all message handler.
  async function maybeHandleCustomInput(ctx) {
    const pending = pendingInput.get(ctx.chat.id);
    if (!pending) return false;
    if (!ctx.message || !ctx.message.text) return false;

    const text = ctx.message.text.trim();
    const n = parseInt(text, 10);
    if (!Number.isFinite(n) || n < 1 || n > 100000) {
      await ctx.reply('❌ Это должно быть положительное число (минуты). Попробуй ещё раз или /settings — отменить.');
      return true;
    }
    settings.set(pending.key, n);
    if (pending.key === 'CRON_INTERVAL_MINUTES') scheduler.restart();
    pendingInput.delete(ctx.chat.id);
    await ctx.reply(
      `✅ Сохранено: «${META[pending.key].short}» = ${n} ${META[pending.key].unit}`
    );
    await ctx.reply(mainText(), {
      parse_mode: 'MarkdownV2',
      reply_markup: mainKeyboard().reply_markup,
    });
    return true;
  }

  return { maybeHandleCustomInput };
}

function buildHelp(isAdmin) {
  const base = [
    `🤖 *amo\\-tg\\-bot — помощь*`,
    ``,
    `Я уведомляю менеджеров в Telegram о двух ситуациях в amoCRM:`,
    ``,
    `1\\. *Лид завис на этапе* — лежит дольше N часов без движения`,
    `2\\. *Клиент написал, ответа нет* — входящее сообщение, на которое менеджер не ответил`,
    ``,
    `*Команды для всех:*`,
    `/start — приветствие`,
    `/addme \\<amo\\_user\\_id\\> — привязать себя к amoCRM\\-пользователю`,
    `/whoami — узнать свою привязку и роль`,
    `/help — эта справка`,
    ``,
  ];
  if (isAdmin) {
    base.push(
      `*Команды для админа:*`,
      `/settings — настроить пороги и игнор\\-этапы \\(кнопки\\)`,
      `/stages — список этапов amoCRM с возможностью переключить игнор`,
      `/status — текущая статистика`,
      `/list — список менеджеров и админов`,
      `/report — отчёт по необработанным лидам`,
      `/test \\<lead\\_id\\> — прислать пробное уведомление по лиду`,
      ``,
      `*Как узнать amo\\_user\\_id менеджера:*`,
      `amoCRM → Настройки → Пользователи → клик по человеку → ID в URL`,
      ``,
      `*Как админу подключить нового менеджера:*`,
      `Менеджер пишет боту /addme \\<свой\\_amo\\_user\\_id\\>`,
      `После этого он начнёт получать уведомления по своим лидам, а вы \\(админ\\) — зеркала всех его уведомлений`,
      ``
    );
  } else {
    base.push(
      `*Если вы менеджер:*`,
      `Просто отправьте /addme \\<свой\\_amo\\_user\\_id\\> — узнать его можно у админа`,
      ``
    );
  }
  return base.join('\n');
}

module.exports = { register, buildHelp };
