const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'bot.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS stage_tracking (
    lead_id INTEGER PRIMARY KEY,
    stage_id INTEGER,
    stage_name TEXT,
    pipeline_id INTEGER,
    responsible_user_id INTEGER,
    lead_name TEXT,
    phone TEXT,
    entered_at INTEGER,
    last_notified_at INTEGER DEFAULT 0,
    notification_count INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS message_tracking (
    lead_id INTEGER PRIMARY KEY,
    message_at INTEGER,
    notified INTEGER DEFAULT 0,
    notified_at INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS user_mapping (
    amo_user_id INTEGER PRIMARY KEY,
    telegram_chat_id INTEGER NOT NULL,
    name TEXT,
    active INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS notification_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER,
    amo_user_id INTEGER,
    telegram_chat_id INTEGER,
    type TEXT,
    text TEXT,
    sent_at INTEGER DEFAULT (strftime('%s','now')),
    success INTEGER DEFAULT 1,
    error TEXT
  );

  CREATE TABLE IF NOT EXISTS oauth_tokens (
    id INTEGER PRIMARY KEY,
    access_token TEXT,
    refresh_token TEXT,
    expires_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS admin_messages (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id             INTEGER NOT NULL,
    admin_chat_id       TEXT NOT NULL,
    telegram_message_id INTEGER NOT NULL,
    type                TEXT NOT NULL,
    sent_at             INTEGER NOT NULL,
    resolved            INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_admin_messages_lead ON admin_messages(lead_id, resolved);

  CREATE TABLE IF NOT EXISTS admin_chats (
    telegram_chat_id INTEGER PRIMARY KEY,
    amo_user_id      INTEGER,
    name             TEXT,
    created_at       INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  );
`);

// Safe migration: add role column if missing
try {
  db.prepare(`ALTER TABLE user_mapping ADD COLUMN role TEXT DEFAULT 'manager'`).run();
  console.log("✅ Migration: added 'role' column to user_mapping");
} catch (err) {
  if (!/duplicate column/i.test(err.message)) {
    console.warn(`⚠️ Migration check: ${err.message}`);
  }
}

const stageTracking = {
  upsert(row) {
    const existing = db
      .prepare('SELECT stage_id, entered_at FROM stage_tracking WHERE lead_id = ?')
      .get(row.lead_id);

    const stageChanged = !existing || existing.stage_id !== row.stage_id;
    const enteredAt = stageChanged ? row.entered_at || Math.floor(Date.now() / 1000) : existing.entered_at;

    db.prepare(
      `INSERT INTO stage_tracking
       (lead_id, stage_id, stage_name, pipeline_id, responsible_user_id, lead_name, phone, entered_at, last_notified_at, notification_count)
       VALUES (@lead_id, @stage_id, @stage_name, @pipeline_id, @responsible_user_id, @lead_name, @phone, @entered_at, 0, 0)
       ON CONFLICT(lead_id) DO UPDATE SET
         stage_id = excluded.stage_id,
         stage_name = excluded.stage_name,
         pipeline_id = excluded.pipeline_id,
         responsible_user_id = excluded.responsible_user_id,
         lead_name = excluded.lead_name,
         phone = excluded.phone,
         entered_at = CASE WHEN stage_tracking.stage_id <> excluded.stage_id THEN excluded.entered_at ELSE stage_tracking.entered_at END,
         last_notified_at = CASE WHEN stage_tracking.stage_id <> excluded.stage_id THEN 0 ELSE stage_tracking.last_notified_at END,
         notification_count = CASE WHEN stage_tracking.stage_id <> excluded.stage_id THEN 0 ELSE stage_tracking.notification_count END`
    ).run({
      lead_id: row.lead_id,
      stage_id: row.stage_id,
      stage_name: row.stage_name || '',
      pipeline_id: row.pipeline_id || 0,
      responsible_user_id: row.responsible_user_id || 0,
      lead_name: row.lead_name || '',
      phone: row.phone || '',
      entered_at: enteredAt,
    });

    return { stageChanged };
  },

  remove(leadId) {
    db.prepare('DELETE FROM stage_tracking WHERE lead_id = ?').run(leadId);
  },

  get(leadId) {
    return db.prepare('SELECT * FROM stage_tracking WHERE lead_id = ?').get(leadId);
  },

  findStale(staleSeconds, cooldownSeconds) {
    const now = Math.floor(Date.now() / 1000);
    // ONE notification per stage entry. stage_tracking.upsert() resets
    // last_notified_at to 0 when the stage changes, so a new stage always
    // re-arms the alert. cooldownSeconds is kept for backwards compat but
    // is effectively ignored now (set to a huge value to honor "once").
    return db
      .prepare(
        `SELECT * FROM stage_tracking
         WHERE entered_at <= ?
           AND last_notified_at = 0`
      )
      .all(now - staleSeconds);
  },

  markNotified(leadId) {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `UPDATE stage_tracking
       SET last_notified_at = ?, notification_count = notification_count + 1
       WHERE lead_id = ?`
    ).run(now, leadId);
  },

  count() {
    return db.prepare('SELECT COUNT(*) AS c FROM stage_tracking').get().c;
  },
};

const messageTracking = {
  addIncoming(leadId, messageAt) {
    db.prepare(
      `INSERT INTO message_tracking (lead_id, message_at, notified, notified_at)
       VALUES (?, ?, 0, 0)
       ON CONFLICT(lead_id) DO UPDATE SET
         message_at = excluded.message_at,
         notified = 0,
         notified_at = 0`
    ).run(leadId, messageAt || Math.floor(Date.now() / 1000));
  },

  clearByLead(leadId) {
    db.prepare('DELETE FROM message_tracking WHERE lead_id = ?').run(leadId);
  },

  findUnanswered(unansweredSeconds) {
    const now = Math.floor(Date.now() / 1000);
    return db
      .prepare(
        `SELECT * FROM message_tracking
         WHERE notified = 0 AND message_at <= ?`
      )
      .all(now - unansweredSeconds);
  },

  markNotified(leadId) {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `UPDATE message_tracking SET notified = 1, notified_at = ? WHERE lead_id = ?`
    ).run(now, leadId);
  },

  count() {
    return db.prepare('SELECT COUNT(*) AS c FROM message_tracking WHERE notified = 0').get().c;
  },
};

const userMapping = {
  upsert(amoUserId, telegramChatId, name, role) {
    const finalRole = role === 'admin' ? 'admin' : 'manager';
    db.prepare(
      `INSERT INTO user_mapping (amo_user_id, telegram_chat_id, name, active, role)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(amo_user_id) DO UPDATE SET
         telegram_chat_id = excluded.telegram_chat_id,
         name = excluded.name,
         active = 1,
         role = excluded.role`
    ).run(amoUserId, telegramChatId, name || '', finalRole);
  },

  byAmoId(amoUserId) {
    return db
      .prepare('SELECT * FROM user_mapping WHERE amo_user_id = ? AND active = 1')
      .get(amoUserId);
  },

  byChatId(chatId) {
    return db
      .prepare('SELECT * FROM user_mapping WHERE telegram_chat_id = ? AND active = 1')
      .get(chatId);
  },

  list() {
    return db.prepare('SELECT * FROM user_mapping WHERE active = 1 ORDER BY role DESC, amo_user_id').all();
  },

  listAdmins() {
    return db
      .prepare("SELECT * FROM user_mapping WHERE active = 1 AND role = 'admin'")
      .all();
  },

  listManagers() {
    return db
      .prepare("SELECT * FROM user_mapping WHERE active = 1 AND role = 'manager' ORDER BY name")
      .all();
  },

  count() {
    return db.prepare('SELECT COUNT(*) AS c FROM user_mapping WHERE active = 1').get().c;
  },

  countAdmins() {
    return db
      .prepare("SELECT COUNT(*) AS c FROM user_mapping WHERE active = 1 AND role = 'admin'")
      .get().c;
  },
};

const settings = {
  get(key) {
    return db.prepare('SELECT * FROM settings WHERE key = ?').get(key);
  },
  set(key, value) {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, strftime('%s','now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    ).run(key, value == null ? '' : String(value));
  },
  unset(key) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  },
  all() {
    return db.prepare('SELECT * FROM settings').all();
  },
};

const adminChats = {
  upsert(chatId, amoUserId, name) {
    db.prepare(
      `INSERT INTO admin_chats (telegram_chat_id, amo_user_id, name)
       VALUES (?, ?, ?)
       ON CONFLICT(telegram_chat_id) DO UPDATE SET
         amo_user_id = excluded.amo_user_id,
         name = excluded.name`
    ).run(chatId, amoUserId || 0, name || '');
  },

  remove(chatId) {
    db.prepare('DELETE FROM admin_chats WHERE telegram_chat_id = ?').run(chatId);
  },

  list() {
    return db.prepare('SELECT * FROM admin_chats ORDER BY created_at').all();
  },

  byChatId(chatId) {
    return db
      .prepare('SELECT * FROM admin_chats WHERE telegram_chat_id = ?')
      .get(chatId);
  },

  count() {
    return db.prepare('SELECT COUNT(*) AS c FROM admin_chats').get().c;
  },
};

const adminMessages = {
  add({ lead_id, admin_chat_id, telegram_message_id, type }) {
    db.prepare(
      `INSERT INTO admin_messages (lead_id, admin_chat_id, telegram_message_id, type, sent_at, resolved)
       VALUES (?, ?, ?, ?, ?, 0)`
    ).run(
      lead_id,
      String(admin_chat_id),
      telegram_message_id,
      type || '',
      Math.floor(Date.now() / 1000)
    );
  },

  unresolvedByLead(leadId) {
    return db
      .prepare(
        `SELECT * FROM admin_messages WHERE lead_id = ? AND resolved = 0`
      )
      .all(leadId);
  },

  markResolved(id) {
    db.prepare(`UPDATE admin_messages SET resolved = 1 WHERE id = ?`).run(id);
  },

  markResolvedByLead(leadId) {
    db.prepare(
      `UPDATE admin_messages SET resolved = 1 WHERE lead_id = ? AND resolved = 0`
    ).run(leadId);
  },
};

const notificationLog = {
  add(row) {
    db.prepare(
      `INSERT INTO notification_log
       (lead_id, amo_user_id, telegram_chat_id, type, text, success, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      row.lead_id || 0,
      row.amo_user_id || 0,
      row.telegram_chat_id || 0,
      row.type || '',
      row.text || '',
      row.success ? 1 : 0,
      row.error || null
    );
  },
};

const tokens = {
  get() {
    return db.prepare('SELECT * FROM oauth_tokens WHERE id = 1').get();
  },

  save({ access_token, refresh_token, expires_at }) {
    db.prepare(
      `INSERT INTO oauth_tokens (id, access_token, refresh_token, expires_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         access_token = excluded.access_token,
         refresh_token = excluded.refresh_token,
         expires_at = excluded.expires_at`
    ).run(access_token, refresh_token, expires_at);
  },
};

module.exports = {
  db,
  stageTracking,
  messageTracking,
  userMapping,
  notificationLog,
  tokens,
  adminMessages,
  adminChats,
  settings,
};
