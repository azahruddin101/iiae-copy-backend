const express = require('express');
const router = express.Router();
const {
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
} = require('../controllers/metaController');
const { startMetaSync, getMetaSyncStatus } = require('../controllers/metaSyncController');
const { protect, authorize } = require('../middleware/auth');
const { META_ALLOWED_ROLES } = require('../config/meta');
const { loadMetaSettings } = require('../utils/metaSettings');

// OAuth callback is a browser redirect from Meta (no JWT) - it is validated with the single-use OAuth state
router.get('/callback', loadMetaSettings, handleMetaCallback);

// Lead pipeline (statuses, assignment, telecaller work, report) - has its own role checks because telecallers use it
router.use(require('./metaAssignmentRoutes'));

router.use(protect, authorize(...META_ALLOWED_ROLES), loadMetaSettings);

router.get('/status', getMetaStatus);
router.put('/app-settings', saveMetaAppSettings);
router.get('/connect', startMetaConnect);
router.get('/pages', getMetaPages);

router.route('/pages/:pageId/forms')
  .get(getMetaPageForms)
  .post(connectMetaForms);

router.get('/leads', getMetaLeads);
router.get('/leads/filters', getMetaLeadFilters);
router.post('/leads/retry-failed', retryFailedMetaLeads);

// Historical sync ("Sync Previous Leads")
router.post('/sync', startMetaSync);
router.get('/sync/status', getMetaSyncStatus);

router.delete('/', disconnectMeta);

module.exports = router;
