const express = require('express');
const router = express.Router();
const { verifyMetaWebhook, receiveMetaWebhook } = require('../controllers/metaWebhookController');
const { loadMetaSettings } = require('../utils/metaSettings');

// Meta webhook verification handshake
router.get('/', loadMetaSettings, verifyMetaWebhook);

// Event notifications - parsed as a raw Buffer so the X-Hub-Signature-256 header can be verified
router.post('/', express.raw({ type: () => true, limit: '1mb' }), loadMetaSettings, receiveMetaWebhook);

module.exports = router;
