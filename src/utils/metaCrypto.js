const crypto = require('crypto');
const { getMetaConfig } = require('../config/meta');

const TOKEN_PREFIX = 'v1';

// Key used to encrypt Meta secrets at rest.
// Uses META_TOKEN_ENCRYPTION_KEY when set (32 bytes, as 64 hex chars or base64); otherwise a
// key derived from the application's JWT_SECRET, so no extra server configuration is needed.
const getEncryptionKey = () => {
  const raw = getMetaConfig().tokenEncryptionKey;
  if (!raw) {
    if (!process.env.JWT_SECRET) {
      throw new Error('No encryption key available for Meta secrets');
    }
    return Buffer.from(crypto.hkdfSync('sha256', process.env.JWT_SECRET, 'innovbit-crm', 'meta-token-encryption', 32));
  }

  let key;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    key = Buffer.from(raw, 'base64');
  }

  if (key.length !== 32) {
    throw new Error('META_TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex characters or base64)');
  }
  return key;
};

// Encrypt a Meta access token for storage (AES-256-GCM)
const encryptToken = (plainText) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    TOKEN_PREFIX,
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
};

const decryptToken = (payload) => {
  const parts = String(payload || '').split('.');
  if (parts.length !== 4 || parts[0] !== TOKEN_PREFIX) {
    throw new Error('Stored Meta token has an unknown format');
  }

  const [, iv, tag, encrypted] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
};

const sha256Hex = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const generateOAuthState = () => crypto.randomBytes(32).toString('base64url');

// Constant-time string comparison
const safeEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
};

// appsecret_proof sent with Graph API calls made from the server
const createAppSecretProof = (accessToken, appSecret) =>
  crypto.createHmac('sha256', appSecret).update(accessToken).digest('hex');

// Validate the X-Hub-Signature-256 header against the raw request body
const verifyWebhookSignature = (rawBody, signatureHeader, appSecret) => {
  if (!appSecret || !Buffer.isBuffer(rawBody) || typeof signatureHeader !== 'string') {
    return false;
  }

  const [algorithm, signature] = signatureHeader.split('=');
  if (algorithm !== 'sha256' || !signature) return false;

  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return safeEqual(signature.toLowerCase(), expected);
};

module.exports = {
  encryptToken,
  decryptToken,
  sha256Hex,
  generateOAuthState,
  safeEqual,
  createAppSecretProof,
  verifyWebhookSignature,
};
