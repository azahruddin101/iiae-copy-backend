const express = require('express');
const router = express.Router();
const Newsletter = require('../models/Newsletter');
const { protect, authorize } = require('../middleware/auth');

// @desc    Get all newsletter subscribers
// @route   GET /api/newsletters
// @access  Private (Admin/Manager only)
router.get('/', protect, authorize('admin', 'manager'), async (req, res) => {
  try {
    const subscribers = await Newsletter.find().sort({ createdAt: -1 });
    res.json(subscribers);
  } catch (error) {
    res.status(500).json({ message: 'Server error retrieving subscribers' });
  }
});

// @desc    Subscribe to newsletter
// @route   POST /api/newsletters/subscribe
// @access  Public
router.post('/subscribe', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: 'Email address is required' });
  }

  try {
    let subscriber = await Newsletter.findOne({ email });
    if (subscriber) {
      if (!subscriber.active) {
        subscriber.active = true;
        await subscriber.save();
        return res.json({ message: 'Subscribed successfully' });
      }
      return res.status(400).json({ message: 'Already subscribed' });
    }

    await Newsletter.create({ email });
    res.status(201).json({ message: 'Subscribed successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error subscribing to newsletter' });
  }
});

// @desc    Simulate broadcast newsletter email
// @route   POST /api/newsletters/broadcast
// @access  Private (Admin/Manager only)
router.post('/broadcast', protect, authorize('admin', 'manager'), async (req, res) => {
  const { subject, body } = req.body;

  if (!subject || !body) {
    return res.status(400).json({ message: 'Subject and body are required for broadcast' });
  }

  try {
    const subscribers = await Newsletter.find({ active: true });
    
    // Simulate sending mail
    console.log(`Broadcasting Newsletter: \nSubject: ${subject} \nBody: ${body} \nTo ${subscribers.length} subscribers.`);

    res.json({
      message: 'Newsletter broadcast simulated successfully',
      sentCount: subscribers.length
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error broadcasting newsletter' });
  }
});

module.exports = router;
