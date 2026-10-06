const MetaIntegration = require('../models/MetaIntegration');
const { setStoredMetaSettings } = require('../config/meta');
const { decryptToken } = require('./metaCrypto');
const { logMetaError } = require('./metaLogger');

const OAUTH_CALLBACK_PATH = '/integrations/meta/callback';
const WEBHOOK_PATH = '/webhooks/meta';

// Load the Meta app settings saved through the CRM into the in-memory configuration.
// Called before every Meta request, so a change made on one server instance reaches the others.
const refreshMetaSettings = async () => {
  const integration = await MetaIntegration.findOne({ key: 'default' }).select('appSettings').lean();
  const saved = integration && integration.appSettings;

  if (!saved || !saved.appId || !saved.appSecretEncrypted) {
    setStoredMetaSettings(null);
    return;
  }

  try {
    setStoredMetaSettings({
      appId: saved.appId,
      appSecret: decryptToken(saved.appSecretEncrypted),
      webhookVerifyToken: saved.webhookVerifyTokenEncrypted ? decryptToken(saved.webhookVerifyTokenEncrypted) : '',
      redirectUri: saved.apiBaseUrl ? `${saved.apiBaseUrl}${OAUTH_CALLBACK_PATH}` : '',
      frontendRedirectUrl: saved.frontendRedirectUrl || '',
    });
  } catch (error) {
    // The encryption key changed (e.g. JWT_SECRET was rotated): the app settings must be entered again
    setStoredMetaSettings(null);
    logMetaError('META_SETTINGS_UNREADABLE', { reason: 'decrypt_failed' });
  }
};

// Express middleware version of refreshMetaSettings
const loadMetaSettings = async (req, res, next) => {
  try {
    await refreshMetaSettings();
    next();
  } catch (error) {
    logMetaError('META_SETTINGS_LOAD_FAILED', { reason: error.name });
    res.status(500).json({ message: 'Server error loading Meta settings' });
  }
};

module.exports = {
  OAUTH_CALLBACK_PATH,
  WEBHOOK_PATH,
  refreshMetaSettings,
  loadMetaSettings,
};
