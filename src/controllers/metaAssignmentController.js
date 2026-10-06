const mongoose = require('mongoose');
const User = require('../models/User');
const MetaLead = require('../models/MetaLead');
const MetaLeadStatus = require('../models/MetaLeadStatus');
const MetaLeadAssignment = require('../models/MetaLeadAssignment');
const { STATUS_COLORS } = require('../models/MetaLeadStatus');
const { logMetaEvent, logMetaError } = require('../utils/metaLogger');
const { startRegistrationForMetaLead } = require('./registrationController');

const MAX_BULK_ASSIGN = 500;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_NAME_LENGTH = 40;
const MAX_REMARK_LENGTH = 1000;
const MAX_SEARCH_LENGTH = 100;

// Statuses created the first time the pipeline is used - the admin can rename, reorder or delete them
const DEFAULT_STATUSES = [
  { name: 'Interested', color: 'amber' },
  { name: 'Callback', color: 'blue' },
  { name: 'Not Picked', color: 'purple' },
  { name: 'Not Eligible', color: 'rose' },
  { name: 'Not Interested', color: 'slate' },
  { name: 'Registered', color: 'emerald', isConversion: true },
];

const LEAD_FIELDS_FOR_TELECALLER =
  'externalLeadId fullName email phone fields formName pageName campaignName adName leadCreatedAt createdAt crmLead';

const populateLeadForCounsellor = {
  path: 'lead',
  select: LEAD_FIELDS_FOR_TELECALLER,
  populate: { path: 'crmLead', select: 'registrationToken formSubmittedAt registrationBy' },
};

const isObjectId = (value) => typeof value === 'string' && mongoose.isValidObjectId(value);
const toStringParam = (value) => (typeof value === 'string' ? value.trim() : '');
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const serverError = (res, error, message) => {
  logMetaError('META_INTERNAL_ERROR', { reason: error.name });
  return res.status(500).json({ message });
};

const parseDateRange = (query) => {
  const from = toStringParam(query.from);
  const to = toStringParam(query.to);
  const range = {};
  if (from) range.$gte = new Date(from);
  if (to) range.$lte = new Date(to);
  const invalid = Object.values(range).some((date) => Number.isNaN(date.getTime()));
  return { range: Object.keys(range).length ? range : null, invalid };
};

// ---------------------------------------------------------------------------
// Lead statuses (managed by admin / manager)
// ---------------------------------------------------------------------------

const ensureDefaultStatuses = async () => {
  // Only when nothing was ever created - deleting every status does not bring the defaults back
  if ((await MetaLeadStatus.countDocuments({})) > 0) return;

  try {
    await MetaLeadStatus.insertMany(
      DEFAULT_STATUSES.map((status, index) => ({ ...status, nameKey: status.name.toLowerCase(), order: index })),
      { ordered: false }
    );
  } catch (error) {
    // Another request created them at the same moment
    if (error.code !== 11000 && !(error.writeErrors || []).length) throw error;
  }
};

const serializeStatus = (status) => ({
  _id: status._id,
  name: status.name,
  color: status.color,
  order: status.order,
  isConversion: status.isConversion,
  isActive: status.isActive,
});

const readStatusInput = (body, { partial = false } = {}) => {
  const input = {};
  const errors = [];

  if (body.name !== undefined || !partial) {
    const name = toStringParam(body.name).replace(/\s+/g, ' ');
    if (!name || name.length > MAX_NAME_LENGTH) errors.push(`Status name is required (max ${MAX_NAME_LENGTH} characters)`);
    input.name = name;
    input.nameKey = name.toLowerCase();
  }
  if (body.color !== undefined) {
    if (!STATUS_COLORS.includes(body.color)) errors.push('Invalid status colour');
    input.color = body.color;
  }
  if (body.isConversion !== undefined) input.isConversion = body.isConversion === true;
  if (body.isActive !== undefined) input.isActive = body.isActive === true;

  return { input, error: errors[0] || null };
};

// @desc    List lead statuses (telecallers only receive the active ones)
// @route   GET /api/integrations/meta/lead-statuses
// @access  Private (admin, manager, telecaller)
const getLeadStatuses = async (req, res) => {
  try {
    await ensureDefaultStatuses();

    const filter = { isDeleted: false };
    if (req.user.role === 'counsellor') filter.isActive = true;

    const statuses = await MetaLeadStatus.find(filter).sort({ order: 1, createdAt: 1 });
    res.json(statuses.map(serializeStatus));
  } catch (error) {
    serverError(res, error, 'Server error retrieving lead statuses');
  }
};

// @desc    Create a lead status
// @route   POST /api/integrations/meta/lead-statuses
// @access  Private (admin, manager)
const createLeadStatus = async (req, res) => {
  const { input, error } = readStatusInput(req.body || {});
  if (error) return res.status(400).json({ message: error });

  try {
    await ensureDefaultStatuses();
    const last = await MetaLeadStatus.findOne({ isDeleted: false }).sort({ order: -1 });
    const status = await MetaLeadStatus.create({ ...input, order: last ? last.order + 1 : 0 });

    logMetaEvent('META_LEAD_STATUS_CREATED', { userId: String(req.user._id), statusId: String(status._id) });
    res.status(201).json(serializeStatus(status));
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ message: 'A status with this name already exists' });
    serverError(res, err, 'Server error creating lead status');
  }
};

// @desc    Update a lead status (name, colour, conversion flag, active)
// @route   PUT /api/integrations/meta/lead-statuses/:id
// @access  Private (admin, manager)
const updateLeadStatus = async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Lead status not found' });

  const { input, error } = readStatusInput(req.body || {}, { partial: true });
  if (error) return res.status(400).json({ message: error });

  try {
    const status = await MetaLeadStatus.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      { $set: input },
      { returnDocument: 'after', runValidators: true }
    );
    if (!status) return res.status(404).json({ message: 'Lead status not found' });

    res.json(serializeStatus(status));
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ message: 'A status with this name already exists' });
    serverError(res, err, 'Server error updating lead status');
  }
};

// @desc    Change the order of the lead statuses
// @route   PUT /api/integrations/meta/lead-statuses/reorder
// @access  Private (admin, manager)
const reorderLeadStatuses = async (req, res) => {
  const statusIds = Array.isArray(req.body && req.body.statusIds) ? req.body.statusIds : [];
  if (statusIds.length === 0 || statusIds.length > 200 || !statusIds.every(isObjectId)) {
    return res.status(400).json({ message: 'Invalid status order' });
  }

  try {
    await MetaLeadStatus.bulkWrite(
      statusIds.map((id, index) => ({
        updateOne: { filter: { _id: id, isDeleted: false }, update: { $set: { order: index } } },
      }))
    );
    const statuses = await MetaLeadStatus.find({ isDeleted: false }).sort({ order: 1, createdAt: 1 });
    res.json(statuses.map(serializeStatus));
  } catch (error) {
    serverError(res, error, 'Server error reordering lead statuses');
  }
};

// @desc    Delete a lead status (leads keep it in their history)
// @route   DELETE /api/integrations/meta/lead-statuses/:id
// @access  Private (admin, manager)
const deleteLeadStatus = async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Lead status not found' });

  try {
    const status = await MetaLeadStatus.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      { $set: { isDeleted: true, isActive: false } }
    );
    if (!status) return res.status(404).json({ message: 'Lead status not found' });

    logMetaEvent('META_LEAD_STATUS_DELETED', { userId: String(req.user._id), statusId: String(status._id) });
    res.json({ message: 'Lead status deleted' });
  } catch (error) {
    serverError(res, error, 'Server error deleting lead status');
  }
};

// A counsellor receiving a lead for the first time keeps the status an admin
// already recorded. A counsellor who had the lead before keeps their own track.
const carryUnassignedStatusToNewOwner = async (leadIds, telecallerId, now) => {
  const pending = await MetaLead.find({
    _id: { $in: leadIds },
    unassignedStatus: { $ne: null },
  })
    .select('unassignedStatus unassignedHistory unassignedActivityAt')
    .lean();
  if (pending.length === 0) return;

  const byLead = new Map(pending.map((lead) => [String(lead._id), lead]));
  const fresh = await MetaLeadAssignment.find({
    lead: { $in: pending.map((lead) => lead._id) },
    telecaller: telecallerId,
    isActive: true,
    currentStatus: null,
    history: { $size: 0 },
  })
    .select('_id lead')
    .lean();
  if (fresh.length === 0) return;

  await MetaLeadAssignment.bulkWrite(
    fresh.map((assignment) => {
      const lead = byLead.get(String(assignment.lead));
      return {
        updateOne: {
          filter: { _id: assignment._id, currentStatus: null, history: { $size: 0 } },
          update: {
            $set: {
              currentStatus: lead.unassignedStatus,
              history: lead.unassignedHistory || [],
              lastActivityAt: lead.unassignedActivityAt || now,
            },
          },
        },
      };
    })
  );
  await MetaLead.updateMany(
    { _id: { $in: fresh.map((assignment) => assignment.lead) } },
    { $set: { unassignedStatus: null, unassignedHistory: [], unassignedActivityAt: null } }
  );
};

// ---------------------------------------------------------------------------
// Assignment (admin / manager)
// ---------------------------------------------------------------------------

// @desc    Assign or reassign Meta leads in bulk to a telecaller (telecallerId: null = unassign)
// @route   POST /api/integrations/meta/leads/assign
// @access  Private (admin, manager)
const assignMetaLeads = async (req, res) => {
  const body = req.body || {};
  const leadIds = Array.isArray(body.leadIds) ? [...new Set(body.leadIds)] : [];
  const requestedId = body.counsellorId !== undefined ? body.counsellorId : body.telecallerId;
  const telecallerId = requestedId || null;

  if (leadIds.length === 0 || !leadIds.every(isObjectId)) {
    return res.status(400).json({ message: 'Select at least one lead' });
  }
  if (leadIds.length > MAX_BULK_ASSIGN) {
    return res.status(400).json({ message: `You can assign up to ${MAX_BULK_ASSIGN} leads at a time` });
  }
  if (telecallerId && !isObjectId(telecallerId)) {
    return res.status(400).json({ message: 'Invalid counsellor' });
  }

  try {
    let telecaller = null;
    if (telecallerId) {
      telecaller = await User.findOne({ _id: telecallerId, role: 'counsellor', status: 'active', isDeleted: false });
      if (!telecaller) return res.status(404).json({ message: 'Counsellor not found or inactive' });
    }

    const leads = await MetaLead.find({ _id: { $in: leadIds }, processingStatus: 'processed', isDeleted: false })
      .select('_id assignedTo')
      .lean();

    // Leads that already belong to the requested telecaller are left as they are
    const targetId = telecaller ? String(telecaller._id) : '';
    const changeIds = leads.filter((lead) => String(lead.assignedTo || '') !== targetId).map((lead) => lead._id);
    const now = new Date();

    if (changeIds.length > 0) {
      const closing = await MetaLeadAssignment.find({ lead: { $in: changeIds }, isActive: true })
        .select('lead currentStatus')
        .lean();

      // 1. The current owner's record becomes read-only (their status track is kept as it is)
      await MetaLeadAssignment.updateMany(
        { lead: { $in: changeIds }, isActive: true },
        { $set: { isActive: false, endedAt: now } }
      );

      if (telecaller) {
        // 2. The new owner gets their own record. A telecaller who had the lead before
        //    gets their earlier record back, with the progress they had made.
        await MetaLeadAssignment.bulkWrite(
          changeIds.map((lead) => ({
            updateOne: {
              filter: { lead, telecaller: telecaller._id },
              update: {
                $set: { isActive: true, assignedBy: req.user._id, assignedAt: now },
                $unset: { endedAt: 1 },
                $setOnInsert: { currentStatus: null, history: [] },
              },
              upsert: true,
            },
          })),
          { ordered: false }
        );
        await carryUnassignedStatusToNewOwner(changeIds, telecaller._id, now);
        await MetaLead.updateMany({ _id: { $in: changeIds } }, { $set: { assignedTo: telecaller._id, assignedAt: now } });
      } else {
        await MetaLead.bulkWrite(
          changeIds.map((leadId) => {
            const closed = closing.find((row) => String(row.lead) === String(leadId));
            const update = { $unset: { assignedTo: 1, assignedAt: 1 } };
            if (closed && closed.currentStatus) update.$set = { unassignedStatus: closed.currentStatus };
            return { updateOne: { filter: { _id: leadId }, update } };
          })
        );
      }
    }

    logMetaEvent('META_LEADS_ASSIGNED', {
      userId: String(req.user._id),
      telecallerId: targetId || null,
      count: changeIds.length,
    });

    res.json({
      message: telecaller
        ? `${changeIds.length} lead(s) assigned to ${telecaller.name}`
        : `${changeIds.length} lead(s) unassigned`,
      assigned: changeIds.length,
      unchanged: leads.length - changeIds.length,
      notFound: leadIds.length - leads.length,
    });
  } catch (error) {
    if (error.code === 11000 || (error.writeErrors || []).length) {
      return res.status(409).json({ message: 'These leads were just changed by someone else. Please try again.' });
    }
    serverError(res, error, 'Server error assigning leads');
  }
};

const serializeHistory = (history) =>
  (history || []).map((entry) => ({
    statusName: entry.statusName,
    statusColor: entry.statusColor,
    remark: entry.remark,
    changedAt: entry.changedAt,
  }));

const serializeCurrentStatus = (status) =>
  status ? { _id: status._id, name: status.name, color: status.color, isConversion: status.isConversion } : null;

// @desc    Every telecaller's work on one lead (each telecaller has a separate status track)
// @route   GET /api/integrations/meta/leads/:id/assignments
// @access  Private (admin, manager)
const getMetaLeadAssignments = async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Lead not found' });

  try {
    const [assignments, lead] = await Promise.all([
      MetaLeadAssignment.find({ lead: req.params.id })
        .populate('telecaller', 'name email')
        .populate('assignedBy', 'name')
        .populate('currentStatus', 'name color isConversion')
        .sort({ isActive: -1, assignedAt: -1 }),
      MetaLead.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
        .select('unassignedStatus unassignedHistory unassignedActivityAt')
        .populate('unassignedStatus', 'name color isConversion'),
    ]);

    const hasUnassignedStatus = lead && (lead.unassignedStatus || (lead.unassignedHistory || []).length > 0);

    res.json({
      assignments: assignments.map((assignment) => ({
        _id: assignment._id,
        telecaller: assignment.telecaller,
        assignedBy: assignment.assignedBy,
        assignedAt: assignment.assignedAt,
        endedAt: assignment.endedAt || null,
        isActive: assignment.isActive,
        currentStatus: serializeCurrentStatus(assignment.currentStatus),
        history: serializeHistory(assignment.history),
        lastActivityAt: assignment.lastActivityAt || null,
      })),
      unassigned: hasUnassignedStatus
        ? {
            currentStatus: serializeCurrentStatus(lead.unassignedStatus),
            history: serializeHistory(lead.unassignedHistory),
            lastActivityAt: lead.unassignedActivityAt || null,
          }
        : null,
    });
  } catch (error) {
    serverError(res, error, 'Server error retrieving lead assignments');
  }
};

// ---------------------------------------------------------------------------
// Performance report (admin / manager)
// ---------------------------------------------------------------------------

// @desc    Performance of every telecaller on Meta leads (optionally for leads assigned within a date range)
// @route   GET /api/integrations/meta/reports/telecallers?from=&to=
// @access  Private (admin, manager)
const getTelecallerReport = async (req, res) => {
  const { range, invalid } = parseDateRange(req.query);
  if (invalid) return res.status(400).json({ message: 'Invalid date filter' });

  try {
    await ensureDefaultStatuses();
    const statuses = await MetaLeadStatus.find({}).sort({ order: 1, createdAt: 1 });
    const conversionIds = statuses.filter((status) => status.isConversion).map((status) => status._id);

    const match = range ? { assignedAt: range } : {};
    const historySize = { $size: { $ifNull: ['$history', []] } };

    const [totals, breakdown] = await Promise.all([
      MetaLeadAssignment.aggregate([
        { $match: match },
        ...assignmentsForExistingLeads,
        {
          $group: {
            _id: '$telecaller',
            totalAssigned: { $sum: 1 },
            activeLeads: { $sum: { $cond: ['$isActive', 1, 0] } },
            reassignedAway: { $sum: { $cond: ['$isActive', 0, 1] } },
            workedLeads: { $sum: { $cond: [{ $gt: [historySize, 0] }, 1, 0] } },
            notStarted: { $sum: { $cond: [{ $and: ['$isActive', { $eq: [historySize, 0] }] }, 1, 0] } },
            converted: { $sum: { $cond: [{ $in: ['$currentStatus', conversionIds] }, 1, 0] } },
            statusUpdates: { $sum: historySize },
            lastActivityAt: { $max: '$lastActivityAt' },
          },
        },
      ]),
      MetaLeadAssignment.aggregate([
        { $match: { ...match, currentStatus: { $ne: null } } },
        ...assignmentsForExistingLeads,
        { $group: { _id: { telecaller: '$telecaller', status: '$currentStatus' }, count: { $sum: 1 } } },
      ]),
    ]);

    // Every telecaller is listed, including those without any lead yet
    const users = await User.find({
      $or: [{ role: 'counsellor', isDeleted: false }, { _id: { $in: totals.map((row) => row._id) } }],
    })
      .select('name email status role isDeleted')
      .sort({ name: 1 });

    const totalsByUser = new Map(totals.map((row) => [String(row._id), row]));
    const statusById = new Map(statuses.map((status) => [String(status._id), status]));

    const telecallers = users.map((user) => {
      const row = totalsByUser.get(String(user._id)) || {};
      const totalAssigned = row.totalAssigned || 0;
      const converted = row.converted || 0;

      return {
        user: { _id: user._id, name: user.name, email: user.email, status: user.isDeleted ? 'deleted' : user.status },
        totalAssigned,
        activeLeads: row.activeLeads || 0,
        reassignedAway: row.reassignedAway || 0,
        workedLeads: row.workedLeads || 0,
        notStarted: row.notStarted || 0,
        converted,
        conversionRate: totalAssigned ? Math.round((converted / totalAssigned) * 1000) / 10 : 0,
        statusUpdates: row.statusUpdates || 0,
        lastActivityAt: row.lastActivityAt || null,
        statuses: breakdown
          .filter((entry) => String(entry._id.telecaller) === String(user._id) && statusById.has(String(entry._id.status)))
          .map((entry) => {
            const status = statusById.get(String(entry._id.status));
            return { statusId: status._id, name: status.name, color: status.color, order: status.order, count: entry.count };
          })
          .sort((a, b) => a.order - b.order),
      };
    });

    const [totalLeads, unassignedLeads] = await Promise.all([
      MetaLead.countDocuments({ processingStatus: 'processed', isDeleted: false }),
      MetaLead.countDocuments({ processingStatus: 'processed', isDeleted: false, assignedTo: { $exists: false } }),
    ]);

    res.json({ totalLeads, unassignedLeads, telecallers });
  } catch (error) {
    serverError(res, error, 'Server error building the performance report');
  }
};

// ---------------------------------------------------------------------------
// Telecaller: my leads
// ---------------------------------------------------------------------------

const serializeMyAssignment = (assignment) => ({
  _id: assignment._id,
  // Leads that were reassigned to someone else stay visible but are read-only
  isActive: assignment.isActive,
  assignedAt: assignment.assignedAt,
  endedAt: assignment.endedAt || null,
  currentStatus: serializeCurrentStatus(assignment.currentStatus),
  history: serializeHistory(assignment.history),
  lastActivityAt: assignment.lastActivityAt || null,
  lead: assignment.lead,
});

// Assignment rows can outlive the lead they point at. Counts and lists only
// include rows whose lead document is still stored.
const assignmentsForExistingLeads = [
  {
    $lookup: {
      from: MetaLead.collection.name,
      localField: 'lead',
      foreignField: '_id',
      as: 'leadDoc',
    },
  },
  { $match: { leadDoc: { $elemMatch: { isDeleted: { $ne: true } } } } },
];

const liveLeadIdsForCounsellor = async (counsellorId) => {
  const referenced = await MetaLeadAssignment.distinct('lead', { telecaller: counsellorId });
  if (!referenced.length) return [];
  return MetaLead.distinct('_id', { _id: { $in: referenced }, isDeleted: { $ne: true } });
};

// @desc    Leads assigned to the logged-in counsellor (state=active) or reassigned away from them (state=previous)
// @route   GET /api/integrations/meta/my-leads?state=&page=&limit=&search=&statusId=
// @access  Private (counsellor)
const getMyMetaLeads = async (req, res) => {
  const page = Math.max(parseInt(toStringParam(req.query.page), 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(toStringParam(req.query.limit), 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const search = toStringParam(req.query.search).slice(0, MAX_SEARCH_LENGTH).toLowerCase();
  const statusId = toStringParam(req.query.statusId);
  const isActive = toStringParam(req.query.state) !== 'previous';

  if (statusId && statusId !== 'none' && !isObjectId(statusId)) {
    return res.status(400).json({ message: 'Invalid status filter' });
  }

  try {
    const liveLeadIds = await liveLeadIdsForCounsellor(req.user._id);
    const mine = { telecaller: req.user._id, lead: { $in: liveLeadIds } };
    const filter = { ...mine, isActive };

    if (statusId === 'none') {
      filter.currentStatus = null;
    } else if (statusId) {
      filter.currentStatus = statusId;
    }

    if (search) {
      filter.lead = {
        $in: await MetaLead.distinct('_id', { _id: { $in: liveLeadIds }, searchText: { $regex: escapeRegex(search) } }),
      };
    }

    const [assignments, total, activeCount, previousCount] = await Promise.all([
      MetaLeadAssignment.find(filter)
        .populate(populateLeadForCounsellor)
        .populate('currentStatus', 'name color isConversion')
        .sort({ assignedAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      MetaLeadAssignment.countDocuments(filter),
      MetaLeadAssignment.countDocuments({ ...mine, isActive: true }),
      MetaLeadAssignment.countDocuments({ ...mine, isActive: false }),
    ]);

    res.json({
      assignments: assignments.filter((assignment) => assignment.lead).map(serializeMyAssignment),
      page,
      limit,
      total,
      totalPages: Math.max(Math.ceil(total / limit), 1),
      counts: { active: activeCount, previous: previousCount },
    });
  } catch (error) {
    serverError(res, error, 'Server error retrieving your leads');
  }
};

const statusChangeEntry = (status, remark, changedAt) => ({
  status: status._id,
  statusName: status.name,
  statusColor: status.color,
  remark,
  changedAt,
});

// @desc    Admin or manager sets a lead's status. Assignment to a counsellor is not required.
// @route   PUT /api/integrations/meta/leads/:id/status
// @access  Private (admin, manager)
const updateMetaLeadStatus = async (req, res) => {
  const body = req.body || {};
  const remark = toStringParam(body.remark).slice(0, MAX_REMARK_LENGTH);

  if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Lead not found' });
  if (!isObjectId(body.statusId)) return res.status(400).json({ message: 'Select a status' });

  try {
    const status = await MetaLeadStatus.findOne({ _id: body.statusId, isActive: true, isDeleted: false });
    if (!status) return res.status(400).json({ message: 'This status is no longer available' });

    const now = new Date();
    const entry = statusChangeEntry(status, remark, now);
    const assignment = await MetaLeadAssignment.findOneAndUpdate(
      { lead: req.params.id, isActive: true },
      {
        $set: {
          currentStatus: status._id,
          lastActivityAt: now,
          pendingRegistrationStatus: null,
          pendingRegistrationRemark: '',
        },
        $push: { history: entry },
      },
      { returnDocument: 'after' }
    ).populate('currentStatus', 'name color isConversion');

    if (assignment) {
      logMetaEvent('META_LEAD_STATUS_UPDATED', {
        userId: String(req.user._id),
        assignmentId: String(assignment._id),
        statusId: String(status._id),
        byAdmin: true,
      });

      return res.json({
        assignmentId: assignment._id,
        currentStatus: serializeCurrentStatus(assignment.currentStatus),
        history: serializeHistory(assignment.history),
        lastActivityAt: assignment.lastActivityAt,
      });
    }

    // No counsellor owns the lead yet. Keep the status on the lead itself.
    const lead = await MetaLead.findOneAndUpdate(
      { _id: req.params.id, isDeleted: { $ne: true }, assignedTo: null },
      {
        $set: { unassignedStatus: status._id, unassignedActivityAt: now },
        $push: { unassignedHistory: entry },
      },
      { returnDocument: 'after' }
    ).populate('unassignedStatus', 'name color isConversion');

    if (!lead) {
      const exists = await MetaLead.exists({ _id: req.params.id, isDeleted: { $ne: true } });
      if (!exists) return res.status(404).json({ message: 'Lead not found' });
      return res.status(409).json({ message: 'This lead was just assigned. Please try again.' });
    }

    logMetaEvent('META_LEAD_STATUS_UPDATED', {
      userId: String(req.user._id),
      leadId: String(lead._id),
      statusId: String(status._id),
      byAdmin: true,
      unassigned: true,
    });

    res.json({
      assignmentId: null,
      currentStatus: serializeCurrentStatus(lead.unassignedStatus),
      history: serializeHistory(lead.unassignedHistory),
      lastActivityAt: lead.unassignedActivityAt,
    });
  } catch (error) {
    serverError(res, error, 'Server error updating the lead status');
  }
};

// @desc    Telecaller updates their own status for a lead they currently own
// @route   PUT /api/integrations/meta/my-leads/:id/status
// @access  Private (telecaller)
const updateMyMetaLeadStatus = async (req, res) => {
  const body = req.body || {};
  const remark = toStringParam(body.remark).slice(0, MAX_REMARK_LENGTH);

  if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Lead not found' });
  if (!isObjectId(body.statusId)) return res.status(400).json({ message: 'Select a status' });

  try {
    const status = await MetaLeadStatus.findOne({ _id: body.statusId, isActive: true, isDeleted: false });
    if (!status) return res.status(400).json({ message: 'This status is no longer available' });

    const owned = await MetaLeadAssignment.findOne({
      _id: req.params.id,
      telecaller: req.user._id,
      isActive: true,
    }).select('lead');
    if (!owned) {
      const reassigned = await MetaLeadAssignment.exists({ _id: req.params.id, telecaller: req.user._id });
      if (reassigned) {
        return res.status(403).json({
          message: 'This lead has been reassigned to another counsellor. You can view it but no longer change it.',
        });
      }
      return res.status(404).json({ message: 'Lead not found' });
    }

    let registrationLead = null;
    if (status.isConversion && body.registrationBy) {
      registrationLead = await startRegistrationForMetaLead({
        metaLeadId: owned.lead,
        registrationBy: body.registrationBy,
        courseId: body.courseId,
        actor: req.user,
      });
    }

    const now = new Date();
    const statusChange = {
      status: status._id,
      statusName: status.name,
      statusColor: status.color,
      remark,
      changedAt: now,
    };
    // Opening the form must not mark the lead registered until the form is submitted.
    const deferStatus = Boolean(registrationLead && !registrationLead.formSubmittedAt);
    const update = deferStatus
      ? {
          $set: {
            pendingRegistrationStatus: status._id,
            pendingRegistrationRemark: remark,
            lastActivityAt: now,
          },
        }
      : {
          $set: {
            currentStatus: status._id,
            lastActivityAt: now,
            pendingRegistrationStatus: null,
            pendingRegistrationRemark: '',
          },
          $push: { history: statusChange },
        };

    // Only the counsellor who currently owns the lead can change it
    const assignment = await MetaLeadAssignment.findOneAndUpdate(
      { _id: req.params.id, telecaller: req.user._id, isActive: true },
      update,
      { returnDocument: 'after' }
    )
      .populate(populateLeadForCounsellor)
      .populate('currentStatus', 'name color isConversion');

    if (!assignment) {
      const reassigned = await MetaLeadAssignment.exists({ _id: req.params.id, telecaller: req.user._id });
      if (reassigned) {
        return res.status(403).json({
          message: 'This lead has been reassigned to another counsellor. You can view it but no longer change it.',
        });
      }
      return res.status(404).json({ message: 'Lead not found' });
    }

    logMetaEvent('META_LEAD_STATUS_UPDATED', {
      userId: String(req.user._id),
      assignmentId: String(assignment._id),
      statusId: String(status._id),
    });
    const payload = serializeMyAssignment(assignment);
    if (registrationLead) {
      const registration = registrationLead.toJSON();
      payload.registrationBy = registration.registrationBy;
      payload.registrationPath = registration.registrationPath || null;
      payload.formSubmitted = registration.formSubmitted;
    }
    res.json(payload);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    serverError(res, error, 'Server error updating the lead status');
  }
};

module.exports = {
  getLeadStatuses,
  createLeadStatus,
  updateLeadStatus,
  reorderLeadStatuses,
  deleteLeadStatus,
  assignMetaLeads,
  getMetaLeadAssignments,
  getTelecallerReport,
  getMyMetaLeads,
  updateMyMetaLeadStatus,
  updateMetaLeadStatus,
};
