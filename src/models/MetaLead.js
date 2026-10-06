const mongoose = require('mongoose');

const metaLeadSchema = mongoose.Schema(
  {
    source: {
      type: String,
      required: true,
      enum: ['META'],
      default: 'META',
    },
    // Meta leadgen ID
    externalLeadId: {
      type: String,
      required: true,
    },
    pageId: {
      type: String,
      required: true,
    },
    pageName: {
      type: String,
      default: '',
    },
    formId: {
      type: String,
      required: true,
    },
    formName: {
      type: String,
      default: '',
    },
    campaignId: String,
    campaignName: String,
    adSetId: String,
    adSetName: String,
    adId: String,
    adName: String,
    platform: String,
    isOrganic: Boolean,

    // Best-effort copies of common answers, only set when the form asks for them
    fullName: {
      type: String,
      default: '',
    },
    email: {
      type: String,
      default: '',
    },
    phone: {
      type: String,
      default: '',
    },
    // Lower-cased answers used by the server-side search
    searchText: {
      type: String,
      default: '',
    },

    // Answers keyed by the form's own question keys - differs per form
    fields: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    // Lead exactly as returned by the Graph API
    rawData: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    // When the lead was submitted on Meta
    leadCreatedAt: {
      type: Date,
    },

    // Processing queue state (webhook -> pending -> worker -> processed / failed)
    processingStatus: {
      type: String,
      required: true,
      enum: ['pending', 'processing', 'processed', 'failed'],
      default: 'pending',
    },
    attempts: {
      type: Number,
      default: 0,
    },
    nextAttemptAt: {
      type: Date,
      default: Date.now,
    },
    lockedAt: {
      type: Date,
    },
    lastError: {
      type: String,
    },
    processedAt: {
      type: Date,
    },

    // CRM lead created when this Meta lead is marked registered, so the same form can open
    crmLead: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Lead',
    },

    // Telecaller who currently owns the lead (their work is tracked in MetaLeadAssignment)
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    assignedAt: {
      type: Date,
    },

    // Status an admin or manager set before the lead was assigned to a counsellor.
    // Once a counsellor owns the lead, their assignment track is the status instead.
    unassignedStatus: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MetaLeadStatus',
      default: null,
    },
    unassignedHistory: {
      type: [
        new mongoose.Schema(
          {
            status: {
              type: mongoose.Schema.Types.ObjectId,
              ref: 'MetaLeadStatus',
              required: true,
            },
            statusName: { type: String, required: true },
            statusColor: { type: String, default: 'slate' },
            remark: { type: String, default: '' },
            changedAt: { type: Date, default: Date.now },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    unassignedActivityAt: {
      type: Date,
    },

    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    minimize: false,
  }
);

// Idempotency: a Meta lead can only ever be stored once
metaLeadSchema.index({ source: 1, externalLeadId: 1 }, { unique: true });
// Worker queue lookup
metaLeadSchema.index({ processingStatus: 1, nextAttemptAt: 1 });
// Lead list
metaLeadSchema.index({ processingStatus: 1, leadCreatedAt: -1 });
metaLeadSchema.index({ formId: 1, leadCreatedAt: -1 });
metaLeadSchema.index({ assignedTo: 1, leadCreatedAt: -1 });

const MetaLead = mongoose.model('MetaLead', metaLeadSchema);

module.exports = MetaLead;
