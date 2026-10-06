const express = require('express');
const router = express.Router();
const CRMSetting = require('../models/CRMSetting');
const { protect, authorize } = require('../middleware/auth');

// @desc    Get global CRM settings
// @route   GET /api/settings
// @access  Public (Authenticated users)
router.get('/', protect, async (req, res) => {
  try {
    let settings = await CRMSetting.findOne();
    if (!settings) {
      // Create default settings if not exists
      settings = await CRMSetting.create({
        admitCardEnabled: false,
        resultEnabled: false,
        counsellingLetterEnabled: false
      });
    }
    res.json(settings);
  } catch (error) {
    res.status(500).json({ message: 'Server error retrieving settings' });
  }
});

// @desc    Update CRM settings
// @route   PUT /api/settings
// @access  Private (Admin/Manager only)
router.put('/', protect, authorize('admin', 'manager'), async (req, res) => {
  const { admitCardEnabled, resultEnabled, counsellingLetterEnabled } = req.body;

  try {
    let settings = await CRMSetting.findOne();
    if (!settings) {
      settings = new CRMSetting();
    }

    if (admitCardEnabled !== undefined) settings.admitCardEnabled = admitCardEnabled;
    if (resultEnabled !== undefined) settings.resultEnabled = resultEnabled;
    if (counsellingLetterEnabled !== undefined) settings.counsellingLetterEnabled = counsellingLetterEnabled;

    await settings.save();
    res.json(settings);
  } catch (error) {
    res.status(500).json({ message: 'Server error updating settings' });
  }
});

module.exports = router;
