const config = require('./config');
const { userMapping, notificationLog, adminMessages, messageTracking } = require('./db');

const MD_SPECIALS = /[_*\[\]()~`>#+\-=|{}.!\\]/g;
function escapeMd(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(MD_SPECIALS, '\\$&');
}

function tzParts(unix) {
  const date = new Date(unix * 1000);
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  return parts;
}

function todayYmd() {
  return tzParts(Math.floor(Date.now() / 1000));
}

function formatTimestamp(unix) {
  if (!unix) return '—';
  const p = tzParts(unix);
  const today = todayYmd();
  const yesterdayUnix = Math.floor(Date.now() / 1000) - 86400;
  const yp = tzParts(yesterdayUnix);

  const hm = `${p.hour}:${p.minute}`;
  if (p.year === today.year && p.month === today.month && p.day === today.day) {
    return `сегодня ${hm}`;
  }
  if (p.year === yp.year && p.month === yp.month && p.day === yp.day) {
    return `вчера ${hm}`;
  }
  return `${p.day}.${p.month} ${hm}`;
}

function formatDuration(seconds) {
  if (!seconds || seconds < 0) seconds = 0;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (m === 0) return `${h} ч`;
  return `${h} ч ${m} мин`;
}

function nowAlmaty() {
  const p = tzParts(Math.floor(Date.now() / 1000));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function buildLeadUrl(leadId) {
  return `https://${config.amo.domain}/leads/detail/${leadId}`;
}

function buildStaleMessage({ leadId, stageName, leadName, phone, enteredAt, hasOpenTask }) {
  const url = buildLeadUrl(leadId);
  const enteredAgoSec = Math.max(0, Math.floor(Date.now() / 1000) - (enteredAt || 0));

  const lines = [
    `⏰ Лид завис в этапе «${escapeMd(stageName || '—')}»`,
    `📎 [Открыть в amoCRM](${escapeMd(url)})`,
    `📞 Телефон: \`${escapeMd(phone || '—')}\``,
    `👤 Имя: ${escapeMd(leadName || '—')}`,
    `🕐 В этапе с: ${escapeMd(formatTimestamp(enteredAt))} \\(${escapeMd(formatDuration(enteredAgoSec))}\\)`,
    `📋 Задача: ${hasOpenTask ? '✅ стоит' : '❌ нет'}`,
  ];
  return lines.join('\n');
}

function buildUnansweredMessage({ leadId, stageName, leadName, phone, messageAt, hasOpenTask }) {
  const url = buildLeadUrl(leadId);
  const ago = Math.max(0, Math.floor(Date.now() / 1000) - (messageAt || 0));

  const lines = [
    `💬 Клиент написал, ответа нет`,
    `📎 [Открыть в amoCRM](${escapeMd(url)})`,
    `📞 Телефон: \`${escapeMd(phone || '—')}\``,
    `👤 Имя: ${escapeMd(leadName || '—')}`,
    `📍 Этап: ${escapeMd(stageName || '—')}`,
    `🕐 Сообщение: ${escapeMd(formatTimestamp(messageAt))} \\(${escapeMd(formatDuration(ago))} назад\\)`,
    `📋 Задача: ${hasOpenTask ? '✅ стоит' : '❌ нет'}`,
  ];
  return lines.join('\n');
}

function makeNotifier(bot) {
  async function sendToChat(chatId, text, meta = {}) {
    try {
      const result = await bot.telegram.sendMessage(chatId, text, {
        parse_mode: 'MarkdownV2',
        link_preview_options: { is_disabled: true },
      });
      notificationLog.add({ ...meta, telegram_chat_id: chatId, text, success: true });
      return { ok: true, message_id: result.message_id };
    } catch (err) {
      console.error(`❌ Telegram send to ${chatId} failed: ${err.message}`);
      notificationLog.add({
        ...meta,
        telegram_chat_id: chatId,
        text,
        success: false,
        error: err.message,
      });
      return { ok: false, error: err.message };
    }
  }

  async function mirrorToAdmins({ originalText, managerName, leadId, type }) {
    const mappedAdmins = userMapping.listAdmins();
    const directChatIds = config.adminTelegramChatIds || [];

    if (!mappedAdmins.length && !directChatIds.length) return;

    const header = `👁 Уведомление → ${escapeMd(managerName || '—')}`;
    const adminText = `${header}\n${originalText}`;

    // Build de-duplicated list: { chatId, amoUserId|null }
    const targets = [];
    const seen = new Set();
    for (const admin of mappedAdmins) {
      const key = String(admin.telegram_chat_id);
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ chatId: admin.telegram_chat_id, amoUserId: admin.amo_user_id });
    }
    for (const chatId of directChatIds) {
      const key = String(chatId);
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ chatId, amoUserId: 0 });
    }

    for (const t of targets) {
      try {
        const result = await bot.telegram.sendMessage(t.chatId, adminText, {
          parse_mode: 'MarkdownV2',
          link_preview_options: { is_disabled: true },
        });
        if (leadId) {
          adminMessages.add({
            lead_id: leadId,
            admin_chat_id: t.chatId,
            telegram_message_id: result.message_id,
            type: type || 'mirror',
          });
        }
        notificationLog.add({
          lead_id: leadId || 0,
          amo_user_id: t.amoUserId,
          telegram_chat_id: t.chatId,
          type: `admin_mirror:${type || ''}`,
          text: adminText,
          success: true,
        });
      } catch (err) {
        console.warn(`⚠️ Admin mirror to chat=${t.chatId} failed: ${err.message}`);
        notificationLog.add({
          lead_id: leadId || 0,
          amo_user_id: t.amoUserId,
          telegram_chat_id: t.chatId,
          type: `admin_mirror:${type || ''}`,
          text: adminText,
          success: false,
          error: err.message,
        });
      }
    }
  }

  async function notifyAmoUser(amoUserId, text, meta = {}) {
    if (!amoUserId) {
      console.warn(`⚠️ notifyAmoUser called with empty amo_user_id`);
      return false;
    }
    const mapping = userMapping.byAmoId(amoUserId);
    let managerName = '';
    let managerSent = false;

    if (!mapping) {
      console.warn(`⚠️ No telegram mapping for amo_user_id=${amoUserId}`);
      managerName = `amo_id=${amoUserId}`;
    } else {
      managerName = mapping.name || `amo_id=${amoUserId}`;
      const sendRes = await sendToChat(mapping.telegram_chat_id, text, {
        ...meta,
        amo_user_id: amoUserId,
      });
      managerSent = sendRes.ok;
    }

    // Admin mirror — runs even if manager isn't mapped, so admins always see alerts.
    await mirrorToAdmins({
      originalText: text,
      managerName,
      leadId: meta.lead_id,
      type: meta.type,
    });

    return managerSent;
  }

  async function resolveLead(leadId, leadName, managerName) {
    if (!leadId) return;

    const rows = adminMessages.unresolvedByLead(leadId);
    const seenChats = new Set();

    for (const row of rows) {
      try {
        await bot.telegram.deleteMessage(row.admin_chat_id, row.telegram_message_id);
      } catch (err) {
        // Silent — message could already be deleted, too old, or chat blocked
      }
      adminMessages.markResolved(row.id);
      seenChats.add(String(row.admin_chat_id));
    }

    if (seenChats.size > 0) {
      console.log(`🗑 Resolved lead ${leadId}: ${rows.length} admin messages cleared`);
    }

    const url = buildLeadUrl(leadId);
    const resolvedText = [
      `✅ Отработан — ${escapeMd(managerName || '—')}`,
      `📎 [Открыть в amoCRM](${escapeMd(url)})`,
      `👤 ${escapeMd(leadName || '—')}`,
      `🕐 Отработан: ${escapeMd(formatTimestamp(Math.floor(Date.now() / 1000)))}`,
    ].join('\n');

    for (const chatId of seenChats) {
      try {
        await bot.telegram.sendMessage(chatId, resolvedText, {
          parse_mode: 'MarkdownV2',
          link_preview_options: { is_disabled: true },
        });
      } catch (err) {
        console.warn(`⚠️ Resolved-notice to chat=${chatId} failed: ${err.message}`);
      }
    }

    try {
      messageTracking.markNotified(leadId);
    } catch (_) {}
  }

  return {
    sendToChat,
    notifyAmoUser,
    resolveLead,
  };
}

module.exports = {
  escapeMd,
  formatTimestamp,
  formatDuration,
  nowAlmaty,
  buildLeadUrl,
  buildStaleMessage,
  buildUnansweredMessage,
  makeNotifier,
};
