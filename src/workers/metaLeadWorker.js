const mongoose = require('mongoose');
const MetaLead = require('../models/MetaLead');
const MetaIntegration = require('../models/MetaIntegration');
const { isMetaConfigured } = require('../config/meta');
const { decryptToken } = require('../utils/metaCrypto');
const { refreshMetaSettings } = require('../utils/metaSettings');
const { normalizeMetaLead } = require('../utils/metaLeadNormalizer');
const { processPendingSyncJobs } = require('./metaSyncWorker');
const { getLead, MetaGraphError } = require('../utils/metaGraph');
const { logMetaEvent, logMetaError } = require('../utils/metaLogger');

// Background worker for Meta leads.
// The webhook stores each lead ID as a 'pending' MetaLead; this worker claims pending
// leads one at a time, retrieves them from the Graph API and stores the answers.
// The queue lives in MongoDB, so queued leads survive a server restart.

const POLL_INTERVAL_MS = 15 * 1000;
const LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const MAX_LEADS_PER_RUN = 50;
const BASE_RETRY_DELAY_MS = 30 * 1000;
const RATE_LIMIT_RETRY_DELAY_MS = 5 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;

let timer = null;
let running = false;
let runAgain = false;

// Exponential backoff: 30s, 1m, 2m, 4m ... (rate limits start at 5m)
const getRetryDelayMs = (attempts, kind) => {
  const base = kind === 'RATE_LIMIT' ? RATE_LIMIT_RETRY_DELAY_MS : BASE_RETRY_DELAY_MS;
  return Math.min(base * 2 ** Math.max(attempts - 1, 0), MAX_RETRY_DELAY_MS);
};

// Atomically claim the next lead that is due (or whose previous run got stuck)
const claimNextLead = () => {
  const now = new Date();
  return MetaLead.findOneAndUpdate(
    {
      $or: [
        { processingStatus: 'pending', nextAttemptAt: { $lte: now } },
        { processingStatus: 'processing', lockedAt: { $lte: new Date(now.getTime() - LOCK_TIMEOUT_MS) } },
      ],
    },
    { $set: { processingStatus: 'processing', lockedAt: now }, $inc: { attempts: 1 } },
    { sort: { nextAttemptAt: 1 }, returnDocument: 'after' }
  );
};

const retryOrFailLead = async (lead, reason, { retryable = false, kind } = {}) => {
  const willRetry = retryable && lead.attempts < MAX_ATTEMPTS;

  await MetaLead.updateOne(
    { _id: lead._id },
    {
      $set: {
        processingStatus: willRetry ? 'pending' : 'failed',
        nextAttemptAt: new Date(Date.now() + getRetryDelayMs(lead.attempts, kind)),
        lastError: reason,
      },
      $unset: { lockedAt: 1 },
    }
  );

  logMetaError('META_LEAD_FAILED', {
    leadId: lead.externalLeadId,
    reason,
    attempt: lead.attempts,
    willRetry,
  });
};

// Retrieve one claimed lead from Meta and store it
const processLead = async (lead) => {
  const integration = await MetaIntegration.findOne({ key: 'default' });
  if (!integration || !integration.connected) {
    return retryOrFailLead(lead, 'MISSING_INTEGRATION');
  }

  const page = integration.pages.find((p) => p.pageId === lead.pageId);
  if (!page) {
    return retryOrFailLead(lead, 'INVALID_PAGE');
  }

  let pageToken;
  try {
    pageToken = decryptToken(page.accessTokenEncrypted);
  } catch (error) {
    return retryOrFailLead(lead, 'TOKEN_DECRYPT_FAILED');
  }

  let raw;
  try {
    raw = await getLead(lead.externalLeadId, pageToken);
  } catch (error) {
    if (!(error instanceof MetaGraphError)) throw error;

    if (error.kind === 'TOKEN_INVALID') {
      await MetaIntegration.updateOne({ key: 'default' }, { $set: { needsReconnect: true } });
    }
    return retryOrFailLead(lead, `META_${error.kind}`, { retryable: error.retryable, kind: error.kind });
  }

  await MetaLead.updateOne(
    { _id: lead._id },
    {
      $set: {
        ...normalizeMetaLead(raw),
        rawData: raw,
        processingStatus: 'processed',
        processedAt: new Date(),
      },
      $unset: { lockedAt: 1, lastError: 1 },
    }
  );
  await MetaIntegration.updateOne({ key: 'default' }, { $set: { lastLeadReceivedAt: new Date() } });

  logMetaEvent('META_LEAD_PROCESSED', { leadId: lead.externalLeadId, formId: lead.formId });
};

// Process every lead that is currently due. Returns the number of leads handled.
const processPendingLeads = async () => {
  if (running) {
    runAgain = true;
    return 0;
  }

  running = true;
  let handled = 0;

  try {
    // Pick up Meta app settings saved through the CRM; stay idle until Meta is set up
    await refreshMetaSettings();
    if (!isMetaConfigured()) return 0;

    do {
      runAgain = false;
      while (handled < MAX_LEADS_PER_RUN) {
        const lead = await claimNextLead();
        if (!lead) break;

        try {
          await processLead(lead);
        } catch (error) {
          // Unexpected failure (e.g. database error) - keep the lead queued for another attempt
          await retryOrFailLead(lead, 'INTERNAL_ERROR', { retryable: true }).catch(() => {});
        }
        handled += 1;
      }
    } while (runAgain && handled < MAX_LEADS_PER_RUN);
  } catch (error) {
    logMetaError('META_WORKER_ERROR', { reason: error.name });
  } finally {
    running = false;
  }

  return handled;
};

// Put failed leads back in the queue (used after the Meta connection is repaired)
const requeueFailedLeads = async (pageId) => {
  const filter = { processingStatus: 'failed' };
  if (pageId) filter.pageId = pageId;

  const result = await MetaLead.updateMany(filter, {
    $set: { processingStatus: 'pending', attempts: 0, nextAttemptAt: new Date() },
    $unset: { lastError: 1, lockedAt: 1 },
  });
  return result.modifiedCount || 0;
};

// Start polling. Each run is a single small query until Meta has been set up in the CRM.
const startMetaLeadWorker = () => {
  if (timer) return false;

  timer = setInterval(() => {
    if (mongoose.connection.readyState === 1) {
      processPendingLeads();
      // Historical sync jobs run on their own chain so they never delay real-time leads
      processPendingSyncJobs();
    }
  }, POLL_INTERVAL_MS);
  timer.unref();

  return true;
};

const stopMetaLeadWorker = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};

// Process new leads right away instead of waiting for the next poll
const kickMetaLeadWorker = () => {
  if (!timer) return;
  setImmediate(processPendingLeads);
};

// Start a queued historical sync right away instead of waiting for the next poll
const kickMetaSyncWorker = () => {
  if (!timer) return;
  setImmediate(processPendingSyncJobs);
};

module.exports = {
  MAX_ATTEMPTS,
  normalizeMetaLead,
  processPendingLeads,
  requeueFailedLeads,
  startMetaLeadWorker,
  stopMetaLeadWorker,
  kickMetaLeadWorker,
  kickMetaSyncWorker,
};
