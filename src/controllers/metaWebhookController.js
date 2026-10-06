const MetaIntegration = require('../models/MetaIntegration');
const MetaLead = require('../models/MetaLead');
const { getMetaConfig, isMetaWebhookConfigured } = require('../config/meta');
const { safeEqual, verifyWebhookSignature } = require('../utils/metaCrypto');
const { kickMetaLeadWorker } = require('../workers/metaLeadWorker');
const { logMetaEvent, logMetaError } = require('../utils/metaLogger');

const isMetaId = (value) => /^\d+$/.test(value);

// @desc    Meta webhook verification handshake
// @route   GET /api/webhooks/meta
// @access  Public (verified with META_WEBHOOK_VERIFY_TOKEN)
const verifyMetaWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (
    isMetaWebhookConfigured() &&
    mode === 'subscribe' &&
    typeof token === 'string' &&
    typeof challenge === 'string' &&
    safeEqual(token, getMetaConfig().webhookVerifyToken)
  ) {
    return res.status(200).type('text/plain').send(challenge);
  }

  logMetaError('META_WEBHOOK_REJECTED', { reason: 'verification_failed' });
  return res.status(403).json({ message: 'Webhook verification failed' });
};

// Pull the leadgen events out of a Page webhook payload
const extractLeadEvents = (payload) => {
  const events = [];

  payload.entry.forEach((entry) => {
    const changes = entry && Array.isArray(entry.changes) ? entry.changes : [];
    changes.forEach((change) => {
      if (!change || change.field !== 'leadgen' || !change.value) return;

      const value = change.value;
      const event = {
        leadId: String(value.leadgen_id || ''),
        pageId: String(value.page_id || ''),
        formId: String(value.form_id || ''),
        adId: value.ad_id ? String(value.ad_id) : undefined,
        createdTime: Number(value.created_time) || null,
      };

      if (isMetaId(event.leadId) && isMetaId(event.pageId) && isMetaId(event.formId)) {
        events.push(event);
      }
    });
  });

  return events;
};

// @desc    Receive Meta leadgen webhooks and queue each lead for retrieval
// @route   POST /api/webhooks/meta
// @access  Public (verified with the X-Hub-Signature-256 header)
const receiveMetaWebhook = async (req, res) => {
  if (!isMetaWebhookConfigured()) {
    return res.status(503).json({ message: 'Meta webhook is not configured' });
  }

  // req.body is the raw Buffer here - the signature must be checked against the exact bytes Meta sent
  const signature = req.get('X-Hub-Signature-256');
  if (!verifyWebhookSignature(req.body, signature, getMetaConfig().webhookAppSecret)) {
    logMetaError('META_WEBHOOK_REJECTED', { reason: 'invalid_signature' });
    return res.status(401).json({ message: 'Invalid webhook signature' });
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch (error) {
    payload = null;
  }

  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.entry)) {
    logMetaError('META_WEBHOOK_REJECTED', { reason: 'invalid_payload' });
    return res.status(400).json({ message: 'Invalid webhook payload' });
  }

  // Acknowledge anything that is not a Page event so Meta does not retry it
  if (payload.object !== 'page') {
    return res.status(200).send('EVENT_RECEIVED');
  }

  const events = extractLeadEvents(payload);
  logMetaEvent('META_WEBHOOK_RECEIVED', { leadEvents: events.length });

  try {
    const integration = events.length > 0 ? await MetaIntegration.findOne({ key: 'default' }) : null;
    let queued = 0;

    for (const event of events) {
      // Only accept leads for the connected Page and the lead forms the CRM selected
      const page =
        integration && integration.connected && integration.selectedPageId === event.pageId
          ? integration.pages.find((p) => p.pageId === event.pageId)
          : null;
      const form = page ? integration.forms.find((f) => f.formId === event.formId) : null;

      if (!page || !form) {
        logMetaEvent('META_WEBHOOK_IGNORED', {
          reason: page ? 'form_not_connected' : 'page_not_connected',
          pageId: event.pageId,
          formId: event.formId,
        });
        continue;
      }

      // Idempotent insert: the unique index on (source, externalLeadId) absorbs duplicates and retries
      let inserted = false;
      try {
        const newLead = {
          pageId: page.pageId,
          pageName: page.pageName,
          formId: form.formId,
          formName: form.formName,
          leadCreatedAt: event.createdTime ? new Date(event.createdTime * 1000) : new Date(),
          processingStatus: 'pending',
          attempts: 0,
          nextAttemptAt: new Date(),
          isDeleted: false,
        };
        if (event.adId) newLead.adId = event.adId;

        const result = await MetaLead.updateOne(
          { source: 'META', externalLeadId: event.leadId },
          { $setOnInsert: newLead },
          { upsert: true }
        );
        inserted = result.upsertedCount === 1;
      } catch (error) {
        // Two deliveries of the same lead raced each other - the lead is already stored
        if (error.code !== 11000) throw error;
      }

      if (inserted) {
        queued += 1;
        logMetaEvent('META_LEAD_QUEUED', { leadId: event.leadId, pageId: event.pageId, formId: event.formId });
      } else {
        logMetaEvent('META_LEAD_DUPLICATE', { leadId: event.leadId });
      }
    }

    if (queued > 0) kickMetaLeadWorker();

    return res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    // A non-200 response makes Meta redeliver the event later
    logMetaError('META_WEBHOOK_QUEUE_FAILED', { reason: error.name });
    return res.status(500).json({ message: 'Could not queue webhook event' });
  }
};

module.exports = {
  verifyMetaWebhook,
  receiveMetaWebhook,
};
