const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  uploadPhoto,
  getRegistrationWindow,
  updateRegistrationWindow,
  getRegistrationForm,
  submitPublicApplication,
  submitTokenApplication,
} = require('../controllers/applicationController');

// The public form and counsellor links both use the token as their own access check.
router.get('/window', getRegistrationWindow);
router.put('/window', protect, authorize('admin'), updateRegistrationWindow);
router.get('/form/:token', getRegistrationForm);
router.post('/apply', uploadPhoto, submitPublicApplication);
router.post('/form/:token', uploadPhoto, submitTokenApplication);

module.exports = router;
