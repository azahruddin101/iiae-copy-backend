const { getMetaConfig, META_OAUTH_SCOPES } = require('../config/meta');
const { createAppSecretProof } = require('./metaCrypto');

const GRAPH_HOST = 'https://graph.facebook.com';
const DIALOG_HOST = 'https://www.facebook.com';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_PAGINATION_REQUESTS = 20;

const LEAD_FIELDS_FULL = [
  'id',
  'created_time',
  'field_data',
  'form_id',
  'ad_id',
  'ad_name',
  'adset_id',
  'adset_name',
  'campaign_id',
  'campaign_name',
  'is_organic',
  'platform',
].join(',');

// Used when the token cannot read ad-level fields
const LEAD_FIELDS_BASIC = 'id,created_time,field_data,form_id';

const RATE_LIMIT_CODES = [4, 17, 32, 341, 613];

// Map a Graph API error to a small set of kinds the rest of the integration acts on
const classifyGraphError = ({ status, code, isTransient }) => {
  if (code === 190 || code === 102) return 'TOKEN_INVALID';
  if (RATE_LIMIT_CODES.includes(code) || (code >= 80000 && code <= 80014) || status === 429) return 'RATE_LIMIT';
  if (code === 10 || code === 3 || (code >= 200 && code <= 299)) return 'PERMISSION';
  if (isTransient || code === 1 || code === 2 || status >= 500) return 'TRANSIENT';
  if (code === 100 || code === 803 || status === 404) return 'INVALID_REQUEST';
  return 'UNKNOWN';
};

class MetaGraphError extends Error {
  constructor(message, { kind, status, code, subcode, fbtraceId } = {}) {
    super(message);
    this.name = 'MetaGraphError';
    this.kind = kind || 'UNKNOWN';
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    this.fbtraceId = fbtraceId;
  }

  get retryable() {
    return ['RATE_LIMIT', 'TRANSIENT', 'NETWORK'].includes(this.kind);
  }
}

// Low level Graph API request. Error messages never contain the URL, token or secret.
const graphRequest = async (method, path, { params = {}, accessToken, useAppSecretProof = true } = {}) => {
  const config = getMetaConfig();
  const query = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) query.set(key, String(value));
  });

  if (accessToken) {
    query.set('access_token', accessToken);
    if (useAppSecretProof) {
      query.set('appsecret_proof', createAppSecretProof(accessToken, config.appSecret));
    }
  }

  const url = `${GRAPH_HOST}/${config.graphApiVersion}/${path}`;
  const options = { method, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
  let requestUrl = url;

  if (method === 'POST') {
    options.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    options.body = query.toString();
  } else {
    requestUrl = `${url}?${query.toString()}`;
  }

  let response;
  try {
    response = await fetch(requestUrl, options);
  } catch (error) {
    throw new MetaGraphError('Could not reach the Meta Graph API', { kind: 'NETWORK' });
  }

  let body = null;
  try {
    body = await response.json();
  } catch (error) {
    body = null;
  }

  if (!response.ok || !body || body.error) {
    const graphError = (body && body.error) || {};
    const details = {
      status: response.status,
      code: graphError.code,
      subcode: graphError.error_subcode,
      fbtraceId: graphError.fbtrace_id,
    };
    throw new MetaGraphError(graphError.message || 'Meta Graph API request failed', {
      ...details,
      kind: classifyGraphError({ ...details, isTransient: graphError.is_transient === true }),
    });
  }

  return body;
};

// Follow cursor pagination and return every item of a Graph edge
const graphGetAll = async (path, { params = {}, accessToken } = {}) => {
  const items = [];
  let after;

  for (let i = 0; i < MAX_PAGINATION_REQUESTS; i += 1) {
    const body = await graphRequest('GET', path, {
      params: { ...params, limit: 100, after },
      accessToken,
    });

    if (Array.isArray(body.data)) items.push(...body.data);

    after = body.paging && body.paging.next && body.paging.cursors ? body.paging.cursors.after : null;
    if (!after) break;
  }

  return items;
};

// Facebook Login dialog the user is redirected to
const buildOAuthDialogUrl = (state) => {
  const config = getMetaConfig();
  const query = new URLSearchParams({
    client_id: config.appId,
    redirect_uri: config.redirectUri,
    state,
    response_type: 'code',
    scope: META_OAUTH_SCOPES.join(','),
  });

  return `${DIALOG_HOST}/${config.graphApiVersion}/dialog/oauth?${query.toString()}`;
};

// Check an App ID / App Secret pair with Meta before it is saved (throws MetaGraphError when rejected).
// Does not depend on the stored configuration, so it can validate values that are not saved yet.
const verifyAppCredentials = (appId, appSecret) =>
  graphRequest('GET', 'oauth/access_token', {
    params: { client_id: appId, client_secret: appSecret, grant_type: 'client_credentials' },
  });

// Authorization code -> short-lived user token
const exchangeCodeForToken = async (code) => {
  const config = getMetaConfig();
  const body = await graphRequest('GET', 'oauth/access_token', {
    params: {
      client_id: config.appId,
      client_secret: config.appSecret,
      redirect_uri: config.redirectUri,
      code,
    },
  });
  return body.access_token;
};

// Short-lived user token -> long-lived user token (Page tokens derived from it do not expire)
const exchangeForLongLivedToken = async (shortLivedToken) => {
  const config = getMetaConfig();
  const body = await graphRequest('GET', 'oauth/access_token', {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: config.appId,
      client_secret: config.appSecret,
      fb_exchange_token: shortLivedToken,
    },
  });
  return body.access_token;
};

const getMetaUser = (userToken) =>
  graphRequest('GET', 'me', { params: { fields: 'id,name' }, accessToken: userToken });

// Names of the permissions the user actually granted
const getGrantedPermissions = async (userToken) => {
  const permissions = await graphGetAll('me/permissions', { accessToken: userToken });
  return permissions.filter((p) => p.status === 'granted').map((p) => p.permission);
};

// Facebook Pages the user manages, including each Page access token
const getUserPages = (userToken) =>
  graphGetAll('me/accounts', { params: { fields: 'id,name,access_token,tasks' }, accessToken: userToken });

const getPageLeadForms = (pageId, pageToken) =>
  graphGetAll(`${pageId}/leadgen_forms`, {
    params: { fields: 'id,name,status,created_time' },
    accessToken: pageToken,
  });

// Install the app on the Page so leadgen webhooks are delivered
const subscribePageToLeadgen = (pageId, pageToken) =>
  graphRequest('POST', `${pageId}/subscribed_apps`, {
    params: { subscribed_fields: 'leadgen' },
    accessToken: pageToken,
  });

const unsubscribePage = async (pageId, pageToken) => {
  try {
    return await graphRequest('DELETE', `${pageId}/subscribed_apps`, { accessToken: pageToken });
  } catch (error) {
    // An app can always remove its own subscription with an app access token
    const config = getMetaConfig();
    return graphRequest('DELETE', `${pageId}/subscribed_apps`, {
      accessToken: `${config.appId}|${config.appSecret}`,
      useAppSecretProof: false,
    });
  }
};

// Retrieve a single lead. Falls back to the basic fields when ad-level fields are not readable.
const getLead = async (leadId, pageToken) => {
  try {
    return await graphRequest('GET', leadId, { params: { fields: LEAD_FIELDS_FULL }, accessToken: pageToken });
  } catch (error) {
    if (error instanceof MetaGraphError && ['PERMISSION', 'INVALID_REQUEST'].includes(error.kind)) {
      return graphRequest('GET', leadId, { params: { fields: LEAD_FIELDS_BASIC }, accessToken: pageToken });
    }
    throw error;
  }
};

// Read one page of the leads already submitted to a lead form (GET /{form-id}/leads).
// The edge is cursor-paginated: pass the returned nextCursor back as `after` until it is null.
// Meta only returns leads submitted in the last 90 days.
const getFormLeadsPage = async (formId, pageToken, { after, limit = 100, basicFields = false } = {}) => {
  const body = await graphRequest('GET', `${formId}/leads`, {
    params: { fields: basicFields ? LEAD_FIELDS_BASIC : LEAD_FIELDS_FULL, limit, after },
    accessToken: pageToken,
  });

  const paging = body.paging || {};
  let nextCursor = null;
  if (paging.next) {
    nextCursor = (paging.cursors && paging.cursors.after) || new URL(paging.next).searchParams.get('after');
  }

  return { leads: Array.isArray(body.data) ? body.data : [], nextCursor: nextCursor || null };
};

module.exports = {
  MetaGraphError,
  getFormLeadsPage,
  verifyAppCredentials,
  buildOAuthDialogUrl,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  getMetaUser,
  getGrantedPermissions,
  getUserPages,
  getPageLeadForms,
  subscribePageToLeadgen,
  unsubscribePage,
  getLead,
};
