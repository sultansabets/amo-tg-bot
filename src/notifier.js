const config = require('./config');
const { userMapping, notificationLog } = require('./db');

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
      await bot.telegram.sendMessage(chatId, text, {
        parse_mode: 'MarkdownV2',
        link_preview_options: { is_disabled: true },
      });
      notificationLog.add({ ...meta, telegram_chat_id: chatId, text, success: true });
      return true;
    } catch (err) {
      console.error(`❌ Telegram send to ${chatId} failed: ${err.message}`);
      notificationLog.add({
        ...meta,
        telegram_chat_id: chatId,
        text,
        success: false,
        error: err.message,
      });
      return false;
    }
  }

  async function notifyAmoUser(amoUserId, text, meta = {}) {
    if (!amoUserId) {
      console.warn(`⚠️ notifyAmoUser called with empty amo_user_id`);
      return false;
    }
    const mapping = userMapping.byAmoId(amoUserId);
    if (!mapping) {
      console.warn(`⚠️ No telegram mapping for amo_user_id=${amoUserId}`);
      return false;
    }
    return await sendToChat(mapping.telegram_chat_id, text, {
      ...meta,
      amo_user_id: amoUserId,
    });
  }

  return {
    sendToChat,
    notifyAmoUser,
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
