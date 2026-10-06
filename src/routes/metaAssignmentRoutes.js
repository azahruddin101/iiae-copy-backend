const express = require('express');
const router = express.Router();
const {
  getLeadStatuses,
  createLeadStatus,
  updateLeadStatus,
  reorderLeadStatuses,
  deleteLeadStatus,
  assignMetaLeads,
  getMetaLeadAssignments,
  getTelecallerReport,
  getMyMetaLeads,
  updateMyMetaLeadStatus,
  updateMetaLeadStatus,
} = require('../controllers/metaAssignmentController');
const { protect, authorize } = require('../middleware/auth');
const { META_ALLOWED_ROLES } = require('../config/meta');
const { ROLES } = require('../utils/rbac');

// Meta lead pipeline: statuses, assignment to telecallers, telecaller work and the performance report.
// Mounted under /api/integrations/meta (see metaRoutes.js).

const managers = [protect, authorize(...META_ALLOWED_ROLES)];
const counsellors = [protect, authorize(ROLES.COUNSELLOR)];

// Lead statuses - managed by admin/manager, readable by counsellors
router.get('/lead-statuses', protect, authorize(...META_ALLOWED_ROLES, ROLES.COUNSELLOR), getLeadStatuses);
router.post('/lead-statuses', managers, createLeadStatus);
router.put('/lead-statuses/reorder', managers, reorderLeadStatuses);
router.put('/lead-statuses/:id', managers, updateLeadStatus);
router.delete('/lead-statuses/:id', managers, deleteLeadStatus);

// Assignment and reporting
router.post('/leads/assign', managers, assignMetaLeads);
router.get('/leads/:id/assignments', managers, getMetaLeadAssignments);
router.put('/leads/:id/status', managers, updateMetaLeadStatus);
router.get('/reports/telecallers', managers, getTelecallerReport);

// Telecaller's own leads
router.get('/my-leads', counsellors, getMyMetaLeads);
router.put('/my-leads/:id/status', counsellors, updateMyMetaLeadStatus);

module.exports = router;
