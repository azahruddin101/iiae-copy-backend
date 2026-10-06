const mongoose = require('mongoose');
const Lead = require('../models/Lead');
const Course = require('../models/Course');
const User = require('../models/User');
const { ROLES } = require('../utils/rbac');
const { applyRegistrationChoice, assertRegistrationFormOpen } = require('./registrationController');

const sendLeadError = (res, error) => {
  if (error.statusCode) {
    res.status(error.statusCode).json({ message: error.message });
    return true;
  }
  return false;
};

// @desc    Create a new lead/query
// @route   POST /api/leads
// @access  Private (admin, manager, telecaller)
const createLead = async (req, res) => {
  const { name, email, phone, courseId, remark } = req.body;

  try {
    const course = await Course.findById(courseId);
    if (!course) {
      return res.status(404).json({ message: 'Course not found' });
    }

    const leadData = {
      name,
      email,
      phone,
      course: courseId,
      status: 'interested',
    };

    // If caller is telecaller, auto-assign to them
    if (req.user.role === ROLES.COUNSELLOR) {
      leadData.assignedTo = req.user._id;
    }

    // Add initial call log if remark is provided
    if (remark) {
      leadData.callLogs = [
        {
          remark,
          date: new Date(),
          caller: req.user.name,
        },
      ];
    }

    const lead = await Lead.create(leadData);
    
    const populatedLead = await Lead.findById(lead._id)
      .populate('course', 'name code')
      .populate('assignedTo', 'name email');

    res.status(201).json(populatedLead);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all leads
// @route   GET /api/leads
// @access  Private (admin, manager, telecaller)
const getLeads = async (req, res) => {
  const filter = { isDeleted: false };

  // If user is a telecaller, only show their assigned leads
  if (req.user.role === ROLES.COUNSELLOR) {
    filter.assignedTo = req.user._id;
  }

  try {
    const leads = await Lead.find(filter)
      .populate('course', 'name code')
      .populate('assignedTo', 'name email')
      .sort({ createdAt: -1 });

    res.json(leads);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get lead by ID
// @route   GET /api/leads/:id
// @access  Private (admin, manager, telecaller)
const getLeadById = async (req, res) => {
  try {
    const lead = await Lead.findOne({ _id: req.params.id, isDeleted: false })
      .populate('course', 'name code')
      .populate('assignedTo', 'name email');

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    // Enforce that telecallers can only view their own leads
    if (req.user.role === ROLES.COUNSELLOR && lead.assignedTo?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied to this lead record' });
    }

    res.json(lead);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update lead details (name, email, phone, status, course)
// @route   PUT /api/leads/:id
// @access  Private (admin, manager, telecaller)
const updateLead = async (req, res) => {
  const { name, email, phone, courseId, status } = req.body;

  try {
    const lead = await Lead.findOne({ _id: req.params.id, isDeleted: false });
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    // Telecaller permission check
    if (req.user.role === ROLES.COUNSELLOR && lead.assignedTo?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied to update this lead' });
    }

    if (courseId) {
      const course = await Course.findById(courseId);
      if (!course) {
        return res.status(404).json({ message: 'Course not found' });
      }
      lead.course = courseId;
    }

    lead.name = name !== undefined ? name : lead.name;
    lead.email = email !== undefined ? email : lead.email;
    lead.phone = phone !== undefined ? phone : lead.phone;
    if (status === 'registered' && !lead.formSubmittedAt) {
      await assertRegistrationFormOpen();
      applyRegistrationChoice(lead, req.body.registrationBy, req.user);
    } else if (status !== undefined) {
      lead.status = status;
    }

    await lead.save();

    const populatedLead = await Lead.findById(lead._id)
      .populate('course', 'name code')
      .populate('assignedTo', 'name email');

    res.json(populatedLead);
  } catch (error) {
    if (sendLeadError(res, error)) return;
    res.status(500).json({ message: error.message });
  }
};

// @desc    Add call log/follow-up remark to a lead
// @route   POST /api/leads/:id/call-logs
// @access  Private (admin, manager, telecaller)
const addCallLog = async (req, res) => {
  const { remark, status } = req.body;

  if (!remark) {
    return res.status(400).json({ message: 'Remark is required' });
  }

  try {
    const lead = await Lead.findOne({ _id: req.params.id, isDeleted: false });
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    // Telecaller permission check
    if (req.user.role === ROLES.COUNSELLOR && lead.assignedTo?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Append to call logs
    lead.callLogs.push({
      remark,
      date: new Date(),
      caller: req.user.name,
    });

    if (status === 'registered' && !lead.formSubmittedAt) {
      await assertRegistrationFormOpen();
      applyRegistrationChoice(lead, req.body.registrationBy, req.user);
    } else if (status) {
      lead.status = status;
    }

    await lead.save();

    const populatedLead = await Lead.findById(lead._id)
      .populate('course', 'name code')
      .populate('assignedTo', 'name email');

    res.json(populatedLead);
  } catch (error) {
    if (sendLeadError(res, error)) return;
    res.status(500).json({ message: error.message });
  }
};

// @desc    Assign lead to a counsellor
// @route   PUT /api/leads/:id/assign
// @access  Private (admin, manager)
const assignLead = async (req, res) => {
  const assigneeId = req.body.counsellorId !== undefined ? req.body.counsellorId : req.body.telecallerId;

  try {
    const lead = await Lead.findOne({ _id: req.params.id, isDeleted: false });
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    if (!assigneeId) {
      lead.assignedTo = null;
    } else {
      if (!mongoose.Types.ObjectId.isValid(assigneeId)) {
        return res.status(400).json({ message: 'Invalid counsellor' });
      }

      const counsellor = await User.findOne({
        _id: assigneeId,
        role: ROLES.COUNSELLOR,
        status: 'active',
        isDeleted: false,
      });
      if (!counsellor) {
        return res.status(404).json({ message: 'Counsellor not found or inactive' });
      }
      lead.assignedTo = counsellor._id;
    }

    await lead.save();

    const populatedLead = await Lead.findById(lead._id)
      .populate('course', 'name code')
      .populate('assignedTo', 'name email');

    res.json(populatedLead);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  createLead,
  getLeads,
  getLeadById,
  updateLead,
  addCallLog,
  assignLead,
};
