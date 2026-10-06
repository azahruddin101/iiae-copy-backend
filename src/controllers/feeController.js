const Payment = require('../models/Payment');
const StudentProfile = require('../models/StudentProfile');
const User = require('../models/User');

// Helper to generate a unique receipt number
// e.g. REC-2026-0001
const generateReceiptNumber = async () => {
  const currentYear = new Date().getFullYear();
  const prefix = `REC/${currentYear}/`;
  
  const count = await Payment.countDocuments({
    receiptNumber: new RegExp(`^REC/${currentYear}/`)
  });
  
  const sequenceNum = String(count + 1).padStart(4, '0');
  return `${prefix}${sequenceNum}`;
};

// @desc    Record student fee payment
// @route   POST /api/payments
// @access  Private (Admin, Accountant)
const recordPayment = async (req, res) => {
  const { studentId, amount, mode, remarks } = req.body;

  if (!studentId || !amount) {
    return res.status(400).json({ message: 'Student ID and amount are required' });
  }

  try {
    const studentUser = await User.findOne({ _id: studentId, role: 'student', isDeleted: false });
    if (!studentUser) {
      return res.status(404).json({ message: 'Student user not found' });
    }

    const profile = await StudentProfile.findOne({ user: studentId, isDeleted: false });
    if (!profile) {
      return res.status(404).json({ message: 'Student profile not found' });
    }

    const receiptNumber = await generateReceiptNumber();

    const payment = await Payment.create({
      student: studentId,
      receiptNumber,
      amount: Number(amount),
      mode: mode || 'cash',
      remarks: remarks || '',
      receivedBy: req.user._id,
    });

    // Update paid fee in Student Profile
    profile.feeDetails.paidFee += Number(amount);
    await profile.save();

    const populatedPayment = await Payment.findById(payment._id)
      .populate('student', 'name email phone')
      .populate('receivedBy', 'name email');

    res.status(201).json(populatedPayment);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all payments
// @route   GET /api/payments
// @access  Private (Admin, Accountant, Student)
const getPayments = async (req, res) => {
  const filter = { isDeleted: false };

  // If role is student, only show their payments
  if (req.user.role === 'student') {
    filter.student = req.user._id;
  }

  try {
    const payments = await Payment.find(filter)
      .populate('student', 'name email phone')
      .populate('receivedBy', 'name')
      .sort({ createdAt: -1 });

    res.json(payments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get payment by ID (Receipt Details)
// @route   GET /api/payments/:id
// @access  Private (Admin, Accountant, Student)
const getPaymentById = async (req, res) => {
  try {
    const payment = await Payment.findOne({ _id: req.params.id, isDeleted: false })
      .populate('student', 'name email phone')
      .populate('receivedBy', 'name');

    if (!payment) {
      return res.status(404).json({ message: 'Payment receipt not found' });
    }

    // Verify student is only reading their own receipt
    if (req.user.role === 'student' && payment.student._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied' });
    }

    res.json(payment);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get student fee ledger summary
// @route   GET /api/payments/ledger/:studentId
// @access  Private (Admin, Accountant, Student)
const getStudentFeeLedger = async (req, res) => {
  const targetStudentId = req.params.studentId === 'me' ? req.user._id : req.params.studentId;

  if (req.user.role === 'student' && req.user._id.toString() !== targetStudentId.toString()) {
    return res.status(403).json({ message: 'Access denied' });
  }

  try {
    const profile = await StudentProfile.findOne({ user: targetStudentId, isDeleted: false })
      .populate('course', 'name code baseFees')
      .populate('batch', 'name');

    if (!profile) {
      return res.status(404).json({ message: 'Student profile not found' });
    }

    const payments = await Payment.find({ student: targetStudentId, isDeleted: false })
      .populate('receivedBy', 'name')
      .sort({ date: -1 });

    const totalFee = profile.feeDetails.totalFee || 0;
    const scholarship = profile.feeDetails.scholarshipAmount || 0;
    const netFee = profile.feeDetails.netFee || (totalFee - scholarship);
    const paidFee = profile.feeDetails.paidFee || 0;
    const pendingBalance = Math.max(0, netFee - paidFee);

    res.json({
      student: {
        id: profile.user,
        studentId: profile.studentId,
        course: profile.course,
        batch: profile.batch,
      },
      feeDetails: {
        totalFee,
        scholarshipAmount: scholarship,
        netFee,
        paidFee,
        pendingBalance,
        discountRemarks: profile.feeDetails.discountRemarks,
      },
      payments,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  recordPayment,
  getPayments,
  getPaymentById,
  getStudentFeeLedger,
};
