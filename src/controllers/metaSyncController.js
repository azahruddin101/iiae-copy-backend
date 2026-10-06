const MetaIntegration = require('../models/MetaIntegration');
const MetaSyncJob = require('../models/MetaSyncJob');
const { kickMetaSyncWorker } = require('../workers/metaLeadWorker');
const { logMetaEvent, logMetaError } = require('../utils/metaLogger');

// User-safe explanations for the error codes the sync worker records
const SYNC_ERROR_MESSAGES = {
  META_NOT_CONFIGURED: 'The Meta app is not set up. Add your Meta app and connect again.',
  META_NOT_CONNECTED: 'Meta is not connected. Connect Meta and sync again.',
  META_PAGE_NOT_CONNECTED: 'The Facebook Page is no longer part of the Meta connection. Reconnect Meta and sync again.',
  META_TOKEN_INVALID: 'Meta access has expired or was revoked. Reconnect Meta and sync again.',
  META_PERMISSION: 'Meta denied access to the leads of this form. Make sure the connected Facebook account has leads access for the Page.',
  META_FORM_UNAVAILABLE: 'This form or its leads are no longer available on Meta. Meta only keeps leads for 90 days after they are submitted.',
  META_UNAVAILABLE: 'Meta was unavailable or rate limited for too long. Leads imported so far are kept - try the sync again later.',
};

const getErrorMessage = (code) => (code ? SYNC_ERROR_MESSAGES[code] || 'The sync could not be completed. Please try again.' : null);

// Only counts, status and safe messages leave the server
const serializeSyncJob = (job) => {
  if (!job) return null;

  return {
    id: String(job._id),
    status: job.status,
    pageName: job.pageName,
    totalForms: job.totalForms,
    formsProcessed: job.formsProcessed,
    formsFailed: job.formsFailed,
    leadsProcessed: job.leadsProcessed,
    leadsImported: job.leadsImported,
    duplicatesSkipped: job.duplicatesSkipped,
    failedLeads: job.failedLeads,
    // Set while the job waits to retry after Meta was busy or rate limited
    retryAt: job.status === 'pending' && job.attempts > 0 ? job.nextAttemptAt : null,
    startedAt: job.startedAt || null,
    completedAt: job.completedAt || null,
    createdAt: job.createdAt,
    error: getErrorMessage(job.error),
    forms: job.forms.map((form) => ({
      formId: form.formId,
      formName: form.formName,
      status: form.status,
      leadsProcessed: form.leadsProcessed,
      leadsImported: form.leadsImported,
      duplicatesSkipped: form.duplicatesSkipped,
      failedLeads: form.failedLeads,
      error: getErrorMessage(form.error),
    })),
  };
};

// @desc    Start a historical sync of the leads already submitted to the connected lead forms
// @route   POST /api/integrations/meta/sync
// @access  Private (admin, manager)
const startMetaSync = async (req, res) => {
  try {
    const integration = await MetaIntegration.findOne({ key: 'default' });
    if (!integration || !integration.connected) {
      return res.status(409).json({ message: 'Meta is not connected' });
    }
    if (integration.needsReconnect) {
      return res.status(409).json({
        code: 'META_RECONNECT_REQUIRED',
        message: 'The Meta connection has expired or was revoked. Please reconnect Meta.',
      });
    }

    const page = integration.pages.find((p) => p.pageId === integration.selectedPageId);
    if (!page || integration.forms.length === 0) {
      return res.status(400).json({ message: 'Select a Facebook Page and lead forms first' });
    }

    // The Page and forms come from the stored connection - nothing from the request is trusted
    let job;
    try {
      job = await MetaSyncJob.create({
        activeKey: 'active',
        status: 'pending',
        pageId: page.pageId,
        pageName: page.pageName,
        forms: integration.forms.map((form) => ({ formId: form.formId, formName: form.formName })),
        totalForms: integration.forms.length,
        nextAttemptAt: new Date(),
        requestedBy: req.user._id,
      });
    } catch (error) {
      if (error.code !== 11000) throw error;

      // A sync is already running: report that one instead of starting a second
      const active = await MetaSyncJob.findOne({ activeKey: 'active' });
      return res.status(200).json({ alreadyRunning: true, sync: serializeSyncJob(active) });
    }

    logMetaEvent('META_SYNC_STARTED', { jobId: String(job._id), userId: String(req.user._id), forms: job.totalForms });
    kickMetaSyncWorker();

    res.status(202).json({ alreadyRunning: false, sync: serializeSyncJob(job) });
  } catch (error) {
    logMetaError('META_INTERNAL_ERROR', { reason: error.name });
    res.status(500).json({ message: 'Server error starting the lead sync' });
  }
};

// @desc    Progress and result of the most recent historical sync
// @route   GET /api/integrations/meta/sync/status
// @access  Private (admin, manager)
const getMetaSyncStatus = async (req, res) => {
  try {
    const job = await MetaSyncJob.findOne().sort({ createdAt: -1 });
    res.json({ sync: serializeSyncJob(job) });
  } catch (error) {
    logMetaError('META_INTERNAL_ERROR', { reason: error.name });
    res.status(500).json({ message: 'Server error retrieving the lead sync status' });
  }
};

module.exports = {
  startMetaSync,
  getMetaSyncStatus,
};
