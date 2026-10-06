const express = require('express');
const router = express.Router();
const {
  createAnnouncement,
  getAnnouncements,
  deleteAnnouncement,
} = require('../controllers/announcementController');
const { protect, authorize } = require('../middleware/auth');

router.use(protect);

router.route('/')
  .post(authorize('admin', 'manager'), createAnnouncement)
  .get(getAnnouncements);

router.route('/:id')
  .delete(authorize('admin', 'manager'), deleteAnnouncement);

module.exports = router;
