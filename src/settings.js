// Runtime settings layer: values stored in DB win over .env defaults.
// Admins can change these at runtime via /set and /stages commands.

const { settings: settingsTable } = require('./db');
const config = require('./config');

const KEYS = [
  'STALE_LEAD_MINUTES',
  'UNANSWERED_MESSAGE_MINUTES',
  'CRON_INTERVAL_MINUTES',
  'NOTIFICATION_COOLDOWN_MINUTES',
  'MONITORED_STAGE_IDS',
  'IGNORED_STAGE_IDS',
];

function envDefault(key) {
  switch (key) {
    case 'STALE_LEAD_MINUTES':
      return String(config.staleLeadMinutes);
    case 'UNANSWERED_MESSAGE_MINUTES':
      return String(config.unansweredMessageMinutes);
    case 'CRON_INTERVAL_MINUTES':
      return String(config.cronIntervalMinutes);
    case 'NOTIFICATION_COOLDOWN_MINUTES':
      return String(config.notificationCooldownMinutes);
    case 'MONITORED_STAGE_IDS':
      return config.monitoredStageIds.join(',');
    case 'IGNORED_STAGE_IDS':
      return config.ignoredStageIds.join(',');
    default:
      return '';
  }
}

function getRaw(key) {
  const row = settingsTable.get(key);
  if (row && row.value !== null && row.value !== undefined && row.value !== '') {
    return row.value;
  }
  if (row && row.value === '') return row.value; // explicit empty wins
  return envDefault(key);
}

function getInt(key) {
  const v = parseInt(getRaw(key), 10);
  return Number.isFinite(v) ? v : 0;
}

function getIdList(key) {
  const raw = getRaw(key) || '';
  return String(raw)
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter(Number.isFinite);
}

function set(key, value) {
  if (!KEYS.includes(key)) throw new Error(`unknown setting: ${key}`);
  settingsTable.set(key, value);
}

function reset(key) {
  if (!KEYS.includes(key)) throw new Error(`unknown setting: ${key}`);
  settingsTable.unset(key);
}

function snapshot() {
  return {
    STALE_LEAD_MINUTES: getInt('STALE_LEAD_MINUTES'),
    UNANSWERED_MESSAGE_MINUTES: getInt('UNANSWERED_MESSAGE_MINUTES'),
    CRON_INTERVAL_MINUTES: getInt('CRON_INTERVAL_MINUTES'),
    NOTIFICATION_COOLDOWN_MINUTES: getInt('NOTIFICATION_COOLDOWN_MINUTES'),
    MONITORED_STAGE_IDS: getIdList('MONITORED_STAGE_IDS'),
    IGNORED_STAGE_IDS: getIdList('IGNORED_STAGE_IDS'),
  };
}

module.exports = {
  KEYS,
  getRaw,
  getInt,
  getIdList,
  set,
  reset,
  snapshot,
  envDefault,
};
