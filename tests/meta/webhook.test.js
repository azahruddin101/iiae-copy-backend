const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  startTestApp,
  stopTestApp,
  resetState,
  getGraphCalls,
  request,
  seedIntegration,
  signPayload,
  leadgenPayload,
  postWebhook,
} = require('./helpers');
const MetaLead = require('../../src/models/MetaLead');

before(startTestApp);
after(stopTestApp);
beforeEach(resetState);

const verifyUrl = (params) => `/api/webhooks/meta?${new URLSearchParams(params)}`;

test('GET verification echoes the challenge for the correct verify token', async () => {
  const res = await request(
    'GET',
    verifyUrl({ 'hub.mode': 'subscribe', 'hub.verify_token': 'test-verify-token', 'hub.challenge': '1158201444' })
  );
  assert.equal(res.status, 200);
  assert.equal(res.text, '1158201444');
});

test('GET verification rejects an invalid verify token or mode', async () => {
  const wrongToken = await request(
    'GET',
    verifyUrl({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1158201444' })
  );
  assert.equal(wrongToken.status, 403);
  assert.ok(!wrongToken.text.includes('1158201444'));

  const wrongMode = await request(
    'GET',
    verifyUrl({ 'hub.mode': 'unsubscribe', 'hub.verify_token': 'test-verify-token', 'hub.challenge': '1' })
  );
  assert.equal(wrongMode.status, 403);

  assert.equal((await request('GET', '/api/webhooks/meta')).status, 403);
});

test('POST with an invalid or missing signature is rejected and nothing is queued', async () => {
  await seedIntegration();
  const payload = leadgenPayload();

  const invalid = await postWebhook(payload, { signature: 'sha256=' + '0'.repeat(64) });
  assert.equal(invalid.status, 401);

  const wrongSecret = await postWebhook(payload, { signature: signPayload(JSON.stringify(payload), 'other-secret') });
  assert.equal(wrongSecret.status, 401);

  const sha1 = await postWebhook(payload, { signature: 'sha1=abcdef' });
  assert.equal(sha1.status, 401);

  const missing = await postWebhook(payload, { signature: null });
  assert.equal(missing.status, 401);

  assert.equal(await MetaLead.countDocuments(), 0);
});

test('signature is verified against the exact raw bytes', async () => {
  await seedIntegration();
  // Same JSON value, different bytes than what was signed
  const signed = JSON.stringify(leadgenPayload());
  const sent = JSON.stringify(leadgenPayload(), null, 2);

  const res = await postWebhook(sent, { signature: signPayload(signed) });
  assert.equal(res.status, 401);
});

test('valid webhook queues the lead and returns 200 without calling the Graph API', async () => {
  await seedIntegration();

  const res = await postWebhook(leadgenPayload());
  assert.equal(res.status, 200);
  assert.equal(res.text, 'EVENT_RECEIVED');

  const leads = await MetaLead.find();
  assert.equal(leads.length, 1);
  assert.equal(leads[0].source, 'META');
  assert.equal(leads[0].externalLeadId, '5550001');
  assert.equal(leads[0].pageId, '111');
  assert.equal(leads[0].formId, '9001');
  assert.equal(leads[0].formName, 'Property Enquiry');
  assert.equal(leads[0].adId, '7001');
  assert.equal(leads[0].processingStatus, 'pending');

  assert.equal(getGraphCalls().length, 0);
});

test('duplicate deliveries of the same lead are stored once', async () => {
  await seedIntegration();

  await postWebhook(leadgenPayload());
  const retry = await postWebhook(leadgenPayload());
  assert.equal(retry.status, 200);

  // Same lead twice inside one delivery, and concurrent deliveries
  const twice = leadgenPayload();
  twice.entry.push(twice.entry[0]);
  await Promise.all([postWebhook(twice), postWebhook(leadgenPayload()), postWebhook(leadgenPayload())]);

  assert.equal(await MetaLead.countDocuments(), 1);
});

test('invalid payloads with a valid signature return 400', async () => {
  await seedIntegration();

  assert.equal((await postWebhook('this is not json')).status, 400);
  assert.equal((await postWebhook({ object: 'page' })).status, 400);
  assert.equal((await postWebhook('[]')).status, 400);
  assert.equal(await MetaLead.countDocuments(), 0);
});

test('malformed leadgen values are ignored', async () => {
  await seedIntegration();

  const res = await postWebhook(leadgenPayload({ leadgen_id: { $ne: '' } }));
  assert.equal(res.status, 200);
  const noForm = await postWebhook(leadgenPayload({ form_id: undefined }));
  assert.equal(noForm.status, 200);

  assert.equal(await MetaLead.countDocuments(), 0);
});

test('events for a Page or form that is not connected are acknowledged but not queued', async () => {
  await seedIntegration();

  // Unknown Page (e.g. the sample payload of the Meta dashboard "Test" button)
  assert.equal((await postWebhook(leadgenPayload({ page_id: '444444444444' }))).status, 200);
  // Page available in the connection but not the selected one
  assert.equal((await postWebhook(leadgenPayload({ page_id: '222', form_id: '9101' }))).status, 200);
  // Form of the selected Page that was not selected
  assert.equal((await postWebhook(leadgenPayload({ form_id: '9002' }))).status, 200);

  assert.equal(await MetaLead.countDocuments(), 0);
});

test('events are ignored when Meta is not connected', async () => {
  const noIntegration = await postWebhook(leadgenPayload());
  assert.equal(noIntegration.status, 200);

  await seedIntegration({ connected: false });
  const disconnected = await postWebhook(leadgenPayload());
  assert.equal(disconnected.status, 200);

  assert.equal(await MetaLead.countDocuments(), 0);
});

test('non-Page objects and non-leadgen fields are acknowledged', async () => {
  await seedIntegration();

  assert.equal((await postWebhook({ object: 'user', entry: [] })).status, 200);

  const feed = leadgenPayload();
  feed.entry[0].changes[0].field = 'feed';
  assert.equal((await postWebhook(feed)).status, 200);

  assert.equal(await MetaLead.countDocuments(), 0);
});
