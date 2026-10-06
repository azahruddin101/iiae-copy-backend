// Meta (Facebook) Lead Ads integration configuration.
//
// The Meta app (App ID + App Secret) is normally entered by an admin on the CRM's
// Integrations page and stored encrypted in MongoDB. The META_* environment variables
// are optional and, when set, take precedence over what is stored in the database.

const DEFAULT_GRAPH_API_VERSION = 'v26.0';

// Permissions requested during Facebook Login (the OAuth `scope` parameter).
//
// This is exactly the permission set of the Meta app use case
// "Capture & manage ad leads with Marketing API" (verified against Meta's docs, Graph API v26.0).
// Meta rejects the login with "Invalid Scopes" for any permission that has not been added to
// the app under that use case, so the app must have the use case and every permission below.
// With Standard Access they can be granted by people who have a role on the Meta app;
// serving anyone else needs Advanced Access (App Review + Business Verification).
const META_OAUTH_SCOPES = [
  // Required by the use case
  'pages_show_list', // list the Pages the user manages
  'pages_read_engagement', // read Page data (dependency of the permissions below)
  'pages_manage_ads', // dependency of leads_retrieval
  'leads_retrieval', // read lead form answers
  'ads_management', // dependency of leads_retrieval; campaign / ad set / ad fields on a lead
  'ads_read', // dependency of leads_retrieval
  'business_management', // dependency of leads_retrieval; Pages owned by a business portfolio
  // Optional in the use case - has to be added in the Meta app with the "Add" button
  'pages_manage_metadata', // subscribe the Page to leadgen webhooks
];

// CRM roles allowed to manage the Meta integration and view Meta leads
const META_ALLOWED_ROLES = ['admin', 'manager'];

// Settings saved through the CRM (already decrypted). Kept in memory and refreshed
// from MongoDB by utils/metaSettings.js before each Meta request.
let storedSettings = null;

const setStoredMetaSettings = (settings) => {
  storedSettings = settings || null;
};

const normalizeVersion = (value) => {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (/^v\d+\.\d+$/.test(trimmed)) return trimmed;
  if (/^\d+\.\d+$/.test(trimmed)) return `v${trimmed}`;
  return null;
};

// True when the Meta app is supplied through the server environment instead of the CRM
const isMetaAppFromEnv = () => Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET);

const getMetaConfig = () => {
  const stored = storedSettings || {};
  const fromEnv = isMetaAppFromEnv();
  const appSecret = fromEnv ? process.env.META_APP_SECRET : stored.appSecret || '';

  return {
    // 'env' | 'database' | null (not set up yet)
    source: fromEnv ? 'env' : stored.appId && stored.appSecret ? 'database' : null,
    appId: fromEnv ? process.env.META_APP_ID : stored.appId || '',
    appSecret,
    redirectUri: process.env.META_REDIRECT_URI || stored.redirectUri || '',
    webhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || stored.webhookVerifyToken || '',
    // The webhook payload is signed with the app secret; allow an explicit override
    webhookAppSecret: process.env.META_WEBHOOK_APP_SECRET || appSecret,
    graphApiVersion: normalizeVersion(process.env.META_GRAPH_API_VERSION) || DEFAULT_GRAPH_API_VERSION,
    // Optional dedicated key for encrypting stored secrets (falls back to a key derived from JWT_SECRET)
    tokenEncryptionKey: process.env.META_TOKEN_ENCRYPTION_KEY || '',
    // Frontend page the user is sent back to after the OAuth callback
    frontendRedirectUrl: process.env.META_FRONTEND_REDIRECT_URL || stored.frontendRedirectUrl || '',
  };
};

const isValidUrl = (value) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch (error) {
    return false;
  }
};

// Everything needed to run the OAuth flow and call the Graph API
const isMetaConfigured = () => {
  const config = getMetaConfig();
  return Boolean(
    config.appId &&
      config.appSecret &&
      (config.tokenEncryptionKey || process.env.JWT_SECRET) &&
      isValidUrl(config.redirectUri) &&
      isValidUrl(config.frontendRedirectUrl)
  );
};

// Everything needed to verify and accept webhooks
const isMetaWebhookConfigured = () => {
  const config = getMetaConfig();
  return Boolean(config.webhookVerifyToken && config.webhookAppSecret);
};

module.exports = {
  DEFAULT_GRAPH_API_VERSION,
  META_OAUTH_SCOPES,
  META_ALLOWED_ROLES,
  setStoredMetaSettings,
  isMetaAppFromEnv,
  getMetaConfig,
  isValidUrl,
  isMetaConfigured,
  isMetaWebhookConfigured,
};
