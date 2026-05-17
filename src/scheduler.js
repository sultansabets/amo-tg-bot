const cron = require('node-cron');
const config = require('./config');
const settings = require('./settings');
const amocrm = require('./amocrm');
const { stageTracking, messageTracking } = require('./db');
const {
  buildStaleMessage,
  buildUnansweredMessage,
  nowAlmaty,
} = require('./notifier');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function checkStaleLeads(notifier) {
  const staleMin = settings.getInt('STALE_LEAD_MINUTES');
  const cooldownMin = settings.getInt('NOTIFICATION_COOLDOWN_MINUTES');
  const ignored = settings.getIdList('IGNORED_STAGE_IDS');
  const stale = stageTracking.findStale(staleMin * 60, cooldownMin * 60);

  let sent = 0;
  for (const row of stale) {
    if (!row.responsible_user_id) {
      console.warn(`⚠️ Lead ${row.lead_id}: no responsible_user_id — skip`);
      continue;
    }

    let phone = row.phone || '';
    let leadName = row.lead_name || '';
    let stageName = row.stage_name || '';
    let hasOpenTask = false;

    const info = await amocrm.getLeadFullInfo(row.lead_id);
    if (info) {
      phone = info.phone || phone;
      leadName = info.lead.name || info.contactName || leadName;
      stageName = info.stageName || stageName;
      hasOpenTask = info.hasOpenTask;

      if (info.lead.status_id && ignored.includes(info.lead.status_id)) {
        stageTracking.remove(row.lead_id);
        continue;
      }
    }

    const text = buildStaleMessage({
      leadId: row.lead_id,
      stageName,
      leadName,
      phone,
      enteredAt: row.entered_at,
      hasOpenTask,
    });

    const ok = await notifier.notifyAmoUser(row.responsible_user_id, text, {
      lead_id: row.lead_id,
      type: 'stale_lead',
    });
    if (ok) {
      stageTracking.markNotified(row.lead_id);
      sent++;
    }
    await sleep(500);
  }

  return { found: stale.length, sent };
}

async function checkUnansweredMessages(notifier) {
  const unansweredMin = settings.getInt('UNANSWERED_MESSAGE_MINUTES');
  const ignored = settings.getIdList('IGNORED_STAGE_IDS');
  const list = messageTracking.findUnanswered(unansweredMin * 60);

  let sent = 0;
  for (const row of list) {
    const tracking = stageTracking.get(row.lead_id);
    let responsibleUserId = tracking && tracking.responsible_user_id;
    let phone = (tracking && tracking.phone) || '';
    let leadName = (tracking && tracking.lead_name) || '';
    let stageName = (tracking && tracking.stage_name) || '';
    let hasOpenTask = false;

    const info = await amocrm.getLeadFullInfo(row.lead_id);
    if (info) {
      responsibleUserId = info.lead.responsible_user_id || responsibleUserId;
      phone = info.phone || phone;
      leadName = info.lead.name || info.contactName || leadName;
      stageName = info.stageName || stageName;
      hasOpenTask = info.hasOpenTask;

      if (info.lead.status_id && ignored.includes(info.lead.status_id)) {
        messageTracking.clearByLead(row.lead_id);
        continue;
      }
    }

    if (!responsibleUserId) {
      console.warn(`⚠️ Lead ${row.lead_id}: no responsible_user_id — skip unanswered`);
      continue;
    }

    const text = buildUnansweredMessage({
      leadId: row.lead_id,
      stageName,
      leadName,
      phone,
      messageAt: row.message_at,
      hasOpenTask,
    });

    const ok = await notifier.notifyAmoUser(responsibleUserId, text, {
      lead_id: row.lead_id,
      type: 'unanswered_message',
    });
    if (ok) {
      messageTracking.markNotified(row.lead_id);
      sent++;
    }
    await sleep(500);
  }

  return { found: list.length, sent };
}

async function runOnce(notifier) {
  console.log(`🔄 [${nowAlmaty()}] cron tick: checking leads…`);
  try {
    const stale = await checkStaleLeads(notifier);
    const unanswered = await checkUnansweredMessages(notifier);
    console.log(
      `🔄 [${nowAlmaty()}] stale: ${stale.sent}/${stale.found}, unanswered: ${unanswered.sent}/${unanswered.found}`
    );
  } catch (err) {
    console.error(`❌ Cron run failed: ${err.message}`);
  }
}

let currentTask = null;
let currentInterval = 0;
let currentNotifier = null;

function start(notifier) {
  currentNotifier = notifier;
  return restart();
}

function restart() {
  const interval = Math.max(1, settings.getInt('CRON_INTERVAL_MINUTES'));
  if (currentTask && currentInterval === interval) return currentTask;

  if (currentTask) {
    try { currentTask.stop(); } catch (_) {}
  }

  const expr = `*/${interval} * * * *`;
  currentTask = cron.schedule(expr, () => runOnce(currentNotifier), {
    scheduled: true,
    timezone: config.timezone,
  });
  currentInterval = interval;
  console.log(`✅ Scheduler started: ${expr} (${config.timezone})`);
  return currentTask;
}

module.exports = { start, restart, runOnce, checkStaleLeads, checkUnansweredMessages };
