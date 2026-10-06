// The Meta app (App ID + App Secret) is entered by an admin in the CRM - no server environment needed.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  SAMPLE_LEAD,
  graphError,
  startTestApp,
  stopTestApp,
  resetState,
  setGraphOverrides,
  getGraphCalls,
  createUser,
  request,
  signPayload,
  leadgenPayload,
  postWebhook,
} = require('./helpers');
const MetaIntegration = require('../../src/models/MetaIntegration');
const MetaLead = require('../../src/models/MetaLead');
const { processPendingLeads } = require('../../src/workers/metaLeadWorker');

const ENV_KEYS = [
  'META_APP_ID',
  'META_APP_SECRET',
  'META_REDIRECT_URI',
  'META_WEBHOOK_VERIFY_TOKEN',
  'META_WEBHOOK_APP_SECRET',
  'META_TOKEN_ENCRYPTION_KEY',
  'META_FRONTEND_REDIRECT_URL',
];
const savedEnv = {};

const APP = {
  appId: '998877665544',
  appSecret: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
  apiBaseUrl: 'https://api.client.test/api/',
  frontendRedirectUrl: 'https://crm.client.test/dashboard/integrations/meta?meta=connected',
};

const appTokenResponse = { 'GET oauth/access_token': ({ params }) =>
  params.grant_type === 'client_credentials'
    ? { body: { access_token: `${params.client_id}|app-token`, token_type: 'bearer' } }
    : { body: { access_token: params.grant_type ? 'long-user-token' : 'short-user-token' } },
};

before(async () => {
  await startTestApp();
  // Run with no META_* environment at all - only JWT_SECRET, which the application already requires
  ENV_KEYS.forEach((key) => {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  });
});

after(async () => {
  ENV_KEYS.forEach((key) => {
    process.env[key] = savedEnv[key];
  });
  await stopTestApp();
});

beforeEach(async () => {
  await resetState();
  setGraphOverrides(appTokenResponse);
});

const saveApp = (token, overrides = {}) =>
  request('PUT', '/api/integrations/meta/app-settings', { token, body: { ...APP, ...overrides } });

test('without any setup the integration reports "not configured" and connect is refused', async () => {
  const { token } = await createUser('admin');

  const status = await request('GET', '/api/integrations/meta/status', { token });
  assert.equal(status.json.configured, false);
  assert.equal(status.json.setup.source, null);

  assert.equal((await request('GET', '/api/integrations/meta/connect', { token })).status, 503);

  // Webhooks cannot be verified or accepted before an app is saved
  const verify = await request('GET', '/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=&hub.challenge=1');
  assert.equal(verify.status, 403);
  assert.equal((await postWebhook(leadgenPayload(), { signature: signPayload('x', '') })).status, 503);
});

test('admin saves the Meta app in the CRM: verified with Meta, stored encrypted, secret never returned', async () => {
  const { token } = await createUser('admin');

  const res = await saveApp(token);
  assert.equal(res.status, 200);
  assert.ok(!res.text.includes(APP.appSecret));

  // The pair was checked with Meta before saving
  const check = getGraphCalls('GET oauth/access_token')[0];
  assert.equal(check.params.client_id, APP.appId);
  assert.equal(check.params.client_secret, APP.appSecret);
  assert.equal(check.params.grant_type, 'client_credentials');

  const stored = await MetaIntegration.findOne({ key: 'default' });
  assert.equal(stored.appSettings.appId, APP.appId);
  assert.ok(!JSON.stringify(stored.toObject()).includes(APP.appSecret));
  assert.ok(!JSON.stringify(stored).includes('Encrypted'));

  const status = await request('GET', '/api/integrations/meta/status', { token });
  assert.equal(status.json.configured, true);
  assert.equal(status.json.webhookConfigured, true);
  assert.deepEqual(
    { ...status.json.setup, webhookVerifyToken: undefined },
    {
      source: 'database',
      appId: APP.appId,
      redirectUri: 'https://api.client.test/api/integrations/meta/callback',
      webhookCallbackUrl: 'https://api.client.test/api/webhooks/meta',
      webhookVerifyToken: undefined,
    }
  );
  assert.ok(status.json.setup.webhookVerifyToken.length >= 32);
  assert.ok(!status.text.includes(APP.appSecret));
});

test('invalid input and credentials rejected by Meta are not saved', async () => {
  const { token } = await createUser('admin');

  for (const overrides of [
    { appId: '' },
    { appId: 'abc' },
    { appSecret: '' },
    { appSecret: 'has spaces in it !!' },
    { apiBaseUrl: 'javascript:alert(1)' },
    { frontendRedirectUrl: 'not a url' },
    { appId: { $ne: '' } },
  ]) {
    assert.equal((await saveApp(token, overrides)).status, 400);
  }
  assert.equal(getGraphCalls().length, 0);

  setGraphOverrides({ 'GET oauth/access_token': () => graphError(400, 101, 'Error validating client secret.') });
  const rejected = await saveApp(token);
  assert.equal(rejected.status, 400);
  assert.ok(rejected.json.message.includes('did not accept'));

  setGraphOverrides({ 'GET oauth/access_token': 'NETWORK_ERROR' });
  assert.equal((await saveApp(token)).status, 502);

  assert.equal(await MetaIntegration.countDocuments(), 0);
});

test('only admin and manager can save the Meta app', async () => {
  assert.equal((await request('PUT', '/api/integrations/meta/app-settings', { body: APP })).status, 401);

  for (const role of ['counsellor', 'accountant', 'teacher', 'student']) {
    const { token } = await createUser(role);
    assert.equal((await saveApp(token)).status, 403);
  }
  assert.equal(await MetaIntegration.countDocuments(), 0);
});

test('end to end with a CRM-configured app: OAuth, webhook verification, signed webhook and lead retrieval', async () => {
  const { token } = await createUser('admin');
  await saveApp(token);
  const status = await request('GET', '/api/integrations/meta/status', { token });
  const verifyToken = status.json.setup.webhookVerifyToken;

  // OAuth uses the saved App ID, redirect URI and App Secret
  const connect = await request('GET', '/api/integrations/meta/connect', { token });
  const url = new URL(connect.json.url);
  assert.equal(url.searchParams.get('client_id'), APP.appId);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://api.client.test/api/integrations/meta/callback');

  const callback = await request(
    'GET',
    `/api/integrations/meta/callback?${new URLSearchParams({ code: 'auth-code', state: url.searchParams.get('state') })}`
  );
  assert.equal(callback.location, 'https://crm.client.test/dashboard/integrations/meta?meta=connected');
  const exchange = getGraphCalls('GET oauth/access_token').find((call) => call.params.code);
  assert.equal(exchange.params.client_secret, APP.appSecret);

  await request('POST', '/api/integrations/meta/pages/111/forms', { token, body: { formIds: ['9001'] } });

  // Webhook handshake uses the generated verify token
  const verifyUrl = (value) =>
    `/api/webhooks/meta?${new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': value, 'hub.challenge': '777' })}`;
  assert.equal((await request('GET', verifyUrl(verifyToken))).text, '777');
  assert.equal((await request('GET', verifyUrl('wrong'))).status, 403);

  // Webhook signatures are checked with the saved App Secret
  const payload = leadgenPayload();
  const raw = JSON.stringify(payload);
  assert.equal((await postWebhook(payload, { signature: signPayload(raw, 'some-other-secret') })).status, 401);
  assert.equal((await postWebhook(payload, { signature: signPayload(raw, APP.appSecret) })).status, 200);

  assert.equal(await processPendingLeads(), 1);
  const lead = await MetaLead.findOne({ externalLeadId: SAMPLE_LEAD.id });
  assert.equal(lead.processingStatus, 'processed');
  assert.equal(lead.fullName, 'Riya Sharma');
});

test('saving again keeps the verify token; switching to another app drops the old connection', async () => {
  const { token } = await createUser('admin');
  await saveApp(token);
  const firstToken = (await request('GET', '/api/integrations/meta/status', { token })).json.setup.webhookVerifyToken;

  const connect = await request('GET', '/api/integrations/meta/connect', { token });
  const state = new URL(connect.json.url).searchParams.get('state');
  await request('GET', `/api/integrations/meta/callback?${new URLSearchParams({ code: 'c', state })}`);
  assert.equal((await MetaIntegration.findOne({ key: 'default' })).connected, true);

  // Same app saved again: nothing is lost
  await saveApp(token);
  let status = (await request('GET', '/api/integrations/meta/status', { token })).json;
  assert.equal(status.setup.webhookVerifyToken, firstToken);
  assert.equal(status.connected, true);

  // Different app: tokens issued for the old app are discarded
  await saveApp(token, { appId: '112233445566' });
  status = (await request('GET', '/api/integrations/meta/status', { token })).json;
  assert.equal(status.setup.appId, '112233445566');
  assert.equal(status.setup.webhookVerifyToken, firstToken);
  assert.equal(status.connected, false);
  assert.equal((await MetaIntegration.findOne({ key: 'default' })).pages.length, 0);
});

test('disconnecting keeps the saved Meta app so the client can reconnect without setup', async () => {
  const { token } = await createUser('admin');
  await saveApp(token);
  const connect = await request('GET', '/api/integrations/meta/connect', { token });
  const state = new URL(connect.json.url).searchParams.get('state');
  await request('GET', `/api/integrations/meta/callback?${new URLSearchParams({ code: 'c', state })}`);

  assert.equal((await request('DELETE', '/api/integrations/meta', { token })).status, 200);

  const status = (await request('GET', '/api/integrations/meta/status', { token })).json;
  assert.equal(status.connected, false);
  assert.equal(status.configured, true);
  assert.equal(status.setup.appId, APP.appId);
});

test('an app set in the server environment cannot be overwritten from the CRM', async () => {
  const { token } = await createUser('admin');
  process.env.META_APP_ID = '1234567890';
  process.env.META_APP_SECRET = 'env-secret';

  try {
    assert.equal((await saveApp(token)).status, 409);
    const status = (await request('GET', '/api/integrations/meta/status', { token })).json;
    assert.equal(status.setup.source, 'env');
    assert.equal(await MetaIntegration.countDocuments(), 0);
  } finally {
    delete process.env.META_APP_ID;
    delete process.env.META_APP_SECRET;
  }
});
