const Announcement = require('../models/Announcement');

// @desc    Create a new announcement
// @route   POST /api/announcements
// @access  Private (Admin, Manager)
const createAnnouncement = async (req, res) => {
  const { title, content, targetRoles } = req.body;

  try {
    const announcement = await Announcement.create({
      title,
      content,
      targetRoles: targetRoles || [],
      createdBy: req.user._id,
    });

    const populatedAnnouncement = await Announcement.findById(announcement._id)
      .populate('createdBy', 'name role');

    res.status(201).json(populatedAnnouncement);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all announcements
// @route   GET /api/announcements
// @access  Private (All authenticated users)
const getAnnouncements = async (req, res) => {
  const filter = { isDeleted: false };

  // For non-admin/non-manager roles, filter by targetRoles matching their role, or empty targetRoles (broadcast to all)
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    filter.$or = [
      { targetRoles: { $size: 0 } },
      { targetRoles: req.user.role },
    ];
  }

  try {
    const announcements = await Announcement.find(filter)
      .populate('createdBy', 'name role')
      .sort({ createdAt: -1 });

    res.json(announcements);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete an announcement (Soft delete)
// @route   DELETE /api/announcements/:id
// @access  Private (Admin, Manager)
const deleteAnnouncement = async (req, res) => {
  try {
    const announcement = await Announcement.findById(req.params.id);
    if (!announcement) {
      return res.status(404).json({ message: 'Announcement not found' });
    }

    announcement.isDeleted = true;
    await announcement.save();

    res.json({ message: 'Announcement deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  createAnnouncement,
  getAnnouncements,
  deleteAnnouncement,
};
