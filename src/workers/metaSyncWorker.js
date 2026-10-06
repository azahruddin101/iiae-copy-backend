const MetaSyncJob = require('../models/MetaSyncJob');
const MetaLead = require('../models/MetaLead');
const MetaIntegration = require('../models/MetaIntegration');
const { isMetaConfigured } = require('../config/meta');
const { decryptToken } = require('../utils/metaCrypto');
const { refreshMetaSettings } = require('../utils/metaSettings');
const { getFormLeadsPage, MetaGraphError } = require('../utils/metaGraph');
const { normalizeMetaLead } = require('../utils/metaLeadNormalizer');
const { logMetaEvent, logMetaError } = require('../utils/metaLogger');

// Historical sync worker ("Sync Previous Leads").
// A sync job lists the connected lead forms. For each form the worker reads GET /{form-id}/leads
// page by page, following Meta's cursor until there are no more pages, and stores every lead
// in MetaLead using the same unique key as the webhook flow. Progress (counts + cursor) is
// saved after every page, so the job survives a server restart and resumes where it stopped.

const LOCK_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_FORM_ATTEMPTS = 5;
const MAX_JOB_ATTEMPTS = 10;
const MAX_PAGES_PER_FORM = 5000;
const MIN_PAGE_SIZE = 25;
const BASE_RETRY_DELAY_MS = 30 * 1000;
const RATE_LIMIT_RETRY_DELAY_MS = 5 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

// Tunable so tests can run without waiting
const SYNC_SETTINGS = {
  pageSize: 100,
  // Pause between two pages of the same form - pages are fetched one at a time, never in parallel
  pageDelayMs: 250,
  // Immediate retries of a page after a transient Meta error, before the job is put back in the queue
  retryDelaysMs: [1000, 3000],
};

let running = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getJobRetryDelayMs = (attempts, kind) => {
  const base = kind === 'RATE_LIMIT' ? RATE_LIMIT_RETRY_DELAY_MS : BASE_RETRY_DELAY_MS;
  return Math.min(base * 2 ** Math.max(attempts - 1, 0), MAX_RETRY_DELAY_MS);
};

// Keep the job totals in step with the per-form numbers
const recalculateTotals = (job) => {
  const sum = (key) => job.forms.reduce((total, form) => total + (form[key] || 0), 0);

  job.totalForms = job.forms.length;
  job.formsProcessed = job.forms.filter((form) => ['completed', 'failed'].includes(form.status)).length;
  job.formsFailed = job.forms.filter((form) => form.status === 'failed').length;
  job.leadsProcessed = sum('leadsProcessed');
  job.leadsImported = sum('leadsImported');
  job.duplicatesSkipped = sum('duplicatesSkipped');
  job.failedLeads = sum('failedLeads');
};

// Save progress and refresh the heartbeat
const saveProgress = (job) => {
  recalculateTotals(job);
  job.lockedAt = new Date();
  return job.save();
};

const failForm = (form, errorCode) => {
  form.status = 'failed';
  form.error = errorCode;
  form.cursor = undefined;
};

const finishJob = async (job, errorCode) => {
  if (errorCode) {
    job.forms.forEach((form) => {
      if (!['completed', 'failed'].includes(form.status)) failForm(form, errorCode);
    });
  }
  recalculateTotals(job);
  // The job only counts as failed when nothing could be synced at all
  const failed = Boolean(errorCode) || job.formsFailed === job.totalForms;

  job.status = failed ? 'failed' : 'completed';
  job.error = errorCode || (failed && job.forms[0] ? job.forms[0].error : undefined);
  job.completedAt = new Date();
  job.activeKey = undefined;
  job.lockedAt = undefined;
  await job.save();

  logMetaEvent(failed ? 'META_SYNC_FAILED' : 'META_SYNC_COMPLETED', {
    jobId: String(job._id),
    error: job.error,
    formsFailed: job.formsFailed,
    leadsImported: job.leadsImported,
    duplicatesSkipped: job.duplicatesSkipped,
    failedLeads: job.failedLeads,
  });
};

// Put the job back in the queue to try again later (Meta busy, rate limited, database hiccup)
const rescheduleJob = async (job, kind) => {
  job.attempts += 1;
  if (job.attempts >= MAX_JOB_ATTEMPTS) {
    job.forms.forEach((form) => {
      if (!['completed', 'failed'].includes(form.status)) failForm(form, 'META_UNAVAILABLE');
    });
    return finishJob(job);
  }

  recalculateTotals(job);
  job.status = 'pending';
  job.nextAttemptAt = new Date(Date.now() + getJobRetryDelayMs(job.attempts, kind));
  job.lockedAt = undefined;
  await job.save();

  logMetaEvent('META_SYNC_RESCHEDULED', { jobId: String(job._id), kind, attempt: job.attempts });
};

// Store one page of leads. Uses the same unique key as the webhook flow
// (source + externalLeadId), so a lead can never be stored twice.
const storeLeads = async (job, form, leads) => {
  const counts = { imported: 0, duplicates: 0, failed: 0 };
  const valid = leads.filter((lead) => lead && /^\d+$/.test(String(lead.id || '')));
  counts.failed += leads.length - valid.length;
  if (valid.length === 0) return counts;

  const now = new Date();
  const documents = valid.map((lead) => ({
    externalLeadId: String(lead.id),
    values: {
      ...normalizeMetaLead(lead),
      rawData: lead,
      processingStatus: 'processed',
      processedAt: now,
    },
  }));

  // 1. Insert the leads that are not stored yet. Existing leads are left completely untouched.
  let insertedIndexes;
  try {
    const result = await MetaLead.bulkWrite(
      documents.map((doc) => ({
        updateOne: {
          filter: { source: 'META', externalLeadId: doc.externalLeadId },
          update: {
            $setOnInsert: {
              ...doc.values,
              pageId: job.pageId,
              pageName: job.pageName,
              formId: form.formId,
              formName: form.formName,
              attempts: 0,
              isDeleted: false,
              createdAt: now,
              updatedAt: now,
            },
          },
          upsert: true,
          timestamps: false,
        },
      })),
      { ordered: false }
    );
    insertedIndexes = Object.keys(result.upsertedIds || {}).map(Number);
  } catch (error) {
    // A webhook delivered one of these leads at the same moment: the unique index rejected
    // our copy. Everything else in the batch was still written.
    const writeErrors = error.writeErrors || [];
    const onlyDuplicates = writeErrors.length > 0 && writeErrors.every((e) => (e.code || (e.err && e.err.code)) === 11000);
    if (!onlyDuplicates || !error.result) throw error;
    insertedIndexes = Object.keys(error.result.upsertedIds || {}).map(Number);
  }

  const inserted = new Set(insertedIndexes);
  counts.imported += inserted.size;

  // 2. Leads that already exist only as an unfinished webhook entry (queued or failed) are
  //    completed with the data we already have. Leads that are fully stored are duplicates.
  const existing = documents.filter((doc, index) => !inserted.has(index));
  if (existing.length > 0) {
    const result = await MetaLead.bulkWrite(
      existing.map((doc) => ({
        updateOne: {
          filter: {
            source: 'META',
            externalLeadId: doc.externalLeadId,
            processingStatus: { $in: ['pending', 'failed'] },
          },
          update: { $set: doc.values, $unset: { lastError: 1, lockedAt: 1 } },
        },
      })),
      { ordered: false }
    );
    const completed = result.modifiedCount || 0;
    counts.imported += completed;
    counts.duplicates += existing.length - completed;
  }

  return counts;
};

// Fetch one page, retrying transient Meta errors a few times before giving up for now
const fetchLeadsPage = async (form, pageToken, pageSize) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await getFormLeadsPage(form.formId, pageToken, {
        after: form.cursor,
        limit: pageSize.value,
        basicFields: form.basicFields,
      });
    } catch (error) {
      if (!(error instanceof MetaGraphError)) throw error;

      // Ad-level fields are not readable with this token: continue with the basic lead fields
      if (!form.basicFields && ['PERMISSION', 'INVALID_REQUEST'].includes(error.kind)) {
        form.basicFields = true;
        continue;
      }

      // "Please reduce the amount of data you're asking for"
      if (error.code === 1 && pageSize.value > MIN_PAGE_SIZE) {
        pageSize.value = Math.max(Math.floor(pageSize.value / 2), MIN_PAGE_SIZE);
      }

      // Rate limits are never hammered: the job goes back to the queue with a long delay
      const delay = SYNC_SETTINGS.retryDelaysMs[attempt];
      if (!error.retryable || error.kind === 'RATE_LIMIT' || delay === undefined) throw error;
      await sleep(delay);
    }
  }
};

// Import every lead of one form.
// Returns { outcome: 'completed' | 'failed' | 'reschedule' | 'abort', kind } (kind = why a retry is needed).
const syncForm = async (job, form, pageToken) => {
  form.status = 'processing';
  const pageSize = { value: SYNC_SETTINGS.pageSize };

  await saveProgress(job);

  for (let pageNumber = 0; pageNumber < MAX_PAGES_PER_FORM; pageNumber += 1) {
    let page;
    try {
      page = await fetchLeadsPage(form, pageToken, pageSize);
    } catch (error) {
      if (!(error instanceof MetaGraphError)) throw error;

      logMetaError('META_SYNC_FORM_ERROR', {
        jobId: String(job._id),
        formId: form.formId,
        kind: error.kind,
        code: error.code,
        fbtraceId: error.fbtraceId,
      });

      // The token is shared by every form: nothing else can succeed until Meta is reconnected
      if (error.kind === 'TOKEN_INVALID') {
        await MetaIntegration.updateOne({ key: 'default' }, { $set: { needsReconnect: true } });
        failForm(form, 'META_TOKEN_INVALID');
        return { outcome: 'abort' };
      }

      if (error.retryable) {
        form.attempts += 1;
        if (form.attempts < MAX_FORM_ATTEMPTS) {
          return { outcome: 'reschedule', kind: error.kind };
        }
        failForm(form, 'META_UNAVAILABLE');
        return { outcome: 'failed' };
      }

      // Permanent errors are not retried
      failForm(form, error.kind === 'PERMISSION' ? 'META_PERMISSION' : 'META_FORM_UNAVAILABLE');
      return { outcome: 'failed' };
    }

    const counts = await storeLeads(job, form, page.leads);
    form.leadsProcessed += page.leads.length;
    form.leadsImported += counts.imported;
    form.duplicatesSkipped += counts.duplicates;
    form.failedLeads += counts.failed;

    // No further cursor (or Meta repeated the same one): this form is done
    if (!page.nextCursor || page.nextCursor === form.cursor) break;
    form.cursor = page.nextCursor;

    // Persist counts + cursor right away so a restart resumes from the next page
    await saveProgress(job);

    if (SYNC_SETTINGS.pageDelayMs > 0) await sleep(SYNC_SETTINGS.pageDelayMs);
  }

  form.status = 'completed';
  form.cursor = undefined;
  form.error = undefined;
  await saveProgress(job);
  return { outcome: 'completed' };
};

const runJob = async (job) => {
  if (!job.startedAt) job.startedAt = new Date();

  if (!isMetaConfigured()) return finishJob(job, 'META_NOT_CONFIGURED');

  const integration = await MetaIntegration.findOne({ key: 'default' });
  if (!integration || !integration.connected) return finishJob(job, 'META_NOT_CONNECTED');

  const page = integration.pages.find((p) => p.pageId === job.pageId);
  if (!page) return finishJob(job, 'META_PAGE_NOT_CONNECTED');

  let pageToken;
  try {
    pageToken = decryptToken(page.accessTokenEncrypted);
  } catch (error) {
    return finishJob(job, 'META_TOKEN_INVALID');
  }

  // Forms are processed one after another and independently: a failed form never
  // undoes or blocks the leads imported from the other forms.
  for (const form of job.forms) {
    if (['completed', 'failed'].includes(form.status)) continue;

    const { outcome, kind } = await syncForm(job, form, pageToken);

    if (outcome === 'reschedule') {
      return rescheduleJob(job, kind);
    }

    if (outcome === 'abort') {
      job.forms.forEach((other) => {
        if (!['completed', 'failed'].includes(other.status)) failForm(other, 'META_TOKEN_INVALID');
      });
      break;
    }
  }

  return finishJob(job);
};

// Atomically claim the next job: one that is due, or one whose worker stopped sending heartbeats
// (server restarted or crashed in the middle of a sync).
const claimNextJob = () => {
  const now = new Date();
  return MetaSyncJob.findOneAndUpdate(
    {
      $or: [
        { status: 'pending', nextAttemptAt: { $lte: now } },
        { status: 'processing', lockedAt: { $lte: new Date(now.getTime() - LOCK_TIMEOUT_MS) } },
      ],
    },
    { $set: { status: 'processing', lockedAt: now } },
    { sort: { createdAt: 1 }, returnDocument: 'after' }
  );
};

// Run every sync job that is currently due. Returns the number of jobs handled.
const processPendingSyncJobs = async () => {
  if (running) return 0;
  running = true;
  let handled = 0;

  try {
    await refreshMetaSettings();

    for (;;) {
      const job = await claimNextJob();
      if (!job) break;
      handled += 1;

      try {
        await runJob(job);
      } catch (error) {
        // Unexpected failure (e.g. database error): keep the progress and try again later
        logMetaError('META_SYNC_ERROR', { jobId: String(job._id), reason: error.name });
        await rescheduleJob(job, 'INTERNAL').catch(() => {});
      }
    }
  } catch (error) {
    logMetaError('META_SYNC_WORKER_ERROR', { reason: error.name });
  } finally {
    running = false;
  }

  return handled;
};

module.exports = {
  SYNC_SETTINGS,
  LOCK_TIMEOUT_MS,
  MAX_FORM_ATTEMPTS,
  processPendingSyncJobs,
};
