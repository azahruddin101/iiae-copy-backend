const mongoose = require('mongoose');

const metaPageSchema = mongoose.Schema(
  {
    pageId: {
      type: String,
      required: true,
    },
    pageName: {
      type: String,
      default: '',
    },
    // AES-256-GCM encrypted Page access token - never returned by the API
    accessTokenEncrypted: {
      type: String,
      required: true,
    },
    // null = long-lived Page token with no expiry date
    tokenExpiresAt: {
      type: Date,
      default: null,
    },
  },
  { _id: false }
);

const metaFormSchema = mongoose.Schema(
  {
    formId: {
      type: String,
      required: true,
    },
    formName: {
      type: String,
      default: '',
    },
  },
  { _id: false }
);

// The CRM serves a single institute, so there is one Meta connection for the whole CRM
const metaIntegrationSchema = mongoose.Schema(
  {
    key: {
      type: String,
      default: 'default',
      unique: true,
    },
    // Meta app entered by an admin on the Integrations page (secrets are AES-256-GCM encrypted)
    appSettings: {
      appId: String,
      appSecretEncrypted: String,
      // Verify token the admin pastes into the Meta webhook configuration
      webhookVerifyTokenEncrypted: String,
      // Public base URL of this API, e.g. https://api.example.com/api
      apiBaseUrl: String,
      // CRM page the browser returns to after Facebook Login
      frontendRedirectUrl: String,
      configuredBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
      configuredAt: Date,
    },
    connected: {
      type: Boolean,
      default: false,
    },
    metaUserId: {
      type: String,
      default: '',
    },
    metaUserName: {
      type: String,
      default: '',
    },
    grantedScopes: [String],
    pages: [metaPageSchema],
    // Page whose leads are collected
    selectedPageId: {
      type: String,
      default: null,
    },
    // Lead forms (of the selected Page) whose leads are collected
    forms: [metaFormSchema],
    webhookSubscribed: {
      type: Boolean,
      default: false,
    },
    // Set when Meta rejects the stored token (expired, revoked, password changed)
    needsReconnect: {
      type: Boolean,
      default: false,
    },
    connectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    connectedAt: {
      type: Date,
    },
    lastLeadReceivedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Defence in depth: encrypted secrets never leave the server even if a document is serialized directly
metaIntegrationSchema.set('toJSON', {
  transform: (doc, ret) => {
    if (Array.isArray(ret.pages)) {
      ret.pages = ret.pages.map(({ accessTokenEncrypted, ...page }) => page);
    }
    if (ret.appSettings) {
      const { appSecretEncrypted, webhookVerifyTokenEncrypted, ...appSettings } = ret.appSettings;
      ret.appSettings = appSettings;
    }
    return ret;
  },
});

const MetaIntegration = mongoose.model('MetaIntegration', metaIntegrationSchema);

module.exports = MetaIntegration;
