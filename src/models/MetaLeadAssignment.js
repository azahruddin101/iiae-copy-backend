const mongoose = require('mongoose');

// One status change made by the telecaller
const statusHistorySchema = mongoose.Schema(
  {
    status: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MetaLeadStatus',
      required: true,
    },
    // Copied at the time of the change so the timeline survives a renamed or deleted status
    statusName: {
      type: String,
      required: true,
    },
    statusColor: {
      type: String,
      default: 'slate',
    },
    remark: {
      type: String,
      default: '',
    },
    changedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

// A telecaller's own work on a Meta lead.
// Every telecaller a lead is assigned to gets a separate record with a separate status track.
// When the lead is reassigned the previous telecaller's record becomes inactive: it stays
// visible to them exactly as they left it, but can no longer be changed.
const metaLeadAssignmentSchema = mongoose.Schema(
  {
    lead: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MetaLead',
      required: true,
    },
    telecaller: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    assignedAt: {
      type: Date,
      default: Date.now,
    },
    // true = this telecaller currently owns the lead
    isActive: {
      type: Boolean,
      default: true,
    },
    // When the lead was taken away from this telecaller
    endedAt: {
      type: Date,
    },
    // This telecaller's current status for the lead (null = not started)
    currentStatus: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MetaLeadStatus',
      default: null,
    },
    // Conversion status chosen when the form was opened. Applied only after the form is submitted.
    pendingRegistrationStatus: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MetaLeadStatus',
      default: null,
    },
    pendingRegistrationRemark: {
      type: String,
      default: '',
    },
    history: [statusHistorySchema],
    lastActivityAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// One record per telecaller per lead
metaLeadAssignmentSchema.index({ lead: 1, telecaller: 1 }, { unique: true });
// A lead has at most one current owner
metaLeadAssignmentSchema.index({ lead: 1 }, { unique: true, partialFilterExpression: { isActive: true } });
// "My leads" list
metaLeadAssignmentSchema.index({ telecaller: 1, isActive: 1, assignedAt: -1 });

const MetaLeadAssignment = mongoose.model('MetaLeadAssignment', metaLeadAssignmentSchema);

module.exports = MetaLeadAssignment;
