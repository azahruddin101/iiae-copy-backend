const mongoose = require('mongoose');

// Progress of one lead form inside a historical sync
const syncFormSchema = mongoose.Schema(
  {
    formId: {
      type: String,
      required: true,
    },
    formName: {
      type: String,
      default: '',
    },
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed'],
      default: 'pending',
    },
    leadsProcessed: { type: Number, default: 0 },
    leadsImported: { type: Number, default: 0 },
    duplicatesSkipped: { type: Number, default: 0 },
    failedLeads: { type: Number, default: 0 },
    // Meta pagination cursor of the next page - lets an interrupted sync resume where it stopped
    cursor: String,
    // Ad-level lead fields were not readable for this form, so only the basic fields are requested
    basicFields: { type: Boolean, default: false },
    attempts: { type: Number, default: 0 },
    // Error code (see SYNC_ERROR_MESSAGES in the sync controller)
    error: String,
  },
  { _id: false }
);

// A "Sync Previous Leads" run: imports the leads already submitted to the connected lead forms.
// The collection is also the queue the sync worker reads from.
const metaSyncJobSchema = mongoose.Schema(
  {
    // 'active' while the job is pending/processing, removed when it finishes.
    // The unique index below guarantees that only one sync runs at a time.
    activeKey: String,
    status: {
      type: String,
      required: true,
      enum: ['pending', 'processing', 'completed', 'failed'],
      default: 'pending',
    },
    pageId: {
      type: String,
      required: true,
    },
    pageName: {
      type: String,
      default: '',
    },
    forms: [syncFormSchema],

    totalForms: { type: Number, default: 0 },
    formsProcessed: { type: Number, default: 0 },
    formsFailed: { type: Number, default: 0 },
    leadsProcessed: { type: Number, default: 0 },
    leadsImported: { type: Number, default: 0 },
    duplicatesSkipped: { type: Number, default: 0 },
    failedLeads: { type: Number, default: 0 },

    // Queue state
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    // Heartbeat of the worker running the job; a stale value means the worker died
    lockedAt: Date,

    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    startedAt: Date,
    completedAt: Date,
    error: String,
  },
  {
    timestamps: true,
  }
);

metaSyncJobSchema.index({ activeKey: 1 }, { unique: true, sparse: true });
metaSyncJobSchema.index({ status: 1, nextAttemptAt: 1 });
metaSyncJobSchema.index({ createdAt: -1 });

const MetaSyncJob = mongoose.model('MetaSyncJob', metaSyncJobSchema);

module.exports = MetaSyncJob;
