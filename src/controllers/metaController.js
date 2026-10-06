const mongoose = require('mongoose');
const User = require('../models/User');
const MetaIntegration = require('../models/MetaIntegration');
const MetaLead = require('../models/MetaLead');
const MetaOAuthState = require('../models/MetaOAuthState');
const MetaLeadAssignment = require('../models/MetaLeadAssignment');
const {
  META_OAUTH_SCOPES,
  META_ALLOWED_ROLES,
  getMetaConfig,
  isMetaAppFromEnv,
  isValidUrl,
  isMetaConfigured,
  isMetaWebhookConfigured,
} = require('../config/meta');
const { encryptToken, decryptToken, sha256Hex, generateOAuthState } = require('../utils/metaCrypto');
const { OAUTH_CALLBACK_PATH, WEBHOOK_PATH, refreshMetaSettings } = require('../utils/metaSettings');
const {
  MetaGraphError,
  verifyAppCredentials,
  buildOAuthDialogUrl,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  getMetaUser,
  getGrantedPermissions,
  getUserPages,
  getPageLeadForms,
  subscribePageToLeadgen,
  unsubscribePage,
} = require('../utils/metaGraph');
const { requeueFailedLeads, kickMetaLeadWorker } = require('../workers/metaLeadWorker');
const { logMetaEvent, logMetaError } = require('../utils/metaLogger');

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_FORMS_PER_PAGE = 50;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_SEARCH_LENGTH = 100;

const getIntegration = () => MetaIntegration.findOne({ key: 'default' });

const toStringParam = (value) => (typeof value === 'string' ? value.trim() : '');

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Send the browser back to the frontend integration page after the OAuth callback
const redirectToFrontend = (res, params) => {
  const url = new URL(getMetaConfig().frontendRedirectUrl);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return res.redirect(url.toString());
};

// Translate Meta/Graph failures into safe API responses.
// 401 is never used here: the frontend treats 401 as an expired CRM session and logs the user out.
const sendMetaError = async (res, error, fallbackMessage) => {
  if (error instanceof MetaGraphError) {
    logMetaError('META_API_ERROR', { kind: error.kind, code: error.code, fbtraceId: error.fbtraceId });

    switch (error.kind) {
      case 'TOKEN_INVALID':
        await MetaIntegration.updateOne({ key: 'default' }, { $set: { needsReconnect: true } }).catch(() => {});
        return res.status(409).json({
          code: 'META_RECONNECT_REQUIRED',
          message: 'The Meta connection has expired or was revoked. Please reconnect Meta.',
        });
      case 'PERMISSION':
        return res.status(403).json({
          code: 'META_PERMISSION_DENIED',
          message: 'Meta denied access. Make sure every requested permission was granted and that you can access this Page and its leads.',
        });
      case 'RATE_LIMIT':
        return res.status(429).json({
          code: 'META_RATE_LIMITED',
          message: 'Meta rate limit reached. Please try again in a few minutes.',
        });
      case 'INVALID_REQUEST':
        return res.status(404).json({
          code: 'META_NOT_AVAILABLE',
          message: 'The requested Facebook Page or lead form is not available on Meta.',
        });
      default:
        return res.status(502).json({
          code: 'META_UNAVAILABLE',
          message: 'Meta is temporarily unavailable. Please try again.',
        });
    }
  }

  logMetaError('META_INTERNAL_ERROR', { reason: error.name });
  return res.status(500).json({ message: fallbackMessage });
};

// Values the admin needs to copy into the Meta app. Never includes the App Secret.
const buildSetupInfo = () => {
  const config = getMetaConfig();
  const apiBaseUrl = config.redirectUri.endsWith(OAUTH_CALLBACK_PATH)
    ? config.redirectUri.slice(0, -OAUTH_CALLBACK_PATH.length)
    : '';

  return {
    // 'database' = entered on this page, 'env' = fixed in the server environment, null = not set up yet
    source: config.source,
    appId: config.appId,
    redirectUri: config.redirectUri,
    webhookCallbackUrl: apiBaseUrl ? `${apiBaseUrl}${WEBHOOK_PATH}` : '',
    // A verify token that comes from the server environment is not shown
    webhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN ? '' : config.webhookVerifyToken,
  };
};

// Forget the Facebook connection (tokens, Pages, forms). Collected leads and app settings are kept.
const resetConnection = (integration) => {
  integration.connected = false;
  integration.needsReconnect = false;
  integration.metaUserId = '';
  integration.metaUserName = '';
  integration.grantedScopes = [];
  integration.pages = [];
  integration.selectedPageId = null;
  integration.forms = [];
  integration.webhookSubscribed = false;
};

// @desc    Save the Meta app (App ID + App Secret) entered by the admin
// @route   PUT /api/integrations/meta/app-settings
// @access  Private (admin, manager)
const saveMetaAppSettings = async (req, res) => {
  if (isMetaAppFromEnv()) {
    return res.status(409).json({ message: 'The Meta app is set in the server environment and cannot be changed here' });
  }

  const body = req.body || {};
  const appId = toStringParam(body.appId);
  const appSecret = toStringParam(body.appSecret);
  const apiBaseUrl = toStringParam(body.apiBaseUrl).replace(/\/+$/, '');
  const frontendRedirectUrl = toStringParam(body.frontendRedirectUrl).split(/[?#]/)[0];

  if (!/^\d{5,25}$/.test(appId)) {
    return res.status(400).json({ message: 'Enter a valid Meta App ID (numbers only)' });
  }
  if (!/^[A-Za-z0-9]{16,128}$/.test(appSecret)) {
    return res.status(400).json({ message: 'Enter a valid Meta App Secret' });
  }
  if (!isValidUrl(apiBaseUrl) || !isValidUrl(frontendRedirectUrl)) {
    return res.status(400).json({ message: 'Invalid CRM address' });
  }

  try {
    // Ask Meta whether this App ID / App Secret pair is real before storing it
    try {
      await verifyAppCredentials(appId, appSecret);
    } catch (error) {
      if (error instanceof MetaGraphError && !error.retryable) {
        logMetaError('META_APP_SETTINGS_REJECTED', { userId: String(req.user._id), code: error.code });
        return res.status(400).json({
          message: 'Meta did not accept this App ID and App Secret. Copy both again from App settings > Basic.',
        });
      }
      throw error;
    }

    const integration = (await getIntegration()) || new MetaIntegration({ key: 'default' });
    const previous = integration.appSettings || {};

    // Tokens issued for another Meta app are useless with the new one
    if (previous.appId && previous.appId !== appId) {
      resetConnection(integration);
    }

    // Keep the existing verify token so a webhook already set up in Meta keeps working
    let verifyToken = generateOAuthState();
    if (previous.webhookVerifyTokenEncrypted) {
      try {
        verifyToken = decryptToken(previous.webhookVerifyTokenEncrypted);
      } catch (error) {
        // Unreadable with the current key - a new token is issued
      }
    }

    integration.appSettings = {
      appId,
      appSecretEncrypted: encryptToken(appSecret),
      webhookVerifyTokenEncrypted: encryptToken(verifyToken),
      apiBaseUrl,
      frontendRedirectUrl,
      configuredBy: req.user._id,
      configuredAt: new Date(),
    };
    await integration.save();
    await refreshMetaSettings();

    logMetaEvent('META_APP_SETTINGS_SAVED', { userId: String(req.user._id), appId });
    res.json({ message: 'Meta app settings saved', setup: buildSetupInfo() });
  } catch (error) {
    await sendMetaError(res, error, 'Server error saving Meta app settings');
  }
};

// @desc    Get Meta integration status
// @route   GET /api/integrations/meta/status
// @access  Private (admin, manager)
const getMetaStatus = async (req, res) => {
  try {
    const integration = await getIntegration();
    const connected = Boolean(integration && integration.connected);

    const [processed, pending, failed] = await Promise.all([
      MetaLead.countDocuments({ processingStatus: 'processed', isDeleted: false }),
      MetaLead.countDocuments({ processingStatus: { $in: ['pending', 'processing'] } }),
      MetaLead.countDocuments({ processingStatus: 'failed' }),
    ]);

    const selectedPage = connected
      ? integration.pages.find((p) => p.pageId === integration.selectedPageId)
      : null;
    const forms = connected ? integration.forms.map((f) => ({ formId: f.formId, formName: f.formName })) : [];

    res.json({
      configured: isMetaConfigured(),
      setup: buildSetupInfo(),
      webhookConfigured: isMetaWebhookConfigured(),
      connected,
      needsReconnect: connected && integration.needsReconnect,
      metaUserName: connected ? integration.metaUserName : '',
      selectedPage: selectedPage ? { pageId: selectedPage.pageId, pageName: selectedPage.pageName } : null,
      forms,
      receivingLeads: Boolean(
        connected && selectedPage && forms.length > 0 && integration.webhookSubscribed && !integration.needsReconnect
      ),
      connectedAt: connected ? integration.connectedAt : null,
      lastLeadReceivedAt: connected ? integration.lastLeadReceivedAt || null : null,
      leadCounts: { processed, pending, failed },
    });
  } catch (error) {
    await sendMetaError(res, error, 'Server error retrieving Meta integration status');
  }
};

// @desc    Start Meta OAuth - returns the Facebook Login URL to redirect the browser to
// @route   GET /api/integrations/meta/connect
// @access  Private (admin, manager)
const startMetaConnect = async (req, res) => {
  if (!isMetaConfigured()) {
    return res.status(503).json({ message: 'Enter your Meta App ID and App Secret first' });
  }

  try {
    const state = generateOAuthState();
    await MetaOAuthState.create({
      stateHash: sha256Hex(state),
      user: req.user._id,
      expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
    });

    logMetaEvent('META_OAUTH_STARTED', { userId: String(req.user._id) });
    res.json({ url: buildOAuthDialogUrl(state) });
  } catch (error) {
    await sendMetaError(res, error, 'Server error starting Meta connection');
  }
};

// @desc    Meta OAuth callback - exchanges the code, stores encrypted Page tokens, redirects to the frontend
// @route   GET /api/integrations/meta/callback
// @access  Public (browser redirect from Meta, validated with the single-use OAuth state)
const handleMetaCallback = async (req, res) => {
  if (!isMetaConfigured()) {
    return res.status(503).send('Meta integration is not configured.');
  }

  const fail = (reason, details = {}) => {
    logMetaError('META_OAUTH_FAILED', { reason, ...details });
    return redirectToFrontend(res, { meta: 'error', reason });
  };

  try {
    const state = toStringParam(req.query.state);
    const code = toStringParam(req.query.code);

    // The state is single-use: consume it before doing anything else
    const stateRecord = state
      ? await MetaOAuthState.findOneAndDelete({ stateHash: sha256Hex(state), expiresAt: { $gt: new Date() } })
      : null;

    if (req.query.error) {
      return fail('access_denied');
    }
    if (!stateRecord) {
      return fail('invalid_state');
    }
    if (!code) {
      return fail('missing_code');
    }

    // The user who started the flow must still be an active admin/manager
    const user = await User.findOne({ _id: stateRecord.user, isDeleted: false });
    if (!user || user.status !== 'active' || !META_ALLOWED_ROLES.includes(user.role)) {
      return fail('not_authorized');
    }
    const userId = String(user._id);

    const shortLivedToken = await exchangeCodeForToken(code);
    const userToken = await exchangeForLongLivedToken(shortLivedToken);

    const grantedScopes = await getGrantedPermissions(userToken);
    const missingScopes = META_OAUTH_SCOPES.filter((scope) => !grantedScopes.includes(scope));
    if (missingScopes.length > 0) {
      return fail('missing_permissions', { userId, missingScopes });
    }

    const metaUser = await getMetaUser(userToken);
    const pages = (await getUserPages(userToken)).filter((page) => page.id && page.access_token);
    if (pages.length === 0) {
      return fail('no_pages', { userId });
    }

    const integration = (await getIntegration()) || new MetaIntegration({ key: 'default' });
    const previousPageId = integration.selectedPageId;

    integration.connected = true;
    integration.needsReconnect = false;
    integration.metaUserId = String(metaUser.id);
    integration.metaUserName = metaUser.name || '';
    integration.grantedScopes = grantedScopes;
    integration.connectedBy = user._id;
    integration.connectedAt = new Date();
    // Only encrypted Page tokens are stored; the user token is discarded
    integration.pages = pages.map((page) => ({
      pageId: String(page.id),
      pageName: page.name || '',
      accessTokenEncrypted: encryptToken(page.access_token),
      tokenExpiresAt: null,
    }));

    // Keep the existing Page/form selection when the Page is still accessible
    const previousPage = pages.find((page) => String(page.id) === previousPageId);
    if (previousPage) {
      try {
        await subscribePageToLeadgen(previousPageId, previousPage.access_token);
        integration.webhookSubscribed = true;
      } catch (error) {
        integration.webhookSubscribed = false;
      }
    } else {
      integration.selectedPageId = null;
      integration.forms = [];
      integration.webhookSubscribed = false;
    }

    await integration.save();

    if (previousPage) {
      await requeueFailedLeads(previousPageId);
      kickMetaLeadWorker();
    }

    logMetaEvent('META_OAUTH_SUCCESS', { userId, pageCount: pages.length });
    return redirectToFrontend(res, { meta: 'connected' });
  } catch (error) {
    if (error instanceof MetaGraphError) {
      return fail(error.kind === 'RATE_LIMIT' ? 'rate_limited' : 'meta_api_error', {
        kind: error.kind,
        code: error.code,
        fbtraceId: error.fbtraceId,
      });
    }
    return fail('server_error', { error: error.name });
  }
};

// @desc    List the Facebook Pages available through the Meta connection
// @route   GET /api/integrations/meta/pages
// @access  Private (admin, manager)
const getMetaPages = async (req, res) => {
  try {
    const integration = await getIntegration();
    if (!integration || !integration.connected) {
      return res.status(409).json({ message: 'Meta is not connected' });
    }

    res.json(
      integration.pages.map((page) => ({
        pageId: page.pageId,
        pageName: page.pageName,
        selected: page.pageId === integration.selectedPageId,
      }))
    );
  } catch (error) {
    await sendMetaError(res, error, 'Server error retrieving Facebook Pages');
  }
};

// Resolve a Page ID from the request against the stored integration - never trust the ID on its own
const findConnectedPage = (integration, pageId) => {
  if (!integration || !integration.connected) return null;
  return integration.pages.find((page) => page.pageId === pageId) || null;
};

const fetchActiveForms = async (page) => {
  const forms = await getPageLeadForms(page.pageId, decryptToken(page.accessTokenEncrypted));
  return forms.filter((form) => form.id && !['ARCHIVED', 'DELETED'].includes(form.status));
};

// @desc    List the lead forms of a connected Facebook Page
// @route   GET /api/integrations/meta/pages/:pageId/forms
// @access  Private (admin, manager)
const getMetaPageForms = async (req, res) => {
  try {
    const integration = await getIntegration();
    const page = findConnectedPage(integration, req.params.pageId);
    if (!page) {
      return res.status(404).json({ message: 'Facebook Page not found in the Meta connection' });
    }

    const forms = await fetchActiveForms(page);
    const selectedFormIds =
      integration.selectedPageId === page.pageId ? integration.forms.map((f) => f.formId) : [];

    res.json(
      forms.map((form) => ({
        formId: String(form.id),
        formName: form.name || '',
        status: form.status || '',
        selected: selectedFormIds.includes(String(form.id)),
      }))
    );
  } catch (error) {
    await sendMetaError(res, error, 'Server error retrieving lead forms');
  }
};

// @desc    Connect the selected lead forms of a Page (subscribes the Page to leadgen webhooks)
// @route   POST /api/integrations/meta/pages/:pageId/forms
// @access  Private (admin, manager)
const connectMetaForms = async (req, res) => {
  const formIds = Array.isArray(req.body && req.body.formIds)
    ? [...new Set(req.body.formIds.map((id) => String(id).trim()))]
    : [];

  if (formIds.length === 0 || formIds.length > MAX_FORMS_PER_PAGE || !formIds.every((id) => /^\d+$/.test(id))) {
    return res.status(400).json({ message: 'Select at least one lead form' });
  }

  try {
    const integration = await getIntegration();
    const page = findConnectedPage(integration, req.params.pageId);
    if (!page) {
      return res.status(404).json({ message: 'Facebook Page not found in the Meta connection' });
    }

    // Every selected form must belong to this Page according to Meta
    const pageForms = await fetchActiveForms(page);
    const selectedForms = formIds.map((id) => pageForms.find((form) => String(form.id) === id));
    if (selectedForms.some((form) => !form)) {
      return res.status(400).json({ message: 'One or more selected lead forms do not belong to this Facebook Page' });
    }

    await subscribePageToLeadgen(page.pageId, decryptToken(page.accessTokenEncrypted));

    // Stop receiving leads from a previously selected Page (best effort)
    const previousPage = integration.pages.find(
      (p) => p.pageId === integration.selectedPageId && p.pageId !== page.pageId
    );
    if (previousPage) {
      await unsubscribePage(previousPage.pageId, decryptToken(previousPage.accessTokenEncrypted)).catch(() => {});
    }

    integration.selectedPageId = page.pageId;
    integration.forms = selectedForms.map((form) => ({ formId: String(form.id), formName: form.name || '' }));
    integration.webhookSubscribed = true;
    await integration.save();

    await requeueFailedLeads(page.pageId);
    kickMetaLeadWorker();

    const userId = String(req.user._id);
    logMetaEvent('META_PAGE_CONNECTED', { userId, pageId: page.pageId });
    logMetaEvent('META_FORM_CONNECTED', { userId, pageId: page.pageId, formIds });

    res.json({
      message: 'Meta lead forms connected successfully',
      selectedPage: { pageId: page.pageId, pageName: page.pageName },
      forms: integration.forms.map((f) => ({ formId: f.formId, formName: f.formName })),
    });
  } catch (error) {
    await sendMetaError(res, error, 'Server error connecting lead forms');
  }
};

// @desc    Disconnect Meta - removes stored tokens, collected leads are kept
// @route   DELETE /api/integrations/meta
// @access  Private (admin, manager)
const disconnectMeta = async (req, res) => {
  try {
    const integration = await getIntegration();
    if (!integration || !integration.connected) {
      return res.json({ message: 'Meta is not connected' });
    }

    // Stop webhook deliveries for the selected Page (best effort - the token may already be invalid)
    const selectedPage = integration.pages.find((p) => p.pageId === integration.selectedPageId);
    if (selectedPage) {
      try {
        await unsubscribePage(selectedPage.pageId, decryptToken(selectedPage.accessTokenEncrypted));
      } catch (error) {
        logMetaError('META_UNSUBSCRIBE_FAILED', { pageId: selectedPage.pageId });
      }
    }

    resetConnection(integration);
    await integration.save();

    logMetaEvent('META_DISCONNECTED', { userId: String(req.user._id) });
    res.json({ message: 'Meta disconnected successfully' });
  } catch (error) {
    await sendMetaError(res, error, 'Server error disconnecting Meta');
  }
};

// @desc    Get Meta leads (server-side pagination, search and filters)
// @route   GET /api/integrations/meta/leads?page=&limit=&search=&formId=&pageId=&from=&to=&assignedTo=&statusId=
// @access  Private (admin, manager)
const getMetaLeads = async (req, res) => {
  const page = Math.max(parseInt(toStringParam(req.query.page), 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(toStringParam(req.query.limit), 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const search = toStringParam(req.query.search).slice(0, MAX_SEARCH_LENGTH).toLowerCase();
  const formId = toStringParam(req.query.formId);
  const pageId = toStringParam(req.query.pageId);
  const from = toStringParam(req.query.from);
  const to = toStringParam(req.query.to);
  // 'unassigned', or a telecaller's user ID
  const assignedTo = toStringParam(req.query.assignedTo);
  // 'none' (assigned but not started), or a lead status ID
  const statusId = toStringParam(req.query.statusId);

  const filter = { processingStatus: 'processed', isDeleted: false };

  if ((assignedTo && assignedTo !== 'unassigned' && !mongoose.isValidObjectId(assignedTo)) ||
      (statusId && statusId !== 'none' && !mongoose.isValidObjectId(statusId))) {
    return res.status(400).json({ message: 'Invalid filter' });
  }
  if (assignedTo === 'unassigned') filter.assignedTo = { $exists: false };
  else if (assignedTo) filter.assignedTo = assignedTo;

  if (formId) filter.formId = formId;
  if (pageId) filter.pageId = pageId;
  if (search) filter.searchText = { $regex: escapeRegex(search) };

  if (from || to) {
    const fromDate = from ? new Date(from) : null;
    const toDate = to ? new Date(to) : null;
    if ((fromDate && Number.isNaN(fromDate.getTime())) || (toDate && Number.isNaN(toDate.getTime()))) {
      return res.status(400).json({ message: 'Invalid date filter' });
    }
    filter.leadCreatedAt = {};
    if (fromDate) filter.leadCreatedAt.$gte = fromDate;
    if (toDate) filter.leadCreatedAt.$lte = toDate;
  }

  try {
    // Assigned leads use the counsellor's status. Unassigned leads use the status an admin set directly.
    if (statusId) {
      const assignmentLeadIds = await MetaLeadAssignment.distinct('lead', {
        isActive: true,
        currentStatus: statusId === 'none' ? null : statusId,
      });
      const leadIds = statusId === 'none'
        ? assignmentLeadIds
        : assignmentLeadIds.concat(await MetaLead.distinct('_id', {
            processingStatus: 'processed',
            isDeleted: false,
            assignedTo: null,
            unassignedStatus: statusId,
          }));
      filter._id = { $in: leadIds };
    }

    const [leads, total] = await Promise.all([
      MetaLead.find(filter)
        .select('-rawData -searchText -processingStatus -attempts -nextAttemptAt -lockedAt -lastError -isDeleted -unassignedHistory')
        .populate('assignedTo', 'name email')
        .populate('unassignedStatus', 'name color')
        .sort({ leadCreatedAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      MetaLead.countDocuments(filter),
    ]);

    // Attach the current owner's status to each lead on this page
    const assignments = await MetaLeadAssignment.find({ lead: { $in: leads.map((lead) => lead._id) }, isActive: true })
      .select('lead currentStatus lastActivityAt')
      .populate('currentStatus', 'name color')
      .lean();
    const assignmentByLead = new Map(assignments.map((assignment) => [String(assignment.lead), assignment]));
    leads.forEach((lead) => {
      const assignment = assignmentByLead.get(String(lead._id));
      if (assignment) {
        lead.currentStatus = assignment.currentStatus || null;
        lead.lastActivityAt = assignment.lastActivityAt || null;
      } else {
        lead.currentStatus = lead.unassignedStatus || null;
        lead.lastActivityAt = lead.unassignedActivityAt || null;
      }
      delete lead.unassignedStatus;
      delete lead.unassignedActivityAt;
    });

    res.json({
      leads,
      page,
      limit,
      total,
      totalPages: Math.max(Math.ceil(total / limit), 1),
    });
  } catch (error) {
    await sendMetaError(res, error, 'Server error retrieving Meta leads');
  }
};

// @desc    Get the Pages and forms that have leads (for the lead list filters)
// @route   GET /api/integrations/meta/leads/filters
// @access  Private (admin, manager)
const getMetaLeadFilters = async (req, res) => {
  try {
    const groups = await MetaLead.aggregate([
      { $match: { processingStatus: 'processed', isDeleted: false } },
      {
        $group: {
          _id: { pageId: '$pageId', formId: '$formId' },
          pageName: { $last: '$pageName' },
          formName: { $last: '$formName' },
        },
      },
    ]);

    const pages = new Map();
    const forms = groups.map((group) => {
      pages.set(group._id.pageId, group.pageName || group._id.pageId);
      return {
        formId: group._id.formId,
        formName: group.formName || group._id.formId,
        pageId: group._id.pageId,
      };
    });

    res.json({
      pages: [...pages].map(([pageId, pageName]) => ({ pageId, pageName })),
      forms,
    });
  } catch (error) {
    await sendMetaError(res, error, 'Server error retrieving Meta lead filters');
  }
};

// @desc    Put leads that could not be retrieved from Meta back in the queue
// @route   POST /api/integrations/meta/leads/retry-failed
// @access  Private (admin, manager)
const retryFailedMetaLeads = async (req, res) => {
  try {
    const requeued = await requeueFailedLeads();
    kickMetaLeadWorker();
    res.json({ message: `${requeued} lead(s) queued for retry`, requeued });
  } catch (error) {
    await sendMetaError(res, error, 'Server error retrying Meta leads');
  }
};

module.exports = {
  saveMetaAppSettings,
  getMetaStatus,
  startMetaConnect,
  handleMetaCallback,
  getMetaPages,
  getMetaPageForms,
  connectMetaForms,
  disconnectMeta,
  getMetaLeads,
  getMetaLeadFilters,
  retryFailedMetaLeads,
};
