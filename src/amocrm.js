const axios = require('axios');
const config = require('./config');
const { tokens } = require('./db');

// OAuth endpoints (token exchange/refresh) live on the tenant domain.
const oauthBaseURL = `https://${config.amo.domain}`;

// API endpoints (/api/v4/*) may live on a separate api_domain that amoCRM
// embeds inside the JWT (api_domain claim, e.g. api-b.amocrm.ru). Long-lived
// tokens issued by recent amoCRM are bound to that api_domain and the tenant
// host returns nginx 403 when hit directly. We decode the JWT once and cache
// the resolved API base URL. `AMO_API_DOMAIN` in .env overrides everything.
let apiBaseURLCache = null;

function decodeJwtPayload(jwt) {
  try {
    const parts = String(jwt || '').split('.');
    if (parts.length < 2) return null;
    let p = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (p.length % 4) p += '=';
    return JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function resolveApiBaseURL() {
  if (apiBaseURLCache) return apiBaseURLCache;
  if (process.env.AMO_API_DOMAIN) {
    apiBaseURLCache = `https://${process.env.AMO_API_DOMAIN.replace(/^https?:\/\//, '')}`;
    return apiBaseURLCache;
  }
  const stored = tokens.get();
  const token =
    (stored && stored.access_token) || config.amo.accessToken || '';
  const payload = decodeJwtPayload(token);
  if (payload && payload.api_domain) {
    apiBaseURLCache = `https://${payload.api_domain}`;
    console.log(`✅ amoCRM API base: ${apiBaseURLCache} (from token api_domain)`);
    return apiBaseURLCache;
  }
  apiBaseURLCache = oauthBaseURL;
  return apiBaseURLCache;
}

function invalidateApiBaseURLCache() {
  apiBaseURLCache = null;
}

function getStoredTokens() {
  const row = tokens.get();
  if (row && row.access_token) return row;
  if (config.amo.accessToken) {
    return {
      access_token: config.amo.accessToken,
      refresh_token: config.amo.refreshToken,
      expires_at: 0,
    };
  }
  return null;
}

async function refreshAccessToken() {
  const stored = getStoredTokens();
  const refreshToken = (stored && stored.refresh_token) || config.amo.refreshToken;
  if (!refreshToken) {
    throw new Error('No refresh_token available');
  }

  const resp = await axios.post(`${oauthBaseURL}/oauth2/access_token`, {
    client_id: config.amo.clientId,
    client_secret: config.amo.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    redirect_uri: config.amo.redirectUri,
  });

  const data = resp.data;
  const expires_at = Math.floor(Date.now() / 1000) + (data.expires_in || 86400);
  tokens.save({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at,
  });
  invalidateApiBaseURLCache();
  console.log('🔄 amoCRM: token refreshed');
  return data.access_token;
}

async function exchangeCode(code) {
  const resp = await axios.post(`${oauthBaseURL}/oauth2/access_token`, {
    client_id: config.amo.clientId,
    client_secret: config.amo.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.amo.redirectUri,
  });
  const data = resp.data;
  const expires_at = Math.floor(Date.now() / 1000) + (data.expires_in || 86400);
  tokens.save({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at,
  });
  invalidateApiBaseURLCache();
  return data;
}

async function getValidAccessToken() {
  const stored = getStoredTokens();
  const now = Math.floor(Date.now() / 1000);

  if (stored && stored.expires_at && stored.expires_at - 60 > now) {
    return stored.access_token;
  }

  if (stored && stored.refresh_token) {
    return await refreshAccessToken();
  }

  if (stored && stored.access_token) {
    return stored.access_token;
  }

  throw new Error('No amoCRM token available — perform OAuth first via /amo/oauth');
}

async function request(method, url, options = {}, _retried = false) {
  try {
    const token = await getValidAccessToken();
    const apiBase = resolveApiBaseURL();
    const resp = await axios({
      method,
      url: `${apiBase}${url}`,
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'amo-tg-bot/1.0',
        Accept: 'application/json',
        ...(options.headers || {}),
      },
      params: options.params,
      data: options.data,
      timeout: 15000,
    });
    return resp.data;
  } catch (err) {
    const status = err.response && err.response.status;
    if (status === 401 && !_retried) {
      try {
        await refreshAccessToken();
        return await request(method, url, options, true);
      } catch (e) {
        console.error('❌ amoCRM refresh failed:', e.message);
        return null;
      }
    }
    if (status === 204 || status === 404) return null;
    console.error(`❌ amoCRM ${method} ${url}: ${err.message}${status ? ' [' + status + ']' : ''}`);
    return null;
  }
}

async function getLead(leadId, withParam = 'contacts') {
  return await request('GET', `/api/v4/leads/${leadId}`, {
    params: withParam ? { with: withParam } : undefined,
  });
}

async function getLeads({ statusId, pipelineId, page = 1, limit = 50 } = {}) {
  const params = { page, limit };
  if (statusId) params['filter[statuses][0][status_id]'] = statusId;
  if (pipelineId) params['filter[statuses][0][pipeline_id]'] = pipelineId;
  return await request('GET', '/api/v4/leads', { params });
}

async function getLeadNotes(leadId, { limit = 50 } = {}) {
  return await request('GET', `/api/v4/leads/${leadId}/notes`, {
    params: { limit, 'order[id]': 'desc' },
  });
}

async function getLeadTasks(leadId) {
  return await request('GET', '/api/v4/tasks', {
    params: {
      'filter[entity_id]': leadId,
      'filter[entity_type]': 'leads',
      'filter[is_completed]': 0,
    },
  });
}

async function getContact(contactId) {
  return await request('GET', `/api/v4/contacts/${contactId}`);
}

async function getStatus(pipelineId, statusId) {
  return await request(
    'GET',
    `/api/v4/leads/pipelines/${pipelineId}/statuses/${statusId}`
  );
}

function extractPhone(contact) {
  if (!contact || !contact.custom_fields_values) return '';
  const phoneField = contact.custom_fields_values.find(
    (f) => f.field_code === 'PHONE' || f.field_name === 'Телефон'
  );
  if (!phoneField || !phoneField.values || !phoneField.values.length) return '';
  return phoneField.values[0].value || '';
}

async function getLeadFullInfo(leadId) {
  const lead = await getLead(leadId, 'contacts');
  if (!lead) return null;

  let phone = '';
  let contactName = '';
  const contactId =
    lead._embedded &&
    lead._embedded.contacts &&
    lead._embedded.contacts.length &&
    (lead._embedded.contacts.find((c) => c.is_main) || lead._embedded.contacts[0]).id;

  if (contactId) {
    const contact = await getContact(contactId);
    if (contact) {
      phone = extractPhone(contact);
      contactName = contact.name || '';
    }
  }

  let stageName = '';
  if (lead.pipeline_id && lead.status_id) {
    const status = await getStatus(lead.pipeline_id, lead.status_id);
    if (status) stageName = status.name || '';
  }

  const tasks = await getLeadTasks(leadId);
  const hasOpenTask =
    tasks && tasks._embedded && tasks._embedded.tasks && tasks._embedded.tasks.length > 0;

  return {
    lead,
    phone,
    contactName,
    stageName,
    hasOpenTask,
  };
}

module.exports = {
  oauthBaseURL,
  resolveApiBaseURL,
  invalidateApiBaseURLCache,
  getValidAccessToken,
  refreshAccessToken,
  exchangeCode,
  request,
  getLead,
  getLeads,
  getLeadNotes,
  getLeadTasks,
  getContact,
  getStatus,
  extractPhone,
  getLeadFullInfo,
};
