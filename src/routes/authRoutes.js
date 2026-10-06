const express = require('express');
const router = express.Router();
const { loginUser, getMe } = require('../controllers/authController');
const { protect } = require('../middleware/auth');

router.post('/login', loginUser);
router.get('/me', protect, getMe);

module.exports = router;
