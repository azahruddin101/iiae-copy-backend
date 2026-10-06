const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  graphError,
  startTestApp,
  stopTestApp,
  resetState,
  setGraphOverrides,
  getGraphCalls,
  createUser,
  request,
  seedIntegration,
} = require('./helpers');
const User = require('../../src/models/User');
const MetaIntegration = require('../../src/models/MetaIntegration');
const MetaLead = require('../../src/models/MetaLead');
const MetaOAuthState = require('../../src/models/MetaOAuthState');
const { decryptToken, sha256Hex } = require('../../src/utils/metaCrypto');
const { META_OAUTH_SCOPES } = require('../../src/config/meta');

before(startTestApp);
after(stopTestApp);
beforeEach(resetState);

const FRONTEND = 'https://crm.example.test/dashboard/integrations/meta';

// Start the flow as an admin and return the state Meta would send back
const startFlow = async (role = 'admin') => {
  const { user, token } = await createUser(role);
  const res = await request('GET', '/api/integrations/meta/connect', { token });
  assert.equal(res.status, 200);
  const url = new URL(res.json.url);
  return { user, token, url, state: url.searchParams.get('state') };
};

const callback = (query) => request('GET', `/api/integrations/meta/callback?${new URLSearchParams(query)}`);

test('connect returns the Facebook Login URL and stores only a hash of the state', async () => {
  const { user, url, state } = await startFlow();

  assert.equal(url.origin + url.pathname, 'https://www.facebook.com/v26.0/dialog/oauth');
  assert.equal(url.searchParams.get('client_id'), process.env.META_APP_ID);
  assert.equal(url.searchParams.get('redirect_uri'), process.env.META_REDIRECT_URI);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.deepEqual(url.searchParams.get('scope').split(','), META_OAUTH_SCOPES);
  assert.ok(state.length >= 32);
  assert.ok(!url.toString().includes(process.env.META_APP_SECRET));

  const stored = await MetaOAuthState.find();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].stateHash, sha256Hex(state));
  assert.equal(String(stored[0].user), String(user._id));
});

test('successful callback stores encrypted Page tokens and redirects to the frontend', async () => {
  const { user, state } = await startFlow();
  const res = await callback({ code: 'auth-code', state });

  assert.equal(res.status, 302);
  assert.equal(res.location, `${FRONTEND}?meta=connected`);

  const integration = await MetaIntegration.findOne({ key: 'default' });
  assert.equal(integration.connected, true);
  assert.equal(integration.metaUserId, '1001');
  assert.equal(String(integration.connectedBy), String(user._id));
  assert.deepEqual(integration.pages.map((p) => p.pageId), ['111', '222']);

  // Tokens are encrypted at rest and can be decrypted by the server
  integration.pages.forEach((page) => {
    assert.ok(!page.accessTokenEncrypted.includes('page-token'));
    assert.equal(decryptToken(page.accessTokenEncrypted), `page-token-${page.pageId}`);
  });
  assert.ok(!JSON.stringify(integration.toObject()).includes('long-user-token'));

  // The code is exchanged with the configured redirect URI, then upgraded to a long-lived token
  const exchanges = getGraphCalls('GET oauth/access_token');
  assert.equal(exchanges[0].params.code, 'auth-code');
  assert.equal(exchanges[0].params.redirect_uri, process.env.META_REDIRECT_URI);
  assert.equal(exchanges[1].params.grant_type, 'fb_exchange_token');
  assert.equal(getGraphCalls('GET me/accounts')[0].params.access_token, 'long-user-token');
  assert.ok(getGraphCalls('GET me/accounts')[0].params.appsecret_proof);
});

test('the OAuth state is single-use', async () => {
  const { state } = await startFlow();
  await callback({ code: 'auth-code', state });

  const replay = await callback({ code: 'auth-code', state });
  assert.equal(replay.location, `${FRONTEND}?meta=error&reason=invalid_state`);
  assert.equal(await MetaOAuthState.countDocuments(), 0);
});

test('callback with an unknown or missing state is rejected', async () => {
  await startFlow();

  const forged = await callback({ code: 'auth-code', state: 'forged-state' });
  assert.equal(forged.location, `${FRONTEND}?meta=error&reason=invalid_state`);

  const missing = await callback({ code: 'auth-code' });
  assert.equal(missing.location, `${FRONTEND}?meta=error&reason=invalid_state`);

  assert.equal(await MetaIntegration.countDocuments(), 0);
  assert.equal(getGraphCalls().length, 0);
});

test('callback with an expired state is rejected', async () => {
  const { state } = await startFlow();
  await MetaOAuthState.updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });

  const res = await callback({ code: 'auth-code', state });
  assert.equal(res.location, `${FRONTEND}?meta=error&reason=invalid_state`);
  assert.equal(getGraphCalls().length, 0);
});

test('OAuth denial redirects with access_denied and consumes the state', async () => {
  const { state } = await startFlow();
  const res = await callback({
    error: 'access_denied',
    error_reason: 'user_denied',
    error_description: 'Permissions error',
    state,
  });

  assert.equal(res.status, 302);
  assert.equal(res.location, `${FRONTEND}?meta=error&reason=access_denied`);
  assert.equal(await MetaOAuthState.countDocuments(), 0);
  assert.equal(await MetaIntegration.countDocuments(), 0);
  assert.equal(getGraphCalls().length, 0);
});

test('Meta API failure during the code exchange does not connect anything', async () => {
  const { state } = await startFlow();
  setGraphOverrides({ 'GET oauth/access_token': () => graphError(400, 100, 'This authorization code has been used.') });

  const res = await callback({ code: 'used-code', state });
  assert.equal(res.location, `${FRONTEND}?meta=error&reason=meta_api_error`);
  assert.equal(await MetaIntegration.countDocuments(), 0);
});

test('Meta being unreachable is reported as a Meta API error', async () => {
  const { state } = await startFlow();
  setGraphOverrides({ 'GET oauth/access_token': 'NETWORK_ERROR' });

  const res = await callback({ code: 'auth-code', state });
  assert.equal(res.location, `${FRONTEND}?meta=error&reason=meta_api_error`);
});

test('callback fails when a required permission was not granted', async () => {
  const { state } = await startFlow();
  setGraphOverrides({
    'GET me/permissions': () => ({
      body: {
        data: META_OAUTH_SCOPES.map((permission) => ({
          permission,
          status: permission === 'leads_retrieval' ? 'declined' : 'granted',
        })),
      },
    }),
  });

  const res = await callback({ code: 'auth-code', state });
  assert.equal(res.location, `${FRONTEND}?meta=error&reason=missing_permissions`);
  assert.equal(await MetaIntegration.countDocuments(), 0);
});

test('callback fails when the Meta account manages no Pages', async () => {
  const { state } = await startFlow();
  setGraphOverrides({ 'GET me/accounts': () => ({ body: { data: [] } }) });

  const res = await callback({ code: 'auth-code', state });
  assert.equal(res.location, `${FRONTEND}?meta=error&reason=no_pages`);
});

test('callback is rejected when the user who started it is no longer an active admin/manager', async () => {
  const { user, state } = await startFlow();
  await User.updateOne({ _id: user._id }, { $set: { role: 'counsellor' } });

  const res = await callback({ code: 'auth-code', state });
  assert.equal(res.location, `${FRONTEND}?meta=error&reason=not_authorized`);
  assert.equal(getGraphCalls().length, 0);
});

test('reconnecting keeps the selected Page and forms and re-queues failed leads', async () => {
  await seedIntegration({ needsReconnect: true });
  await MetaLead.create({ externalLeadId: '5550001', pageId: '111', formId: '9001', processingStatus: 'failed', attempts: 3 });

  const { state } = await startFlow();
  const res = await callback({ code: 'auth-code', state });
  assert.equal(res.location, `${FRONTEND}?meta=connected`);

  const integration = await MetaIntegration.findOne({ key: 'default' });
  assert.equal(integration.needsReconnect, false);
  assert.equal(integration.selectedPageId, '111');
  assert.deepEqual(integration.forms.map((f) => f.formId), ['9001']);
  assert.equal(getGraphCalls('POST 111/subscribed_apps').length, 1);

  const lead = await MetaLead.findOne({ externalLeadId: '5550001' });
  assert.equal(lead.processingStatus, 'pending');
  assert.equal(lead.attempts, 0);
});

test('full flow: pages -> forms -> connect selected -> status -> disconnect', async () => {
  const { token, state } = await startFlow();
  await callback({ code: 'auth-code', state });

  const pages = await request('GET', '/api/integrations/meta/pages', { token });
  assert.deepEqual(pages.json, [
    { pageId: '111', pageName: 'ABC Realty', selected: false },
    { pageId: '222', pageName: 'XYZ Properties', selected: false },
  ]);

  const forms = await request('GET', '/api/integrations/meta/pages/111/forms', { token });
  assert.deepEqual(forms.json.map((f) => f.formId), ['9001', '9002']); // archived form is hidden
  assert.equal(getGraphCalls('GET 111/leadgen_forms')[0].params.access_token, 'page-token-111');

  const connect = await request('POST', '/api/integrations/meta/pages/111/forms', {
    token,
    body: { formIds: ['9001', '9002'] },
  });
  assert.equal(connect.status, 200);
  assert.equal(getGraphCalls('POST 111/subscribed_apps')[0].params.subscribed_fields, 'leadgen');

  const status = await request('GET', '/api/integrations/meta/status', { token });
  assert.equal(status.json.connected, true);
  assert.equal(status.json.receivingLeads, true);
  assert.deepEqual(status.json.selectedPage, { pageId: '111', pageName: 'ABC Realty' });
  assert.deepEqual(status.json.forms.map((f) => f.formName), ['Property Enquiry', 'Site Visit']);

  const disconnect = await request('DELETE', '/api/integrations/meta', { token });
  assert.equal(disconnect.status, 200);
  assert.equal(getGraphCalls('DELETE 111/subscribed_apps').length, 1);

  const integration = await MetaIntegration.findOne({ key: 'default' });
  assert.equal(integration.connected, false);
  assert.equal(integration.pages.length, 0);

  const after = await request('GET', '/api/integrations/meta/status', { token });
  assert.equal(after.json.connected, false);
  assert.equal(after.json.selectedPage, null);
});

test('an expired Meta token is reported as "reconnect required", never as 401', async () => {
  const { token } = await createUser('admin');
  await seedIntegration();
  setGraphOverrides({ 'GET 111/leadgen_forms': () => graphError(400, 190, 'Error validating access token') });

  const res = await request('GET', '/api/integrations/meta/pages/111/forms', { token });
  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'META_RECONNECT_REQUIRED');

  const integration = await MetaIntegration.findOne({ key: 'default' });
  assert.equal(integration.needsReconnect, true);
});

test('Meta rate limits and permission errors map to 429 and 403', async () => {
  const { token } = await createUser('admin');
  await seedIntegration();

  setGraphOverrides({ 'GET 111/leadgen_forms': () => graphError(400, 4, 'Application request limit reached') });
  assert.equal((await request('GET', '/api/integrations/meta/pages/111/forms', { token })).status, 429);

  setGraphOverrides({ 'GET 111/leadgen_forms': () => graphError(403, 200, 'Requires leads_retrieval permission') });
  const denied = await request('GET', '/api/integrations/meta/pages/111/forms', { token });
  assert.equal(denied.status, 403);
  assert.ok(!denied.text.includes('leads_retrieval')); // Meta's raw message is not exposed
});
