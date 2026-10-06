// Historical lead backfill ("Sync Previous Leads")

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
  leadgenPayload,
  postWebhook,
} = require('./helpers');
const MetaIntegration = require('../../src/models/MetaIntegration');
const MetaLead = require('../../src/models/MetaLead');
const MetaSyncJob = require('../../src/models/MetaSyncJob');
const { processPendingLeads } = require('../../src/workers/metaLeadWorker');
const {
  SYNC_SETTINGS,
  LOCK_TIMEOUT_MS,
  MAX_FORM_ATTEMPTS,
  processPendingSyncJobs,
} = require('../../src/workers/metaSyncWorker');

const FORMS = [
  { formId: '9001', formName: 'Solar CRM Form_3' },
  { formId: '9002', formName: 'Solar CRM Form_2' },
  { formId: '9003', formName: 'Solar CRM' },
  { formId: '9004', formName: 'Ecommerce form' },
];

let admin;

before(async () => {
  await startTestApp();
  // No waiting between pages or retries while testing
  SYNC_SETTINGS.pageDelayMs = 0;
  SYNC_SETTINGS.retryDelaysMs = [0, 0];
});
after(stopTestApp);
beforeEach(async () => {
  await resetState();
  SYNC_SETTINGS.pageSize = 100;
  admin = await createUser('admin');
});

// ---- Fake Meta data ---------------------------------------------------------

const makeLeads = (formId, count, firstId) =>
  Array.from({ length: count }, (unused, i) => ({
    id: String(firstId + i),
    created_time: new Date(Date.UTC(2026, 8, 1) + i * 60000).toISOString(),
    form_id: formId,
    ad_id: '7001',
    campaign_id: '5001',
    campaign_name: 'Solar 2026',
    field_data: [
      { name: 'full_name', values: [`Customer ${firstId + i}`] },
      { name: 'phone_number', values: [`+9190000${firstId + i}`] },
      { name: 'roof_type', values: ['Flat'] },
    ],
  }));

// GET /{form-id}/leads handler with real cursor pagination (the cursor is the offset)
const pagedLeads = (leads) => ({ params }) => {
  const limit = Number(params.limit);
  const start = params.after ? Number(params.after) : 0;
  const end = start + limit;
  const paging = { cursors: { before: String(start), after: String(end) } };
  if (end < leads.length) paging.next = `https://graph.facebook.com/v26.0/form/leads?after=${end}&limit=${limit}`;
  return { body: { data: leads.slice(start, end), paging } };
};

const startSync = (token = admin.token, body) => request('POST', '/api/integrations/meta/sync', { token, body });
const syncStatus = async (token = admin.token) =>
  (await request('GET', '/api/integrations/meta/sync/status', { token })).json.sync;
const makeDue = () => MetaSyncJob.updateMany({}, { $set: { nextAttemptAt: new Date(Date.now() - 1000) } });

// ---- 1. One form -----------------------------------------------------------

test('one form with historical leads is imported and the lead count refreshes', async () => {
  await seedIntegration();
  setGraphOverrides({ 'GET 9001/leads': pagedLeads(makeLeads('9001', 45, 1000)) });

  const started = await startSync();
  assert.equal(started.status, 202);
  assert.equal(started.json.sync.status, 'pending');
  assert.equal(started.json.sync.totalForms, 1);

  assert.equal(await processPendingSyncJobs(), 1);

  const sync = await syncStatus();
  assert.equal(sync.status, 'completed');
  assert.equal(sync.formsProcessed, 1);
  assert.equal(sync.leadsProcessed, 45);
  assert.equal(sync.leadsImported, 45);
  assert.equal(sync.duplicatesSkipped, 0);
  assert.equal(sync.failedLeads, 0);
  assert.ok(sync.startedAt && sync.completedAt);
  assert.equal(sync.error, null);

  // Stored exactly like webhook leads: dedicated MetaLead model, processed, normalized
  const lead = await MetaLead.findOne({ externalLeadId: '1000' });
  assert.equal(lead.source, 'META');
  assert.equal(lead.processingStatus, 'processed');
  assert.equal(lead.pageId, '111');
  assert.equal(lead.formId, '9001');
  assert.equal(lead.formName, 'Property Enquiry');
  assert.equal(lead.fullName, 'Customer 1000');
  assert.equal(lead.fields.roof_type, 'Flat');
  assert.equal(lead.campaignName, 'Solar 2026');
  assert.equal(lead.rawData.id, '1000');
  assert.equal(lead.isDeleted, false);

  // The page token is used, with the documented fields
  const call = getGraphCalls('GET 9001/leads')[0];
  assert.equal(call.params.access_token, 'page-token-111');
  ['id', 'created_time', 'field_data', 'form_id', 'ad_id'].forEach((field) => assert.ok(call.params.fields.includes(field)));

  const status = await request('GET', '/api/integrations/meta/status', { token: admin.token });
  assert.equal(status.json.leadCounts.processed, 45);
  const list = await request('GET', '/api/integrations/meta/leads?limit=5', { token: admin.token });
  assert.equal(list.json.total, 45);
});

// ---- 2. Multiple forms, 7. unavailable leads --------------------------------

test('multiple forms are synced independently: a failing form does not lose the others', async () => {
  await seedIntegration({ forms: FORMS });
  setGraphOverrides({
    'GET 9001/leads': pagedLeads(makeLeads('9001', 245, 10000)),
    'GET 9002/leads': pagedLeads(makeLeads('9002', 187, 20000)),
    // Meta no longer serves this form's leads
    'GET 9003/leads': () => graphError(400, 100, 'Unsupported get request. Object does not exist or has expired', { error_subcode: 33 }),
    'GET 9004/leads': pagedLeads(makeLeads('9004', 61, 40000)),
  });

  await startSync();
  await processPendingSyncJobs();

  const sync = await syncStatus();
  assert.equal(sync.status, 'completed');
  assert.equal(sync.totalForms, 4);
  assert.equal(sync.formsProcessed, 4);
  assert.equal(sync.formsFailed, 1);
  assert.equal(sync.leadsImported, 245 + 187 + 61);
  assert.deepEqual(
    sync.forms.map((f) => [f.formName, f.status, f.leadsProcessed]),
    [
      ['Solar CRM Form_3', 'completed', 245],
      ['Solar CRM Form_2', 'completed', 187],
      ['Solar CRM', 'failed', 0],
      ['Ecommerce form', 'completed', 61],
    ]
  );
  // The failure is reported clearly, including Meta's retention limit, without Meta's raw message
  assert.ok(sync.forms[2].error.includes('90 days'));
  assert.ok(!JSON.stringify(sync).includes('Unsupported get request'));

  assert.equal(await MetaLead.countDocuments({ formId: '9001' }), 245);
  assert.equal(await MetaLead.countDocuments({ formId: '9004' }), 61);
  assert.equal(await MetaLead.countDocuments({ formId: '9003' }), 0);
});

test('lead entries Meta returns without usable data are counted as failed, the rest are imported', async () => {
  await seedIntegration();
  const leads = makeLeads('9001', 5, 500);
  leads.splice(2, 0, { created_time: '2026-09-01T00:00:00+0000' }, null, { id: 'not-a-number' });
  setGraphOverrides({ 'GET 9001/leads': pagedLeads(leads) });

  await startSync();
  await processPendingSyncJobs();

  const sync = await syncStatus();
  assert.equal(sync.leadsProcessed, 8);
  assert.equal(sync.leadsImported, 5);
  assert.equal(sync.failedLeads, 3);
  assert.equal(await MetaLead.countDocuments(), 5);
});

// ---- 3. Pagination -----------------------------------------------------------

test('every page is followed through the cursor until Meta returns no next page', async () => {
  await seedIntegration();
  SYNC_SETTINGS.pageSize = 100;
  setGraphOverrides({ 'GET 9001/leads': pagedLeads(makeLeads('9001', 250, 3000)) });

  await startSync();
  await processPendingSyncJobs();

  const calls = getGraphCalls('GET 9001/leads');
  assert.deepEqual(calls.map((c) => c.params.after), [undefined, '100', '200']);
  assert.ok(calls.every((c) => c.params.limit === '100'));

  assert.equal(await MetaLead.countDocuments(), 250);
  // First and last lead of every page made it
  for (const id of ['3000', '3099', '3100', '3199', '3200', '3249']) {
    assert.ok(await MetaLead.exists({ externalLeadId: id }), `lead ${id}`);
  }
  assert.equal((await syncStatus()).leadsImported, 250);
});

test('a next link without cursors is still followed', async () => {
  await seedIntegration();
  const leads = makeLeads('9001', 150, 100);
  setGraphOverrides({
    'GET 9001/leads': ({ params }) => {
      const start = params.after ? Number(params.after) : 0;
      const paging = start === 0 ? { next: 'https://graph.facebook.com/v26.0/9001/leads?limit=100&after=100' } : {};
      return { body: { data: leads.slice(start, start + 100), paging } };
    },
  });

  await startSync();
  await processPendingSyncJobs();
  assert.equal(await MetaLead.countDocuments(), 150);
});

// ---- 4. Running twice --------------------------------------------------------

test('running the sync twice imports nothing the second time', async () => {
  await seedIntegration({ forms: FORMS.slice(0, 2) });
  setGraphOverrides({
    'GET 9001/leads': pagedLeads(makeLeads('9001', 300, 10000)),
    'GET 9002/leads': pagedLeads(makeLeads('9002', 200, 20000)),
  });

  await startSync();
  await processPendingSyncJobs();
  const first = await syncStatus();
  assert.equal(first.leadsImported, 500);
  assert.equal(first.duplicatesSkipped, 0);

  const before = await MetaLead.findOne({ externalLeadId: '10000' }).lean();

  const second = await startSync();
  assert.equal(second.status, 202);
  assert.notEqual(second.json.sync.id, first.id);
  await processPendingSyncJobs();

  const result = await syncStatus();
  assert.equal(result.status, 'completed');
  assert.equal(result.leadsProcessed, 500);
  assert.equal(result.leadsImported, 0);
  assert.equal(result.duplicatesSkipped, 500);
  assert.equal(result.failedLeads, 0);

  assert.equal(await MetaLead.countDocuments(), 500);
  // Existing leads are not touched by the second run
  assert.deepEqual(await MetaLead.findOne({ externalLeadId: '10000' }).lean(), before);
});

// ---- 5. Webhook + historical sync --------------------------------------------

test('a lead already stored through the webhook is skipped as a duplicate', async () => {
  await seedIntegration();
  setGraphOverrides({ 'GET 9001/leads': pagedLeads(makeLeads('9001', 10, 5550000)) });

  // Lead 5550001 arrives in real time and is fully processed first
  await postWebhook(leadgenPayload());
  await processPendingLeads();
  assert.equal((await MetaLead.findOne({ externalLeadId: '5550001' })).fullName, 'Riya Sharma');

  await startSync();
  await processPendingSyncJobs();

  const sync = await syncStatus();
  assert.equal(sync.leadsImported, 9);
  assert.equal(sync.duplicatesSkipped, 1);
  assert.equal(await MetaLead.countDocuments(), 10);
  // The webhook copy was not overwritten
  assert.equal((await MetaLead.findOne({ externalLeadId: '5550001' })).fullName, 'Riya Sharma');
});

test('a lead the webhook only queued is completed by the sync, and the webhook after a sync is a no-op', async () => {
  await seedIntegration();
  setGraphOverrides({ 'GET 9001/leads': pagedLeads(makeLeads('9001', 10, 5550000)) });

  // Webhook stored the lead ID but the worker has not fetched it yet
  await postWebhook(leadgenPayload());
  assert.equal((await MetaLead.findOne({ externalLeadId: '5550001' })).processingStatus, 'pending');

  await startSync();
  await processPendingSyncJobs();

  const sync = await syncStatus();
  assert.equal(sync.leadsImported, 10);
  assert.equal(sync.duplicatesSkipped, 0);
  assert.equal(await MetaLead.countDocuments(), 10);

  const lead = await MetaLead.findOne({ externalLeadId: '5550001' });
  assert.equal(lead.processingStatus, 'processed');
  assert.equal(lead.fullName, 'Customer 5550001');

  // The lead worker has nothing left to fetch for it
  assert.equal(await processPendingLeads(), 0);
  assert.equal(getGraphCalls('GET 5550001').length, 0);

  // The same lead delivered again by webhook afterwards changes nothing
  assert.equal((await postWebhook(leadgenPayload())).status, 200);
  assert.equal(await processPendingLeads(), 0);
  assert.equal(await MetaLead.countDocuments(), 10);
});

test('webhooks arriving while a sync is running never create duplicates', async () => {
  await seedIntegration();
  const leads = makeLeads('9001', 300, 70000);
  setGraphOverrides({
    'GET 9001/leads': pagedLeads(leads),
    // Real-time retrieval of the same leads by the lead worker
    ...Object.fromEntries(leads.slice(0, 60).map((lead) => [`GET ${lead.id}`, () => ({ body: lead })])),
  });

  await startSync();
  const webhooks = leads.slice(0, 60).map((lead) => postWebhook(leadgenPayload({ leadgen_id: lead.id })));

  // Sync, webhook deliveries and the real-time worker all run at the same time
  await Promise.all([processPendingSyncJobs(), processPendingLeads(), ...webhooks]);
  await processPendingLeads();

  assert.equal(await MetaLead.countDocuments(), 300);
  const ids = await MetaLead.distinct('externalLeadId');
  assert.equal(ids.length, 300);
  assert.equal(await MetaLead.countDocuments({ processingStatus: 'processed' }), 300);

  const sync = await syncStatus();
  assert.equal(sync.leadsProcessed, 300);
  assert.equal(sync.leadsImported + sync.duplicatesSkipped, 300);
  assert.equal(sync.failedLeads, 0);
});

// ---- 6. Meta API failures ----------------------------------------------------

test('a transient Meta error is retried and the sync completes', async () => {
  await seedIntegration();
  const paged = pagedLeads(makeLeads('9001', 150, 100));
  let failures = 2;
  setGraphOverrides({
    'GET 9001/leads': (request) => {
      if (request.params.after === '100' && failures > 0) {
        failures -= 1;
        return graphError(500, 2, 'Service temporarily unavailable');
      }
      return paged(request);
    },
  });

  await startSync();
  await processPendingSyncJobs();

  const sync = await syncStatus();
  assert.equal(sync.status, 'completed');
  assert.equal(sync.leadsImported, 150);
  assert.equal(getGraphCalls('GET 9001/leads').length, 4); // page 1, page 2 x3
});

test('when Meta stays down the job waits in the queue, keeps its progress and resumes from the saved cursor', async () => {
  await seedIntegration();
  const paged = pagedLeads(makeLeads('9001', 250, 100));
  let metaDown = true;
  setGraphOverrides({
    'GET 9001/leads': (request) => (request.params.after === '200' && metaDown ? graphError(503, 2, 'Service unavailable') : paged(request)),
  });

  await startSync();
  await processPendingSyncJobs();

  let sync = await syncStatus();
  assert.equal(sync.status, 'pending');
  assert.ok(new Date(sync.retryAt) > new Date());
  assert.equal(sync.leadsImported, 200); // progress of the first two pages is kept
  assert.equal(await MetaLead.countDocuments(), 200);

  // Not due yet
  assert.equal(await processPendingSyncJobs(), 0);

  metaDown = false;
  await makeDue();
  const callsBefore = getGraphCalls('GET 9001/leads').length;
  assert.equal(await processPendingSyncJobs(), 1);

  sync = await syncStatus();
  assert.equal(sync.status, 'completed');
  assert.equal(sync.leadsProcessed, 250);
  assert.equal(sync.leadsImported, 250);
  assert.equal(sync.duplicatesSkipped, 0);
  // Only the remaining page was requested
  const resumed = getGraphCalls('GET 9001/leads').slice(callsBefore);
  assert.deepEqual(resumed.map((c) => c.params.after), ['200']);
});

test('a form that keeps failing is given up after the maximum attempts and the other forms still sync', async () => {
  await seedIntegration({ forms: FORMS.slice(0, 2) });
  setGraphOverrides({
    'GET 9001/leads': () => graphError(503, 2, 'Service unavailable'),
    'GET 9002/leads': pagedLeads(makeLeads('9002', 30, 20000)),
  });

  await startSync();
  for (let i = 0; i < MAX_FORM_ATTEMPTS; i += 1) {
    await makeDue();
    await processPendingSyncJobs();
  }

  const sync = await syncStatus();
  assert.equal(sync.status, 'completed');
  assert.equal(sync.formsFailed, 1);
  assert.equal(sync.forms[0].status, 'failed');
  assert.ok(sync.forms[0].error.includes('unavailable or rate limited'));
  assert.equal(sync.forms[1].leadsImported, 30);
});

test('rate limits are not hammered: no immediate retry, the job waits longer', async () => {
  await seedIntegration();
  setGraphOverrides({ 'GET 9001/leads': () => graphError(400, 4, 'Application request limit reached') });

  await startSync();
  await processPendingSyncJobs();

  assert.equal(getGraphCalls('GET 9001/leads').length, 1); // a single request - no retry loop
  const job = await MetaSyncJob.findOne();
  assert.equal(job.status, 'pending');
  assert.ok(job.nextAttemptAt - Date.now() > 4 * 60 * 1000);
});

test('an invalid token is permanent: the job fails, nothing is retried, Meta is flagged for reconnect', async () => {
  await seedIntegration({ forms: FORMS.slice(0, 3) });
  setGraphOverrides({
    'GET 9001/leads': pagedLeads(makeLeads('9001', 20, 10000)),
    'GET 9002/leads': () => graphError(400, 190, 'Error validating access token: session has been invalidated'),
    'GET 9003/leads': pagedLeads(makeLeads('9003', 20, 30000)),
  });

  await startSync();
  await processPendingSyncJobs();

  const sync = await syncStatus();
  assert.equal(sync.status, 'completed'); // form 1 was imported before the token failed
  assert.equal(sync.leadsImported, 20);
  assert.deepEqual(sync.forms.map((f) => f.status), ['completed', 'failed', 'failed']);
  assert.ok(sync.forms[1].error.includes('Reconnect Meta'));
  assert.equal(getGraphCalls('GET 9002/leads').length, 1);
  assert.equal(getGraphCalls('GET 9003/leads').length, 0);

  assert.equal((await MetaIntegration.findOne({ key: 'default' })).needsReconnect, true);
  assert.equal(await processPendingSyncJobs(), 0);

  // A new sync is refused until Meta is reconnected
  const again = await startSync();
  assert.equal(again.status, 409);
  assert.equal(again.json.code, 'META_RECONNECT_REQUIRED');
});

test('a permission error on a form is reported and not retried', async () => {
  await seedIntegration();
  setGraphOverrides({ 'GET 9001/leads': () => graphError(403, 200, 'Requires leads_retrieval permission') });

  await startSync();
  await processPendingSyncJobs();

  const sync = await syncStatus();
  assert.equal(sync.status, 'failed');
  assert.ok(sync.forms[0].error.includes('leads access'));
  assert.ok(sync.error.includes('leads access'));
  assert.ok(!JSON.stringify(sync).includes('leads_retrieval'));
  assert.equal(await processPendingSyncJobs(), 0);
});

test('ad-level fields that are not readable fall back to the basic lead fields', async () => {
  await seedIntegration();
  const paged = pagedLeads(makeLeads('9001', 120, 100));
  setGraphOverrides({
    'GET 9001/leads': (request) =>
      request.params.fields.includes('campaign_id') ? graphError(403, 200, 'Requires ads_management') : paged(request),
  });

  await startSync();
  await processPendingSyncJobs();

  assert.equal((await syncStatus()).leadsImported, 120);
  // Full fields are tried once, then every page uses the basic fields
  assert.equal(getGraphCalls('GET 9001/leads').filter((c) => c.params.fields.includes('campaign_id')).length, 1);
});

// ---- 8. Large number of leads ------------------------------------------------

test('a large backlog is imported completely', async () => {
  await seedIntegration({ forms: FORMS.slice(0, 2) });
  setGraphOverrides({
    'GET 9001/leads': pagedLeads(makeLeads('9001', 3500, 1000000)),
    'GET 9002/leads': pagedLeads(makeLeads('9002', 1500, 2000000)),
  });

  await startSync();
  await processPendingSyncJobs();

  const sync = await syncStatus();
  assert.equal(sync.status, 'completed');
  assert.equal(sync.leadsProcessed, 5000);
  assert.equal(sync.leadsImported, 5000);
  assert.equal(await MetaLead.countDocuments(), 5000);
  assert.equal((await MetaLead.distinct('externalLeadId')).length, 5000);
  assert.equal(getGraphCalls('GET 9001/leads').length, 35);
  assert.equal(getGraphCalls('GET 9002/leads').length, 15);
});

// ---- 9. Browser refresh during a sync ----------------------------------------

test('progress is served from the database while the sync runs, and a second start joins the running sync', async () => {
  await seedIntegration({ forms: FORMS.slice(0, 2) });
  const firstForm = pagedLeads(makeLeads('9001', 250, 10000));
  const observed = {};
  setGraphOverrides({
    'GET 9001/leads': async (request) => {
      if (request.params.after === '200') {
        // What a freshly loaded browser tab sees in the middle of the sync
        observed.status = await syncStatus();
        observed.restart = await startSync();
      }
      return firstForm(request);
    },
    'GET 9002/leads': pagedLeads(makeLeads('9002', 80, 20000)),
  });

  const started = await startSync();
  await processPendingSyncJobs();

  assert.equal(observed.status.id, started.json.sync.id);
  assert.equal(observed.status.status, 'processing');
  assert.equal(observed.status.leadsProcessed, 200);
  assert.equal(observed.status.forms[0].status, 'processing');
  assert.equal(observed.status.forms[0].leadsProcessed, 200);
  assert.equal(observed.status.forms[1].status, 'pending');

  // Clicking the button again (or from another tab) does not start a second sync
  assert.equal(observed.restart.status, 200);
  assert.equal(observed.restart.json.alreadyRunning, true);
  assert.equal(observed.restart.json.sync.id, started.json.sync.id);
  assert.equal(await MetaSyncJob.countDocuments(), 1);

  const done = await syncStatus();
  assert.equal(done.status, 'completed');
  assert.equal(done.leadsImported, 330);
});

// ---- 10. Backend restart during a sync ---------------------------------------

test('a sync interrupted by a server restart resumes from its saved cursor', async () => {
  await seedIntegration({ forms: FORMS.slice(0, 2) });
  const leads = makeLeads('9001', 250, 10000);
  setGraphOverrides({
    'GET 9001/leads': pagedLeads(leads),
    'GET 9002/leads': pagedLeads(makeLeads('9002', 40, 20000)),
  });

  // State left behind by a server that died after storing the first two pages of form 1
  await MetaLead.insertMany(
    leads.slice(0, 200).map((lead) => ({ externalLeadId: lead.id, pageId: '111', formId: '9001', processingStatus: 'processed' }))
  );
  const job = await MetaSyncJob.create({
    activeKey: 'active',
    status: 'processing',
    pageId: '111',
    pageName: 'ABC Realty',
    startedAt: new Date(Date.now() - 10 * 60 * 1000),
    lockedAt: new Date(),
    forms: [
      { formId: '9001', formName: 'Solar CRM Form_3', status: 'processing', cursor: '200', leadsProcessed: 200, leadsImported: 200 },
      { formId: '9002', formName: 'Solar CRM Form_2' },
    ],
  });

  // While the heartbeat is fresh another worker leaves the job alone
  assert.equal(await processPendingSyncJobs(), 0);

  // The heartbeat goes stale: the job is picked up again
  await MetaSyncJob.updateOne({ _id: job._id }, { $set: { lockedAt: new Date(Date.now() - LOCK_TIMEOUT_MS - 1000) } });
  assert.equal(await processPendingSyncJobs(), 1);

  assert.deepEqual(getGraphCalls('GET 9001/leads').map((c) => c.params.after), ['200']);

  const sync = await syncStatus();
  assert.equal(sync.id, String(job._id));
  assert.equal(sync.status, 'completed');
  assert.equal(sync.leadsProcessed, 290);
  assert.equal(sync.leadsImported, 290);
  assert.equal(sync.duplicatesSkipped, 0);
  assert.equal(await MetaLead.countDocuments(), 290);

  // A new sync can be started once the old one has finished
  assert.equal((await startSync()).status, 202);
});

// ---- Security ----------------------------------------------------------------

test('sync endpoints require an admin/manager and never expose tokens', async () => {
  await seedIntegration();
  setGraphOverrides({ 'GET 9001/leads': pagedLeads(makeLeads('9001', 5, 100)) });

  for (const [method, path] of [['POST', '/api/integrations/meta/sync'], ['GET', '/api/integrations/meta/sync/status']]) {
    assert.equal((await request(method, path)).status, 401);
    for (const role of ['counsellor', 'accountant', 'teacher', 'student']) {
      const { token } = await createUser(role);
      assert.equal((await request(method, path, { token })).status, 403);
    }
  }
  assert.equal(await MetaSyncJob.countDocuments(), 0);

  const manager = await createUser('manager');
  // Page / form IDs in the request body are ignored - the stored connection decides what is synced
  const started = await startSync(manager.token, { pageId: '222', forms: [{ formId: '9101' }], formIds: ['9101'] });
  assert.equal(started.status, 202);
  await processPendingSyncJobs();
  assert.equal(getGraphCalls('GET 9101/leads').length, 0);
  assert.equal(getGraphCalls('GET 9001/leads').length, 1);

  const status = await request('GET', '/api/integrations/meta/sync/status', { token: manager.token });
  for (const text of [started.text, status.text]) {
    assert.ok(!text.includes('page-token'));
    assert.ok(!text.includes('cursor'));
    assert.ok(!text.toLowerCase().includes('accesstoken'));
  }
});

test('a sync cannot be started when Meta is not connected or nothing is selected', async () => {
  assert.equal((await startSync()).status, 409);
  assert.equal((await syncStatus()), null);

  await seedIntegration({ selectedPageId: null, forms: [] });
  assert.equal((await startSync()).status, 400);
  assert.equal(await MetaSyncJob.countDocuments(), 0);
});

test('disconnecting Meta during a sync ends the job without losing imported leads', async () => {
  await seedIntegration({ forms: FORMS.slice(0, 2) });
  const paged = pagedLeads(makeLeads('9001', 50, 10000));
  setGraphOverrides({
    'GET 9001/leads': paged,
    'GET 9002/leads': () => graphError(503, 2, 'Service unavailable'),
  });

  await startSync();
  await processPendingSyncJobs(); // form 1 done, form 2 waiting for a retry
  await request('DELETE', '/api/integrations/meta', { token: admin.token });

  await makeDue();
  await processPendingSyncJobs();

  const sync = await syncStatus();
  assert.equal(sync.status, 'failed');
  assert.ok(sync.error.includes('not connected'));
  assert.equal(sync.leadsImported, 50);
  assert.equal(await MetaLead.countDocuments(), 50);
});
