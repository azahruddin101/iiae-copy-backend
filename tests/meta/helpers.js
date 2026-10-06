// Shared setup for the Meta integration tests.
// Tests run against a dedicated throwaway database - never against MONGO_URI.

const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.META_APP_ID = '1234567890';
process.env.META_APP_SECRET = 'test-app-secret';
process.env.META_REDIRECT_URI = 'https://api.example.test/api/integrations/meta/callback';
process.env.META_WEBHOOK_VERIFY_TOKEN = 'test-verify-token';
process.env.META_WEBHOOK_APP_SECRET = 'test-app-secret';
process.env.META_GRAPH_API_VERSION = 'v26.0';
process.env.META_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.META_FRONTEND_REDIRECT_URL = 'https://crm.example.test/dashboard/integrations/meta';

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const User = require('../../src/models/User');
const MetaIntegration = require('../../src/models/MetaIntegration');
const MetaLead = require('../../src/models/MetaLead');
const MetaOAuthState = require('../../src/models/MetaOAuthState');
const MetaSyncJob = require('../../src/models/MetaSyncJob');
const MetaLeadStatus = require('../../src/models/MetaLeadStatus');
const MetaLeadAssignment = require('../../src/models/MetaLeadAssignment');
const { encryptToken } = require('../../src/utils/metaCrypto');
const { META_OAUTH_SCOPES } = require('../../src/config/meta');

const TEST_MONGO_URI = process.env.TEST_MONGO_URI || 'mongodb://127.0.0.1:27017';
const TEST_DB_NAME = `innovbit_meta_test_${process.pid}`;

const realFetch = global.fetch;
let server;
let baseUrl;
let graphCalls = [];
let graphOverrides = {};

const graphError = (status, code, message = 'Graph error', extra = {}) => ({
  status,
  body: { error: { message, type: 'OAuthException', code, fbtrace_id: 'trace', ...extra } },
});

const SAMPLE_LEAD = {
  id: '5550001',
  created_time: '2026-09-20T10:15:00+0000',
  form_id: '9001',
  ad_id: '7001',
  ad_name: 'Admissions Ad',
  adset_id: '6001',
  adset_name: 'Delhi 18-24',
  campaign_id: '5001',
  campaign_name: 'Admissions 2026',
  is_organic: false,
  platform: 'fb',
  field_data: [
    { name: 'full_name', values: ['Riya Sharma'] },
    { name: 'email', values: ['riya@example.test'] },
    { name: 'phone_number', values: ['+919999900000'] },
    { name: 'which_course_interests_you?', values: ['AME'] },
  ],
};

// Default responses of the fake Graph API, keyed by "METHOD path"
const defaultGraphResponses = {
  'GET oauth/access_token': ({ params }) => ({
    body: { access_token: params.grant_type ? 'long-user-token' : 'short-user-token', token_type: 'bearer' },
  }),
  'GET me/permissions': () => ({
    body: { data: META_OAUTH_SCOPES.map((permission) => ({ permission, status: 'granted' })) },
  }),
  'GET me': () => ({ body: { id: '1001', name: 'Meta Admin' } }),
  'GET me/accounts': () => ({
    body: {
      data: [
        { id: '111', name: 'ABC Realty', access_token: 'page-token-111' },
        { id: '222', name: 'XYZ Properties', access_token: 'page-token-222' },
      ],
    },
  }),
  'GET 111/leadgen_forms': () => ({
    body: {
      data: [
        { id: '9001', name: 'Property Enquiry', status: 'ACTIVE' },
        { id: '9002', name: 'Site Visit', status: 'ACTIVE' },
        { id: '9003', name: 'Old Form', status: 'ARCHIVED' },
      ],
    },
  }),
  'GET 222/leadgen_forms': () => ({ body: { data: [{ id: '9101', name: 'Contact Form', status: 'ACTIVE' }] } }),
  'POST 111/subscribed_apps': () => ({ body: { success: true } }),
  'POST 222/subscribed_apps': () => ({ body: { success: true } }),
  'DELETE 111/subscribed_apps': () => ({ body: { success: true } }),
  'DELETE 222/subscribed_apps': () => ({ body: { success: true } }),
  'GET 5550001': () => ({ body: SAMPLE_LEAD }),
};

// Replace global fetch: Graph API calls are answered locally, everything else (the test server) passes through
const fakeFetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname !== 'graph.facebook.com') {
    return realFetch(input, options);
  }

  const method = options.method || 'GET';
  const path = url.pathname.replace(/^\/v\d+\.\d+\//, '');
  const params = Object.fromEntries(url.searchParams);
  if (options.body) Object.assign(params, Object.fromEntries(new URLSearchParams(options.body)));

  const key = `${method} ${path}`;
  graphCalls.push({ key, method, path, params });

  const handler = graphOverrides[key] || defaultGraphResponses[key];
  if (handler === 'NETWORK_ERROR') throw new TypeError('fetch failed');

  const { status = 200, body } = handler
    ? await handler({ method, path, params })
    : graphError(400, 100, 'Unsupported get request');

  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
};

// Mirrors how index.js wires the Meta routes
const buildApp = () => {
  const app = express();
  app.use('/api/webhooks/meta', require('../../src/routes/metaWebhookRoutes'));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ limit: '10mb', extended: true }));
  app.use('/api/integrations/meta', require('../../src/routes/metaRoutes'));
  app.use((err, req, res, next) => {
    res.status(500).json({ message: err.message || 'An internal server error occurred' });
  });
  return app;
};

const startTestApp = async () => {
  await mongoose.connect(TEST_MONGO_URI, { dbName: TEST_DB_NAME, serverSelectionTimeoutMS: 5000 });
  await Promise.all([User.init(), MetaIntegration.init(), MetaLead.init(), MetaOAuthState.init(), MetaSyncJob.init(), MetaLeadStatus.init(), MetaLeadAssignment.init()]);

  global.fetch = fakeFetch;
  await new Promise((resolve) => {
    server = buildApp().listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
};

const stopTestApp = async () => {
  global.fetch = realFetch;
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
};

const resetState = async () => {
  graphCalls = [];
  graphOverrides = {};
  await Promise.all([
    User.deleteMany({}),
    MetaIntegration.deleteMany({}),
    MetaLead.deleteMany({}),
    MetaOAuthState.deleteMany({}),
    MetaSyncJob.deleteMany({}),
    MetaLeadStatus.deleteMany({}),
    MetaLeadAssignment.deleteMany({}),
  ]);
};

const setGraphOverrides = (overrides) => {
  graphOverrides = overrides;
};

const getGraphCalls = (key) => (key ? graphCalls.filter((call) => call.key === key) : graphCalls);

let userCounter = 0;
const createUser = async (role = 'admin', overrides = {}) => {
  userCounter += 1;
  const user = await User.create({
    name: `Test ${role}`,
    email: `${role}${userCounter}@example.test`,
    phone: '9000000000',
    password: 'password123',
    role,
    ...overrides,
  });
  const token = jwt.sign(
    { id: user._id, tokenVersion: user.tokenVersion },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
  return { user, token };
};

// Call the test server. Redirects are never followed so OAuth redirects can be inspected.
const request = async (method, path, { token, body, headers = {}, rawBody } = {}) => {
  const options = { method, redirect: 'manual', headers: { ...headers } };
  if (token) options.headers.Authorization = `Bearer ${token}`;
  if (rawBody !== undefined) {
    options.body = rawBody;
    options.headers['Content-Type'] = options.headers['Content-Type'] || 'application/json';
  } else if (body !== undefined) {
    options.body = JSON.stringify(body);
    options.headers['Content-Type'] = 'application/json';
  }

  const response = await realFetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (error) {
    json = null;
  }
  return { status: response.status, text, json, location: response.headers.get('location') };
};

// A connected integration with Page 111 selected and form 9001 connected
const seedIntegration = (overrides = {}) =>
  MetaIntegration.create({
    key: 'default',
    connected: true,
    metaUserId: '1001',
    metaUserName: 'Meta Admin',
    pages: [
      { pageId: '111', pageName: 'ABC Realty', accessTokenEncrypted: encryptToken('page-token-111') },
      { pageId: '222', pageName: 'XYZ Properties', accessTokenEncrypted: encryptToken('page-token-222') },
    ],
    selectedPageId: '111',
    forms: [{ formId: '9001', formName: 'Property Enquiry' }],
    webhookSubscribed: true,
    connectedAt: new Date(),
    ...overrides,
  });

const signPayload = (rawBody, secret = process.env.META_WEBHOOK_APP_SECRET) =>
  `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;

const leadgenPayload = (overrides = {}) => ({
  object: 'page',
  entry: [
    {
      id: '111',
      time: 1790000000,
      changes: [
        {
          field: 'leadgen',
          value: {
            leadgen_id: '5550001',
            page_id: '111',
            form_id: '9001',
            ad_id: '7001',
            adgroup_id: '7001',
            created_time: 1790000000,
            ...overrides,
          },
        },
      ],
    },
  ],
});

const postWebhook = (payload, { signature } = {}) => {
  const rawBody = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const headers = {};
  const header = signature === undefined ? signPayload(rawBody) : signature;
  if (header) headers['X-Hub-Signature-256'] = header;
  return request('POST', '/api/webhooks/meta', { rawBody, headers });
};

module.exports = {
  SAMPLE_LEAD,
  graphError,
  startTestApp,
  stopTestApp,
  resetState,
  setGraphOverrides,
  getGraphCalls,
  createUser,
  request,
  seedIntegration,
  signPayload,
  leadgenPayload,
  postWebhook,
};
