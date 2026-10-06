const express = require('express');
const router = express.Router();
const {
  createLead,
  getLeads,
  getLeadById,
  updateLead,
  addCallLog,
  assignLead,
} = require('../controllers/leadController');
const { protect, authorize } = require('../middleware/auth');
const { ROLES } = require('../utils/rbac');

router.use(protect);

const leadStaff = [ROLES.ADMIN, ROLES.MANAGER, ROLES.COUNSELLOR];

router.route('/')
  .post(authorize(...leadStaff), createLead)
  .get(authorize(...leadStaff), getLeads);

router.route('/:id')
  .get(authorize(...leadStaff), getLeadById)
  .put(authorize(...leadStaff), updateLead);

router.post('/:id/call-logs', authorize(...leadStaff), addCallLog);
router.put('/:id/assign', authorize(ROLES.ADMIN, ROLES.MANAGER), assignLead);

module.exports = router;
