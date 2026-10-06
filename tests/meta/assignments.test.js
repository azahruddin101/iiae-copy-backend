// Meta lead pipeline: dynamic statuses, bulk assignment, per-telecaller status tracks, performance report

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, stopTestApp, resetState, createUser, request } = require('./helpers');
const MetaLead = require('../../src/models/MetaLead');
const MetaLeadStatus = require('../../src/models/MetaLeadStatus');
const MetaLeadAssignment = require('../../src/models/MetaLeadAssignment');

const BASE = '/api/integrations/meta';

let admin;
let manager;
let caller1;
let caller2;

before(startTestApp);
after(stopTestApp);
beforeEach(async () => {
  await resetState();
  admin = await createUser('admin');
  manager = await createUser('manager');
  caller1 = await createUser('counsellor', { name: 'Asha' });
  caller2 = await createUser('counsellor', { name: 'Bilal' });
});

const seedLeads = async (count, extra = {}) => {
  const docs = Array.from({ length: count }, (unused, i) => ({
    externalLeadId: String(900000 + i),
    pageId: '111',
    pageName: 'Innovbit',
    formId: '9001',
    formName: 'Solar CRM',
    fullName: `Customer ${i}`,
    phone: `+9190000000${String(i).padStart(2, '0')}`,
    searchText: `customer ${i} +9190000000${String(i).padStart(2, '0')}`,
    fields: { full_name: `Customer ${i}`, roof_type: 'Flat' },
    rawData: { id: String(900000 + i) },
    leadCreatedAt: new Date(Date.UTC(2026, 8, 1, 0, i)),
    processingStatus: 'processed',
    ...extra,
  }));
  return (await MetaLead.insertMany(docs)).map((lead) => String(lead._id));
};

const getStatuses = async (token = admin.token) => (await request('GET', `${BASE}/lead-statuses`, { token })).json;
const statusId = async (name) => String((await getStatuses()).find((status) => status.name === name)._id);
const assign = (leadIds, telecaller, token = admin.token) =>
  request('POST', `${BASE}/leads/assign`, { token, body: { leadIds, telecallerId: telecaller ? String(telecaller.user._id) : null } });
const myLeads = async (caller, query = '') => (await request('GET', `${BASE}/my-leads${query}`, { token: caller.token })).json;
const setStatus = (caller, assignmentId, name, remark) =>
  statusId(name).then((id) =>
    request('PUT', `${BASE}/my-leads/${assignmentId}/status`, { token: caller.token, body: { statusId: id, remark } })
  );

// ---- Statuses ---------------------------------------------------------------

test('default statuses are created once and the admin can add, rename, reorder, deactivate and delete them', async () => {
  const defaults = await getStatuses();
  assert.deepEqual(defaults.map((s) => s.name), ['Interested', 'Callback', 'Not Picked', 'Not Eligible', 'Not Interested', 'Registered']);
  assert.equal(defaults.find((s) => s.name === 'Registered').isConversion, true);

  // Add
  const created = await request('POST', `${BASE}/lead-statuses`, { token: admin.token, body: { name: '  Site   Visit ', color: 'cyan' } });
  assert.equal(created.status, 201);
  assert.equal(created.json.name, 'Site Visit');
  assert.equal(created.json.order, 6);

  // Duplicate names are rejected regardless of case
  const duplicate = await request('POST', `${BASE}/lead-statuses`, { token: admin.token, body: { name: 'site visit' } });
  assert.equal(duplicate.status, 400);
  assert.equal((await request('POST', `${BASE}/lead-statuses`, { token: admin.token, body: { name: '' } })).status, 400);
  assert.equal((await request('POST', `${BASE}/lead-statuses`, { token: admin.token, body: { name: 'X', color: 'neon' } })).status, 400);

  // Rename + mark as conversion (manager can manage statuses too)
  const renamed = await request('PUT', `${BASE}/lead-statuses/${created.json._id}`, {
    token: manager.token,
    body: { name: 'Site Visit Done', isConversion: true },
  });
  assert.equal(renamed.json.name, 'Site Visit Done');
  assert.equal(renamed.json.isConversion, true);

  // Reorder: move the new status to the front
  const ids = (await getStatuses()).map((s) => String(s._id));
  const reordered = await request('PUT', `${BASE}/lead-statuses/reorder`, {
    token: admin.token,
    body: { statusIds: [ids[6], ...ids.slice(0, 6)] },
  });
  assert.equal(reordered.json[0].name, 'Site Visit Done');

  // Deactivate: hidden from telecallers, still listed for the admin
  const callback = await statusId('Callback');
  await request('PUT', `${BASE}/lead-statuses/${callback}`, { token: admin.token, body: { isActive: false } });
  assert.ok(!(await getStatuses(caller1.token)).some((s) => s.name === 'Callback'));
  assert.ok((await getStatuses()).some((s) => s.name === 'Callback' && s.isActive === false));

  // Delete: gone for everyone, and the name can be used again
  assert.equal((await request('DELETE', `${BASE}/lead-statuses/${callback}`, { token: admin.token })).status, 200);
  assert.ok(!(await getStatuses()).some((s) => s.name === 'Callback'));
  assert.equal((await request('POST', `${BASE}/lead-statuses`, { token: admin.token, body: { name: 'Callback' } })).status, 201);

  // Deleting everything does not bring the defaults back
  for (const status of await getStatuses()) {
    await request('DELETE', `${BASE}/lead-statuses/${status._id}`, { token: admin.token });
  }
  assert.deepEqual(await getStatuses(), []);
});

test('only admin/manager can change statuses; telecallers can read them; other roles cannot', async () => {
  const id = await statusId('Interested');

  for (const [method, path, body] of [
    ['POST', `${BASE}/lead-statuses`, { name: 'Hacked' }],
    ['PUT', `${BASE}/lead-statuses/${id}`, { name: 'Hacked' }],
    ['PUT', `${BASE}/lead-statuses/reorder`, { statusIds: [id] }],
    ['DELETE', `${BASE}/lead-statuses/${id}`],
  ]) {
    assert.equal((await request(method, path, { body })).status, 401);
    assert.equal((await request(method, path, { token: caller1.token, body })).status, 403);
  }

  assert.equal((await request('GET', `${BASE}/lead-statuses`)).status, 401);
  assert.equal((await request('GET', `${BASE}/lead-statuses`, { token: caller1.token })).status, 200);
  for (const role of ['accountant', 'teacher', 'student']) {
    const { token } = await createUser(role);
    assert.equal((await request('GET', `${BASE}/lead-statuses`, { token })).status, 403);
  }
  assert.ok((await getStatuses()).some((s) => s.name === 'Interested'));
});

// ---- Bulk assignment --------------------------------------------------------

test('leads are assigned in bulk and show their owner in the admin list', async () => {
  const leadIds = await seedLeads(60);

  const res = await assign(leadIds.slice(0, 50), caller1);
  assert.equal(res.status, 200);
  assert.deepEqual(
    { assigned: res.json.assigned, unchanged: res.json.unchanged, notFound: res.json.notFound },
    { assigned: 50, unchanged: 0, notFound: 0 }
  );
  assert.ok(res.json.message.includes('Asha'));

  assert.equal(await MetaLeadAssignment.countDocuments({ telecaller: caller1.user._id, isActive: true }), 50);
  assert.equal((await myLeads(caller1)).total, 50);
  assert.equal((await myLeads(caller2)).total, 0);

  // Assigning the same leads again changes nothing
  const again = await assign(leadIds.slice(0, 50), caller1);
  assert.equal(again.json.assigned, 0);
  assert.equal(again.json.unchanged, 50);
  assert.equal(await MetaLeadAssignment.countDocuments(), 50);

  // Admin list: owner shown, filter by owner / unassigned
  const list = (query) => request('GET', `${BASE}/leads?${new URLSearchParams(query)}`, { token: admin.token });
  const mine = await list({ assignedTo: String(caller1.user._id), limit: 100 });
  assert.equal(mine.json.total, 50);
  assert.equal(mine.json.leads[0].assignedTo.name, 'Asha');
  assert.equal(mine.json.leads[0].currentStatus, null);
  assert.equal((await list({ assignedTo: 'unassigned' })).json.total, 10);
  assert.equal((await list({ assignedTo: String(caller2.user._id) })).json.total, 0);
  assert.equal((await list({ assignedTo: 'not-an-id' })).status, 400);

  // Unassign
  const unassigned = await assign(leadIds.slice(0, 5), null);
  assert.equal(unassigned.json.assigned, 5);
  assert.equal((await list({ assignedTo: 'unassigned' })).json.total, 15);
  assert.equal((await myLeads(caller1)).total, 45);
});

test('bulk assignment validates its input and only targets active telecallers', async () => {
  const leadIds = await seedLeads(3);
  const post = (body, token = admin.token) => request('POST', `${BASE}/leads/assign`, { token, body });
  const callerId = String(caller1.user._id);

  assert.equal((await post({ leadIds: [], telecallerId: callerId })).status, 400);
  assert.equal((await post({ leadIds: 'all', telecallerId: callerId })).status, 400);
  assert.equal((await post({ leadIds: ['nope'], telecallerId: callerId })).status, 400);
  assert.equal((await post({ leadIds: [{ $ne: null }], telecallerId: callerId })).status, 400);
  assert.equal((await post({ leadIds, telecallerId: 'nope' })).status, 400);
  assert.equal((await post({ leadIds: Array.from({ length: 501 }, () => leadIds[0]).map((id, i) => id.slice(0, 20) + String(1000 + i)), telecallerId: callerId })).status, 400);

  // Target must be an active telecaller
  assert.equal((await post({ leadIds, telecallerId: String(admin.user._id) })).status, 404);
  const inactive = await createUser('counsellor', { status: 'inactive' });
  assert.equal((await post({ leadIds, telecallerId: String(inactive.user._id) })).status, 404);

  // Unknown lead IDs and leads that are not fully stored yet are reported, not assigned
  const pending = await MetaLead.create({ externalLeadId: '1', pageId: '111', formId: '9001', processingStatus: 'pending' });
  const res = await post({ leadIds: [...leadIds, String(pending._id), '64b000000000000000000000'], telecallerId: callerId });
  assert.deepEqual([res.json.assigned, res.json.notFound], [3, 2]);

  // Telecallers and other roles cannot assign
  assert.equal((await post({ leadIds, telecallerId: callerId }, caller1.token)).status, 403);
  assert.equal((await request('POST', `${BASE}/leads/assign`, { body: { leadIds, telecallerId: callerId } })).status, 401);
  assert.equal((await post({ leadIds, telecallerId: String(caller2.user._id) }, manager.token)).status, 200);
});

// ---- Per-telecaller status tracks -------------------------------------------

test('reassignment: the first telecaller keeps a read-only view of their progress, the new one starts from scratch', async () => {
  const [leadId] = await seedLeads(1);
  await assign([leadId], caller1);

  // Asha works the lead: Interested -> Callback -> Not Picked
  let mine = await myLeads(caller1);
  const ashaAssignment = mine.assignments[0];
  assert.equal(ashaAssignment.isActive, true);
  assert.equal(ashaAssignment.currentStatus, null);
  assert.equal(ashaAssignment.lead.fullName, 'Customer 0');
  assert.equal(ashaAssignment.lead.fields.roof_type, 'Flat');

  assert.equal((await setStatus(caller1, ashaAssignment._id, 'Interested', 'Wants a quote')).status, 200);
  await setStatus(caller1, ashaAssignment._id, 'Callback', 'Call after 5pm');
  const third = await setStatus(caller1, ashaAssignment._id, 'Not Picked', '');
  assert.equal(third.json.currentStatus.name, 'Not Picked');
  assert.deepEqual(third.json.history.map((h) => [h.statusName, h.remark]), [
    ['Interested', 'Wants a quote'],
    ['Callback', 'Call after 5pm'],
    ['Not Picked', ''],
  ]);

  // Admin sees the status of the current owner
  let adminList = await request('GET', `${BASE}/leads`, { token: admin.token });
  assert.equal(adminList.json.leads[0].currentStatus.name, 'Not Picked');

  // Admin reassigns the lead to Bilal
  assert.equal((await assign([leadId], caller2)).json.assigned, 1);

  // Asha: the lead left her active list and sits in "previous" exactly as she left it
  assert.equal((await myLeads(caller1)).total, 0);
  mine = await myLeads(caller1, '?state=previous');
  assert.equal(mine.total, 1);
  assert.deepEqual(mine.counts, { active: 0, previous: 1 });
  assert.equal(mine.assignments[0].isActive, false);
  assert.equal(mine.assignments[0].currentStatus.name, 'Not Picked');
  assert.equal(mine.assignments[0].history.length, 3);
  assert.ok(mine.assignments[0].endedAt);

  // ...and she can no longer change it
  const blocked = await setStatus(caller1, ashaAssignment._id, 'Registered', 'late update');
  assert.equal(blocked.status, 403);
  assert.ok(blocked.json.message.includes('reassigned'));

  // Bilal starts from the beginning with an empty track and no view of Asha's work
  const bilal = await myLeads(caller2);
  const bilalAssignment = bilal.assignments[0];
  assert.equal(bilal.total, 1);
  assert.notEqual(bilalAssignment._id, ashaAssignment._id);
  assert.equal(bilalAssignment.currentStatus, null);
  assert.deepEqual(bilalAssignment.history, []);
  assert.ok(!JSON.stringify(bilal).includes('Wants a quote'));

  await setStatus(caller2, bilalAssignment._id, 'Interested', 'Spoke to owner');
  await setStatus(caller2, bilalAssignment._id, 'Callback', 'Send brochure');
  await setStatus(caller2, bilalAssignment._id, 'Not Picked', 'Busy');
  const registered = await setStatus(caller2, bilalAssignment._id, 'Registered', 'Paid token amount');
  assert.equal(registered.json.history.length, 4);

  // Asha's track is untouched by Bilal's work
  mine = await myLeads(caller1, '?state=previous');
  assert.equal(mine.assignments[0].currentStatus.name, 'Not Picked');
  assert.equal(mine.assignments[0].history.length, 3);
  assert.ok(!JSON.stringify(mine).includes('Paid token amount'));

  // Admin sees both tracks side by side, and the current owner's status in the list
  const tracks = await request('GET', `${BASE}/leads/${leadId}/assignments`, { token: admin.token });
  assert.equal(tracks.json.unassigned, null);
  assert.deepEqual(
    tracks.json.assignments.map((t) => [t.telecaller.name, t.isActive, t.currentStatus.name, t.history.length]),
    [
      ['Bilal', true, 'Registered', 4],
      ['Asha', false, 'Not Picked', 3],
    ]
  );
  adminList = await request('GET', `${BASE}/leads`, { token: admin.token });
  assert.equal(adminList.json.leads[0].assignedTo.name, 'Bilal');
  assert.equal(adminList.json.leads[0].currentStatus.name, 'Registered');
});

test('a telecaller who gets a lead back continues from their own earlier progress', async () => {
  const [leadId] = await seedLeads(1);
  await assign([leadId], caller1);
  const first = (await myLeads(caller1)).assignments[0];
  await setStatus(caller1, first._id, 'Interested', 'first call');

  await assign([leadId], caller2);
  await assign([leadId], caller1);

  const mine = await myLeads(caller1);
  assert.equal(mine.total, 1);
  assert.equal(mine.assignments[0]._id, first._id);
  assert.equal(mine.assignments[0].isActive, true);
  assert.equal(mine.assignments[0].currentStatus.name, 'Interested');
  assert.equal(mine.assignments[0].endedAt, null);
  assert.equal((await setStatus(caller1, first._id, 'Callback', 'second round')).status, 200);

  // Bilal now has the read-only copy
  const bilal = await myLeads(caller2, '?state=previous');
  assert.equal(bilal.total, 1);
  assert.equal((await setStatus(caller2, bilal.assignments[0]._id, 'Interested', 'x')).status, 403);

  // Never more than one active owner, one record per telecaller
  assert.equal(await MetaLeadAssignment.countDocuments({ lead: leadId }), 2);
  assert.equal(await MetaLeadAssignment.countDocuments({ lead: leadId, isActive: true }), 1);
});

test('an unassigned lead becomes read-only for its last telecaller', async () => {
  const [leadId] = await seedLeads(1);
  await assign([leadId], caller1);
  const assignment = (await myLeads(caller1)).assignments[0];
  await setStatus(caller1, assignment._id, 'Interested', 'ok');

  await assign([leadId], null);

  assert.equal((await setStatus(caller1, assignment._id, 'Callback', 'x')).status, 403);
  assert.equal((await myLeads(caller1, '?state=previous')).total, 1);
  assert.equal((await MetaLead.findById(leadId)).assignedTo, undefined);
});

test('telecallers only ever see and change their own leads', async () => {
  const leadIds = await seedLeads(4);
  await assign(leadIds.slice(0, 2), caller1);
  await assign(leadIds.slice(2), caller2);

  const ashaLeads = await myLeads(caller1);
  const bilalLeads = await myLeads(caller2);
  assert.deepEqual(ashaLeads.assignments.map((a) => a.lead.fullName).sort(), ['Customer 0', 'Customer 1']);
  assert.deepEqual(bilalLeads.assignments.map((a) => a.lead.fullName).sort(), ['Customer 2', 'Customer 3']);
  // Internal Meta payload is not sent to telecallers
  assert.ok(!JSON.stringify(ashaLeads).includes('rawData'));

  // Asha cannot touch Bilal's assignment
  const foreign = await setStatus(caller1, bilalLeads.assignments[0]._id, 'Interested', 'hijack');
  assert.equal(foreign.status, 404);
  assert.equal((await myLeads(caller2)).assignments.find((a) => a._id === bilalLeads.assignments[0]._id).currentStatus, null);

  // Telecallers cannot use admin endpoints; admins have no "my leads"
  assert.equal((await request('GET', `${BASE}/leads`, { token: caller1.token })).status, 403);
  assert.equal((await request('GET', `${BASE}/leads/${leadIds[0]}/assignments`, { token: caller1.token })).status, 403);
  assert.equal((await request('GET', `${BASE}/reports/telecallers`, { token: caller1.token })).status, 403);
  assert.equal((await request('GET', `${BASE}/my-leads`, { token: admin.token })).status, 403);
  assert.equal((await request('GET', `${BASE}/my-leads`)).status, 401);
  assert.equal((await request('PUT', `${BASE}/my-leads/${ashaLeads.assignments[0]._id}/status`, { body: {} })).status, 401);
});

test('status updates are validated', async () => {
  const [leadId] = await seedLeads(1);
  await assign([leadId], caller1);
  const assignment = (await myLeads(caller1)).assignments[0];
  const put = (body, id = assignment._id) => request('PUT', `${BASE}/my-leads/${id}/status`, { token: caller1.token, body });

  assert.equal((await put({})).status, 400);
  assert.equal((await put({ statusId: 'nope' })).status, 400);
  assert.equal((await put({ statusId: { $ne: null } })).status, 400);
  assert.equal((await put({ statusId: '64b000000000000000000000' })).status, 400);
  assert.equal((await put({ statusId: await statusId('Interested') }, 'nope')).status, 404);

  // Inactive and deleted statuses cannot be chosen
  const callback = await statusId('Callback');
  await request('PUT', `${BASE}/lead-statuses/${callback}`, { token: admin.token, body: { isActive: false } });
  assert.equal((await put({ statusId: callback })).status, 400);

  // A long remark is cut, not rejected
  const ok = await put({ statusId: await statusId('Interested'), remark: 'x'.repeat(5000) });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.history[0].remark.length, 1000);
});

test('a status that is renamed or deleted later stays readable in the history', async () => {
  const [leadId] = await seedLeads(1);
  await assign([leadId], caller1);
  const assignment = (await myLeads(caller1)).assignments[0];
  await setStatus(caller1, assignment._id, 'Interested', 'keen');

  const interested = await statusId('Interested');
  await request('DELETE', `${BASE}/lead-statuses/${interested}`, { token: admin.token });

  const mine = (await myLeads(caller1)).assignments[0];
  assert.equal(mine.history[0].statusName, 'Interested');
  assert.equal(mine.currentStatus.name, 'Interested');
});

test('my leads: search, status filter and pagination run on the server', async () => {
  const leadIds = await seedLeads(30);
  await assign(leadIds, caller1);
  const all = await myLeads(caller1, '?limit=100');
  await setStatus(caller1, all.assignments[0]._id, 'Interested', 'a');
  await setStatus(caller1, all.assignments[1]._id, 'Interested', 'b');

  assert.equal((await myLeads(caller1, '?limit=10&page=3')).assignments.length, 10);
  assert.equal((await myLeads(caller1, '?limit=10')).totalPages, 3);
  assert.equal((await myLeads(caller1, `?statusId=${await statusId('Interested')}`)).total, 2);
  assert.equal((await myLeads(caller1, '?statusId=none')).total, 28);
  assert.deepEqual((await myLeads(caller1, '?search=CUSTOMER 7')).assignments.map((a) => a.lead.fullName), ['Customer 7']);
  assert.equal((await myLeads(caller1, '?search=.*')).total, 0);
  assert.equal((await request('GET', `${BASE}/my-leads?statusId=bad`, { token: caller1.token })).status, 400);

  // Admin list: filter by the current owner's status
  const interested = await request('GET', `${BASE}/leads?statusId=${await statusId('Interested')}`, { token: admin.token });
  assert.equal(interested.json.total, 2);
  assert.equal((await request('GET', `${BASE}/leads?statusId=none`, { token: admin.token })).json.total, 28);
});

// ---- Performance report ------------------------------------------------------

test('performance report shows each telecaller\'s numbers', async () => {
  const leadIds = await seedLeads(12);
  await assign(leadIds.slice(0, 6), caller1); // Asha: 6
  await assign(leadIds.slice(6, 10), caller2); // Bilal: 4, two leads stay unassigned

  const asha = (await myLeads(caller1, '?limit=100')).assignments;
  await setStatus(caller1, asha[0]._id, 'Interested', 'a');
  await setStatus(caller1, asha[0]._id, 'Registered', 'won');
  await setStatus(caller1, asha[1]._id, 'Callback', 'b');
  await setStatus(caller1, asha[2]._id, 'Not Interested', 'c');

  const bilal = (await myLeads(caller2, '?limit=100')).assignments;
  await setStatus(caller2, bilal[0]._id, 'Registered', 'won');

  // One of Asha's worked leads moves to Bilal
  await assign([String(asha[1].lead._id)], caller2);

  const report = await request('GET', `${BASE}/reports/telecallers`, { token: admin.token });
  assert.equal(report.status, 200);
  assert.equal(report.json.totalLeads, 12);
  assert.equal(report.json.unassignedLeads, 2);

  const row = (name) => report.json.telecallers.find((t) => t.user.name === name);
  const ashaRow = row('Asha');
  assert.deepEqual(
    [ashaRow.totalAssigned, ashaRow.activeLeads, ashaRow.reassignedAway, ashaRow.workedLeads, ashaRow.notStarted, ashaRow.converted, ashaRow.statusUpdates],
    [6, 5, 1, 3, 3, 1, 4]
  );
  assert.equal(ashaRow.conversionRate, 16.7);
  assert.ok(ashaRow.lastActivityAt);
  assert.deepEqual(
    ashaRow.statuses.map((s) => [s.name, s.count]),
    [['Callback', 1], ['Not Interested', 1], ['Registered', 1]]
  );

  const bilalRow = row('Bilal');
  assert.deepEqual(
    [bilalRow.totalAssigned, bilalRow.activeLeads, bilalRow.reassignedAway, bilalRow.workedLeads, bilalRow.notStarted, bilalRow.converted, bilalRow.statusUpdates],
    [5, 5, 0, 1, 4, 1, 1]
  );
  assert.equal(bilalRow.conversionRate, 20);

  // A telecaller without leads is still listed
  await createUser('counsellor', { name: 'Chitra' });
  const withNew = await request('GET', `${BASE}/reports/telecallers`, { token: manager.token });
  assert.equal(withNew.json.telecallers.find((t) => t.user.name === 'Chitra').totalAssigned, 0);

  // Date range (by assignment date)
  const future = await request('GET', `${BASE}/reports/telecallers?from=2099-01-01T00:00:00.000Z`, { token: admin.token });
  assert.equal(future.json.telecallers.find((t) => t.user.name === 'Asha').totalAssigned, 0);
  assert.equal((await request('GET', `${BASE}/reports/telecallers?from=garbage`, { token: admin.token })).status, 400);

  // No lead answers or tokens in the report
  assert.ok(!report.text.includes('Customer'));
  assert.equal((await request('GET', `${BASE}/reports/telecallers`)).status, 401);
});

test('an admin can update the status of a lead before it is assigned', async () => {
  const [leadId] = await seedLeads(1);
  const interested = await statusId('Interested');
  const callback = await statusId('Callback');

  const unassigned = await request('PUT', `${BASE}/leads/${leadId}/status`, {
    token: admin.token,
    body: { statusId: interested, remark: 'Called' },
  });
  assert.equal(unassigned.status, 200);
  assert.equal(unassigned.json.assignmentId, null);
  assert.equal(unassigned.json.currentStatus.name, 'Interested');
  assert.equal(unassigned.json.history.at(-1).remark, 'Called');

  const beforeAssign = await request('GET', `${BASE}/leads`, { token: admin.token });
  assert.equal(beforeAssign.json.leads[0].assignedTo, undefined);
  assert.equal(beforeAssign.json.leads[0].currentStatus.name, 'Interested');
  assert.equal((await request('GET', `${BASE}/leads?statusId=${interested}`, { token: admin.token })).json.total, 1);

  const detail = await request('GET', `${BASE}/leads/${leadId}/assignments`, { token: admin.token });
  assert.deepEqual(detail.json.assignments, []);
  assert.equal(detail.json.unassigned.currentStatus.name, 'Interested');
  assert.equal(detail.json.unassigned.history.at(-1).remark, 'Called');

  await assign([leadId], caller1);
  const inherited = await myLeads(caller1);
  assert.equal(inherited.assignments[0].currentStatus.name, 'Interested');
  assert.equal(inherited.assignments[0].history.at(-1).remark, 'Called');
  const updated = await request('PUT', `${BASE}/leads/${leadId}/status`, {
    token: manager.token,
    body: { statusId: callback, remark: 'Admin follow-up' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.currentStatus.name, 'Callback');
  assert.equal(updated.json.history.at(-1).remark, 'Admin follow-up');

  const mine = await myLeads(caller1);
  assert.equal(mine.assignments[0].currentStatus.name, 'Callback');

  const blocked = await request('PUT', `${BASE}/leads/${leadId}/status`, {
    token: caller1.token,
    body: { statusId: interested, remark: 'no' },
  });
  assert.equal(blocked.status, 403);
});

test('existing admin-only Meta endpoints are still closed to telecallers', async () => {
  for (const path of ['/status', '/pages', '/leads', '/leads/filters', '/sync/status']) {
    assert.equal((await request('GET', `${BASE}${path}`, { token: caller1.token })).status, 403, path);
  }
  assert.equal((await request('POST', `${BASE}/sync`, { token: caller1.token })).status, 403);
  assert.equal((await request('DELETE', BASE, { token: caller1.token })).status, 403);
});
