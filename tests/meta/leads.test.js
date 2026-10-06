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
  seedIntegration,
  leadgenPayload,
  postWebhook,
} = require('./helpers');
const MetaIntegration = require('../../src/models/MetaIntegration');
const MetaLead = require('../../src/models/MetaLead');
const {
  MAX_ATTEMPTS,
  normalizeMetaLead,
  processPendingLeads,
} = require('../../src/workers/metaLeadWorker');

before(startTestApp);
after(stopTestApp);
beforeEach(resetState);

const getLead = () => MetaLead.findOne({ externalLeadId: '5550001' });

// Make a lead that is waiting for a retry due immediately
const makeDue = () => MetaLead.updateMany({}, { $set: { nextAttemptAt: new Date(Date.now() - 1000) } });

test('webhook -> queue -> worker retrieves, normalizes and stores the lead', async () => {
  await seedIntegration();
  await postWebhook(leadgenPayload());

  assert.equal(await processPendingLeads(), 1);

  const call = getGraphCalls('GET 5550001')[0];
  assert.equal(call.params.access_token, 'page-token-111');
  assert.ok(call.params.fields.includes('field_data'));

  const lead = await getLead();
  assert.equal(lead.processingStatus, 'processed');
  assert.equal(lead.source, 'META');
  assert.equal(lead.fullName, 'Riya Sharma');
  assert.equal(lead.email, 'riya@example.test');
  assert.equal(lead.phone, '+919999900000');
  assert.equal(lead.campaignId, '5001');
  assert.equal(lead.adSetId, '6001');
  assert.equal(lead.adId, '7001');
  assert.equal(lead.fields['which_course_interests_you?'], 'AME');
  assert.deepEqual(lead.rawData, SAMPLE_LEAD);
  assert.equal(lead.leadCreatedAt.toISOString(), '2026-09-20T10:15:00.000Z');
  assert.ok(lead.processedAt);

  const integration = await MetaIntegration.findOne({ key: 'default' });
  assert.ok(integration.lastLeadReceivedAt);

  // Nothing left to do
  assert.equal(await processPendingLeads(), 0);
});

test('forms without name/email/phone are stored with their own dynamic fields', async () => {
  const normalized = normalizeMetaLead({
    id: '1',
    created_time: '2026-09-20T10:15:00+0000',
    field_data: [
      { name: 'budget.range', values: ['50-75 lakh'] },
      { name: '$preferred_city', values: ['Delhi', 'Noida'] },
      { name: '', values: ['unnamed answer'] },
      { name: '__proto__', values: ['x'] },
    ],
  });

  assert.deepEqual(normalized.fields, {
    budget_range: '50-75 lakh',
    preferred_city: ['Delhi', 'Noida'],
    field_3: 'unnamed answer',
    proto__: 'x',
  });
  assert.equal(normalized.fullName, '');
  assert.equal(normalized.email, '');
  assert.equal(normalized.phone, '');
  assert.ok(normalized.searchText.includes('noida'));
  assert.equal('campaignId' in normalized, false);
});

test('duplicate webhook events never create a second lead or a second Graph call', async () => {
  await seedIntegration();

  await postWebhook(leadgenPayload());
  await processPendingLeads();
  await postWebhook(leadgenPayload());
  await processPendingLeads();

  assert.equal(await MetaLead.countDocuments(), 1);
  assert.equal(getGraphCalls('GET 5550001').length, 1);
  assert.equal((await getLead()).processingStatus, 'processed');
});

test('the unique index rejects a second document for the same Meta lead ID', async () => {
  await MetaLead.create({ externalLeadId: '5550001', pageId: '111', formId: '9001' });
  await assert.rejects(
    MetaLead.create({ externalLeadId: '5550001', pageId: '111', formId: '9001' }),
    (error) => error.code === 11000
  );
});

test('missing integration: the lead fails without calling Meta', async () => {
  await seedIntegration();
  await postWebhook(leadgenPayload());
  await MetaIntegration.deleteMany({});

  await processPendingLeads();

  const lead = await getLead();
  assert.equal(lead.processingStatus, 'failed');
  assert.equal(lead.lastError, 'MISSING_INTEGRATION');
  assert.equal(getGraphCalls().length, 0);
});

test('invalid Page: a lead for a Page that is no longer in the connection fails', async () => {
  await seedIntegration();
  await postWebhook(leadgenPayload());
  await MetaIntegration.updateOne({}, { $pull: { pages: { pageId: '111' } } });

  await processPendingLeads();

  const lead = await getLead();
  assert.equal(lead.processingStatus, 'failed');
  assert.equal(lead.lastError, 'INVALID_PAGE');
  assert.equal(getGraphCalls().length, 0);
});

test('queue retry: a transient Meta failure is retried with backoff and then succeeds', async () => {
  await seedIntegration();
  await postWebhook(leadgenPayload());
  setGraphOverrides({ 'GET 5550001': () => graphError(500, 2, 'Service temporarily unavailable') });

  await processPendingLeads();

  let lead = await getLead();
  assert.equal(lead.processingStatus, 'pending');
  assert.equal(lead.attempts, 1);
  assert.equal(lead.lastError, 'META_TRANSIENT');
  assert.ok(lead.nextAttemptAt > new Date());

  // Not due yet - the worker leaves it alone
  assert.equal(await processPendingLeads(), 0);

  // Meta recovers and the retry becomes due
  setGraphOverrides({});
  await makeDue();
  assert.equal(await processPendingLeads(), 1);

  lead = await getLead();
  assert.equal(lead.processingStatus, 'processed');
  assert.equal(lead.attempts, 2);
  assert.equal(lead.lastError, undefined);
  assert.equal(lead.fullName, 'Riya Sharma');
});

test('network errors and rate limits are retried, rate limits wait longer', async () => {
  await seedIntegration();
  await postWebhook(leadgenPayload());

  setGraphOverrides({ 'GET 5550001': 'NETWORK_ERROR' });
  await processPendingLeads();
  let lead = await getLead();
  assert.equal(lead.processingStatus, 'pending');
  assert.equal(lead.lastError, 'META_NETWORK');
  const networkDelay = lead.nextAttemptAt - Date.now();

  await MetaLead.updateMany({}, { $set: { nextAttemptAt: new Date(Date.now() - 1000), attempts: 0 } });
  setGraphOverrides({ 'GET 5550001': () => graphError(400, 4, 'Application request limit reached') });
  await processPendingLeads();
  lead = await getLead();
  assert.equal(lead.processingStatus, 'pending');
  assert.equal(lead.lastError, 'META_RATE_LIMIT');
  assert.ok(lead.nextAttemptAt - Date.now() > networkDelay);
});

test('a lead that keeps failing is marked failed after the maximum attempts', async () => {
  await seedIntegration();
  await postWebhook(leadgenPayload());
  setGraphOverrides({ 'GET 5550001': () => graphError(503, 2, 'Service unavailable') });

  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    await makeDue();
    await processPendingLeads();
  }

  const lead = await getLead();
  assert.equal(lead.processingStatus, 'failed');
  assert.equal(lead.attempts, MAX_ATTEMPTS);

  await makeDue();
  assert.equal(await processPendingLeads(), 0);
});

test('an invalid token fails the lead and flags the integration for reconnect', async () => {
  await seedIntegration();
  await postWebhook(leadgenPayload());
  setGraphOverrides({ 'GET 5550001': () => graphError(400, 190, 'Error validating access token') });

  await processPendingLeads();

  const lead = await getLead();
  assert.equal(lead.processingStatus, 'failed');
  assert.equal(lead.lastError, 'META_TOKEN_INVALID');
  assert.equal((await MetaIntegration.findOne({ key: 'default' })).needsReconnect, true);
});

test('ad-level fields that cannot be read fall back to the basic lead fields', async () => {
  await seedIntegration();
  await postWebhook(leadgenPayload());
  setGraphOverrides({
    'GET 5550001': ({ params }) =>
      params.fields.includes('campaign_id')
        ? graphError(403, 200, 'Requires ads_management permission')
        : { body: { id: '5550001', created_time: SAMPLE_LEAD.created_time, form_id: '9001', field_data: SAMPLE_LEAD.field_data } },
  });

  await processPendingLeads();

  const lead = await getLead();
  assert.equal(lead.processingStatus, 'processed');
  assert.equal(lead.fullName, 'Riya Sharma');
  assert.equal(lead.adId, '7001'); // kept from the webhook
  assert.equal(lead.campaignId, undefined);
});

test('a lead stuck in processing (crashed worker) is picked up again', async () => {
  await seedIntegration();
  await postWebhook(leadgenPayload());
  await MetaLead.updateMany({}, { $set: { processingStatus: 'processing', lockedAt: new Date(Date.now() - 10 * 60 * 1000) } });

  assert.equal(await processPendingLeads(), 1);
  assert.equal((await getLead()).processingStatus, 'processed');
});

test('retry-failed endpoint re-queues failed leads', async () => {
  const { token } = await createUser('manager');
  await seedIntegration();
  await postWebhook(leadgenPayload());
  setGraphOverrides({ 'GET 5550001': () => graphError(400, 190, 'Error validating access token') });
  await processPendingLeads();
  setGraphOverrides({});

  const res = await request('POST', '/api/integrations/meta/leads/retry-failed', { token });
  assert.equal(res.status, 200);
  assert.equal(res.json.requeued, 1);

  await processPendingLeads();
  assert.equal((await getLead()).processingStatus, 'processed');
});

// ---- Lead list -------------------------------------------------------------

const seedLeads = async () => {
  const docs = [];
  for (let i = 1; i <= 25; i += 1) {
    docs.push({
      externalLeadId: String(1000 + i),
      pageId: '111',
      pageName: 'ABC Realty',
      formId: i % 2 === 0 ? '9002' : '9001',
      formName: i % 2 === 0 ? 'Site Visit' : 'Property Enquiry',
      fullName: `Lead ${i}`,
      searchText: `lead ${i} lead${i}@example.test`,
      fields: { full_name: `Lead ${i}` },
      rawData: { id: String(1000 + i) },
      leadCreatedAt: new Date(Date.UTC(2026, 8, i, 12)),
      processingStatus: 'processed',
    });
  }
  docs.push({ externalLeadId: '2001', pageId: '111', formId: '9001', processingStatus: 'pending' });
  docs.push({ externalLeadId: '2002', pageId: '111', formId: '9001', processingStatus: 'failed' });
  await MetaLead.insertMany(docs);
};

test('lead list is paginated on the server, newest first, without internal fields', async () => {
  const { token } = await createUser('admin');
  await seedLeads();

  const first = await request('GET', '/api/integrations/meta/leads?page=1&limit=10', { token });
  assert.equal(first.status, 200);
  assert.equal(first.json.total, 25); // pending + failed leads are not listed
  assert.equal(first.json.totalPages, 3);
  assert.equal(first.json.leads.length, 10);
  assert.equal(first.json.leads[0].fullName, 'Lead 25');
  assert.deepEqual(first.json.leads[0].fields, { full_name: 'Lead 25' });
  ['rawData', 'searchText', 'processingStatus', 'attempts', 'lastError'].forEach((key) => {
    assert.equal(key in first.json.leads[0], false);
  });

  const last = await request('GET', '/api/integrations/meta/leads?page=3&limit=10', { token });
  assert.equal(last.json.leads.length, 5);

  const capped = await request('GET', '/api/integrations/meta/leads?limit=100000', { token });
  assert.equal(capped.json.limit, 100);
});

test('lead list supports search, form, page and date filters', async () => {
  const { token } = await createUser('admin');
  await seedLeads();
  const list = (query) => request('GET', `/api/integrations/meta/leads?${new URLSearchParams(query)}`, { token });

  const search = await list({ search: 'LEAD7@example' });
  assert.deepEqual(search.json.leads.map((l) => l.fullName), ['Lead 7']);

  // Regex characters in the search term are treated literally
  assert.equal((await list({ search: '.*' })).json.total, 0);

  assert.equal((await list({ formId: '9002' })).json.total, 12);
  assert.equal((await list({ pageId: '111' })).json.total, 25);
  assert.equal((await list({ pageId: '999' })).json.total, 0);

  const dated = await list({ from: '2026-09-10T00:00:00.000Z', to: '2026-09-12T23:59:59.999Z' });
  assert.deepEqual(dated.json.leads.map((l) => l.fullName), ['Lead 12', 'Lead 11', 'Lead 10']);

  assert.equal((await list({ from: 'not-a-date' })).status, 400);

  const filters = await request('GET', '/api/integrations/meta/leads/filters', { token });
  assert.deepEqual(filters.json.pages, [{ pageId: '111', pageName: 'ABC Realty' }]);
  assert.deepEqual(filters.json.forms.map((f) => f.formId).sort(), ['9001', '9002']);
});
