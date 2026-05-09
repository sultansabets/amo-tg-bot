const express = require('express');
const config = require('./config');
const amocrm = require('./amocrm');
const { stageTracking, messageTracking } = require('./db');

function parseAmoForm(body) {
  // amoCRM webhooks come as application/x-www-form-urlencoded with nested keys
  // like leads[update][0][id]=123. Express urlencoded with extended:true already
  // produces a nested object — this helper just normalises shape.
  return body || {};
}

function collectEntities(payload, entityKey) {
  // entityKey: 'leads' or 'note'
  const entity = payload[entityKey];
  if (!entity || typeof entity !== 'object') return { add: [], update: [], status: [], delete: [] };
  const out = { add: [], update: [], status: [], delete: [] };
  for (const op of ['add', 'update', 'status', 'delete']) {
    const arr = entity[op];
    if (!arr) continue;
    if (Array.isArray(arr)) {
      out[op] = arr.filter(Boolean);
    } else if (typeof arr === 'object') {
      out[op] = Object.values(arr).filter(Boolean);
    }
  }
  return out;
}

function isIgnoredStage(statusId) {
  return config.ignoredStageIds.includes(parseInt(statusId, 10));
}

function isMonitoredStage(statusId) {
  if (!config.monitoredStageIds.length) return true;
  return config.monitoredStageIds.includes(parseInt(statusId, 10));
}

async function processLeadEvent(leadObj) {
  const leadId = parseInt(leadObj.id, 10);
  if (!leadId) return;

  const statusId = parseInt(leadObj.status_id, 10);
  if (statusId && isIgnoredStage(statusId)) {
    stageTracking.remove(leadId);
    messageTracking.clearByLead(leadId);
    console.log(`📨 Lead ${leadId} entered ignored stage ${statusId} — removed from tracking`);
    return;
  }

  if (statusId && !isMonitoredStage(statusId)) {
    stageTracking.remove(leadId);
    return;
  }

  const info = await amocrm.getLeadFullInfo(leadId);
  if (!info) {
    console.warn(`⚠️ Could not fetch lead ${leadId}`);
    return;
  }
  const { lead, phone, contactName, stageName } = info;

  if (lead.status_id && isIgnoredStage(lead.status_id)) {
    stageTracking.remove(leadId);
    messageTracking.clearByLead(leadId);
    return;
  }
  if (lead.status_id && !isMonitoredStage(lead.status_id)) {
    stageTracking.remove(leadId);
    return;
  }

  stageTracking.upsert({
    lead_id: leadId,
    stage_id: lead.status_id,
    stage_name: stageName,
    pipeline_id: lead.pipeline_id,
    responsible_user_id: lead.responsible_user_id,
    lead_name: lead.name || contactName || '',
    phone,
    entered_at: Math.floor(Date.now() / 1000),
  });
  console.log(`📨 Lead ${leadId} upserted into stage_tracking (stage=${stageName})`);
}

async function processNoteEvent(noteObj) {
  const leadId = parseInt(noteObj.element_id || noteObj.entity_id, 10);
  const noteType = parseInt(noteObj.note_type, 10);
  if (!leadId || !noteType) return;

  const incoming = [102, 25];
  const outgoing = [103, 10];

  if (incoming.includes(noteType)) {
    messageTracking.addIncoming(leadId, Math.floor(Date.now() / 1000));
    console.log(`📥 Lead ${leadId}: incoming note (type=${noteType})`);
  } else if (outgoing.includes(noteType)) {
    messageTracking.clearByLead(leadId);
    console.log(`📤 Lead ${leadId}: outgoing reply (type=${noteType}) — cleared`);
  }
}

function buildRouter() {
  const router = express.Router();

  router.use(express.urlencoded({ extended: true, limit: '2mb' }));
  router.use(express.json({ limit: '2mb' }));

  router.post('/amo/webhook/:secret', (req, res) => {
    if (req.params.secret !== config.webhookSecret) {
      return res.status(403).send('forbidden');
    }
    res.status(200).send('ok');

    const payload = parseAmoForm(req.body);
    setImmediate(async () => {
      try {
        const leads = collectEntities(payload, 'leads');
        for (const lead of [...leads.add, ...leads.update, ...leads.status]) {
          await processLeadEvent(lead);
        }
        for (const lead of leads.delete) {
          const id = parseInt(lead.id, 10);
          if (id) {
            stageTracking.remove(id);
            messageTracking.clearByLead(id);
          }
        }

        const notes = collectEntities(payload, 'note');
        for (const note of [...notes.add, ...notes.update]) {
          await processNoteEvent(note);
        }
      } catch (err) {
        console.error(`❌ Webhook processing failed: ${err.message}`);
      }
    });
  });

  router.get('/amo/oauth', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('Missing code');
    try {
      await amocrm.exchangeCode(code);
      res.send('✅ Токен получен');
      console.log('✅ amoCRM OAuth: tokens stored');
    } catch (err) {
      console.error(`❌ OAuth exchange failed: ${err.message}`);
      res.status(500).send(`OAuth error: ${err.message}`);
    }
  });

  router.get('/health', (_req, res) => res.json({ ok: true }));

  return router;
}

module.exports = { buildRouter };
