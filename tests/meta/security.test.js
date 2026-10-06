const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  startTestApp,
  stopTestApp,
  resetState,
  getGraphCalls,
  createUser,
  request,
  seedIntegration,
} = require('./helpers');
const MetaIntegration = require('../../src/models/MetaIntegration');
const MetaLead = require('../../src/models/MetaLead');
const {
  encryptToken,
  decryptToken,
  verifyWebhookSignature,
  createAppSecretProof,
} = require('../../src/utils/metaCrypto');

before(startTestApp);
after(stopTestApp);
beforeEach(resetState);

// Every authenticated Meta endpoint
const ENDPOINTS = [
  ['GET', '/api/integrations/meta/status'],
  ['GET', '/api/integrations/meta/connect'],
  ['GET', '/api/integrations/meta/pages'],
  ['GET', '/api/integrations/meta/pages/111/forms'],
  ['POST', '/api/integrations/meta/pages/111/forms', { formIds: ['9001'] }],
  ['GET', '/api/integrations/meta/leads'],
  ['GET', '/api/integrations/meta/leads/filters'],
  ['POST', '/api/integrations/meta/leads/retry-failed'],
  ['DELETE', '/api/integrations/meta'],
];

// The CRM is single-tenant, so isolation is enforced by role: only admin/manager may
// see or manage the Meta connection, Pages, forms, tokens and leads.

test('unauthenticated requests are rejected on every Meta endpoint', async () => {
  await seedIntegration();

  for (const [method, path, body] of ENDPOINTS) {
    const noToken = await request(method, path, { body });
    assert.equal(noToken.status, 401, `${method} ${path} without token`);

    const badToken = await request(method, path, { body, token: 'not-a-real-jwt' });
    assert.equal(badToken.status, 401, `${method} ${path} with invalid token`);
  }

  assert.equal(getGraphCalls().length, 0);
  assert.equal((await MetaIntegration.findOne({ key: 'default' })).connected, true);
});

test('telecaller, accountant, teacher and student cannot access any Meta endpoint', async () => {
  await seedIntegration();
  await MetaLead.create({ externalLeadId: '1', pageId: '111', formId: '9001', processingStatus: 'processed', fullName: 'Private Lead' });

  for (const role of ['counsellor', 'accountant', 'teacher', 'student']) {
    const { token } = await createUser(role);
    for (const [method, path, body] of ENDPOINTS) {
      const res = await request(method, path, { token, body });
      assert.equal(res.status, 403, `${role} ${method} ${path}`);
      assert.ok(!res.text.includes('Private Lead'));
      assert.ok(!res.text.includes('ABC Realty'));
    }
  }

  assert.equal(getGraphCalls().length, 0);
  assert.equal((await MetaIntegration.findOne({ key: 'default' })).connected, true);
});

test('inactive users are rejected', async () => {
  await seedIntegration();
  const { token } = await createUser('admin', { status: 'inactive' });

  const res = await request('GET', '/api/integrations/meta/status', { token });
  assert.equal(res.status, 403);
});

test('admin and manager can access the integration', async () => {
  await seedIntegration();

  for (const role of ['admin', 'manager']) {
    const { token } = await createUser(role);
    assert.equal((await request('GET', '/api/integrations/meta/status', { token })).status, 200);
    assert.equal((await request('GET', '/api/integrations/meta/leads', { token })).status, 200);
  }
});

test('access tokens are never returned by any endpoint', async () => {
  const { token } = await createUser('admin');
  const integration = await seedIntegration();
  const encrypted = integration.pages.map((p) => p.accessTokenEncrypted);

  const responses = await Promise.all([
    request('GET', '/api/integrations/meta/status', { token }),
    request('GET', '/api/integrations/meta/pages', { token }),
    request('GET', '/api/integrations/meta/pages/111/forms', { token }),
    request('POST', '/api/integrations/meta/pages/111/forms', { token, body: { formIds: ['9001'] } }),
    request('GET', '/api/integrations/meta/connect', { token }),
  ]);

  responses.forEach((res) => {
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes('page-token'));
    assert.ok(!res.text.includes('accessToken'));
    assert.ok(!res.text.includes(process.env.META_APP_SECRET));
    encrypted.forEach((value) => assert.ok(!res.text.includes(value)));
  });

  // Serializing the document directly also strips the encrypted tokens
  const serialized = JSON.stringify(await MetaIntegration.findOne({ key: 'default' }));
  assert.ok(!serialized.includes('accessTokenEncrypted'));
});

test('a Page ID that is not part of the Meta connection is never trusted', async () => {
  const { token } = await createUser('admin');
  await seedIntegration();

  const forms = await request('GET', '/api/integrations/meta/pages/999/forms', { token });
  assert.equal(forms.status, 404);

  const connect = await request('POST', '/api/integrations/meta/pages/999/forms', { token, body: { formIds: ['9001'] } });
  assert.equal(connect.status, 404);

  assert.equal(getGraphCalls().length, 0);
  assert.equal((await MetaIntegration.findOne({ key: 'default' })).selectedPageId, '111');
});

test('a form that does not belong to the Page cannot be connected', async () => {
  const { token } = await createUser('admin');
  await seedIntegration();

  // 9101 belongs to Page 222, 9003 is archived
  for (const formIds of [['9101'], ['9001', '9101'], ['9003']]) {
    const res = await request('POST', '/api/integrations/meta/pages/111/forms', { token, body: { formIds } });
    assert.equal(res.status, 400);
  }

  for (const body of [{}, { formIds: [] }, { formIds: 'abc' }, { formIds: [{ $ne: null }] }, { formIds: ['12; drop'] }]) {
    const res = await request('POST', '/api/integrations/meta/pages/111/forms', { token, body });
    assert.equal(res.status, 400);
  }

  assert.equal(getGraphCalls('POST 111/subscribed_apps').length, 0);
  const integration = await MetaIntegration.findOne({ key: 'default' });
  assert.deepEqual(integration.forms.map((f) => f.formId), ['9001']);
});

test('switching Pages unsubscribes the previous Page', async () => {
  const { token } = await createUser('admin');
  await seedIntegration();

  const res = await request('POST', '/api/integrations/meta/pages/222/forms', { token, body: { formIds: ['9101'] } });
  assert.equal(res.status, 200);
  assert.equal(getGraphCalls('POST 222/subscribed_apps').length, 1);
  assert.equal(getGraphCalls('DELETE 111/subscribed_apps').length, 1);

  const integration = await MetaIntegration.findOne({ key: 'default' });
  assert.equal(integration.selectedPageId, '222');
});

test('Pages and forms cannot be read when Meta is not connected', async () => {
  const { token } = await createUser('admin');

  assert.equal((await request('GET', '/api/integrations/meta/pages', { token })).status, 409);
  assert.equal((await request('GET', '/api/integrations/meta/pages/111/forms', { token })).status, 404);

  await seedIntegration({ connected: false });
  assert.equal((await request('GET', '/api/integrations/meta/pages/111/forms', { token })).status, 404);
  assert.equal(getGraphCalls().length, 0);
});

test('token encryption round-trips, is randomized and detects tampering', () => {
  const first = encryptToken('EAAB-secret-token');
  const second = encryptToken('EAAB-secret-token');

  assert.notEqual(first, second);
  assert.ok(!first.includes('EAAB-secret-token'));
  assert.equal(decryptToken(first), 'EAAB-secret-token');

  const parts = first.split('.');
  parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => decryptToken(parts.join('.')));
  assert.throws(() => decryptToken('plain-text-token'));
});

test('webhook signature verification and appsecret_proof', () => {
  const body = Buffer.from('{"object":"page"}');
  const crypto = require('crypto');
  const valid = `sha256=${crypto.createHmac('sha256', 'secret').update(body).digest('hex')}`;

  assert.equal(verifyWebhookSignature(body, valid, 'secret'), true);
  assert.equal(verifyWebhookSignature(body, valid, 'other'), false);
  assert.equal(verifyWebhookSignature(body, valid.replace('sha256=', ''), 'secret'), false);
  assert.equal(verifyWebhookSignature(body, undefined, 'secret'), false);
  assert.equal(verifyWebhookSignature(body, valid, ''), false);
  assert.equal(verifyWebhookSignature('{"object":"page"}', valid, 'secret'), false); // must be the raw Buffer

  assert.equal(
    createAppSecretProof('token', 'secret'),
    crypto.createHmac('sha256', 'secret').update('token').digest('hex')
  );
});
