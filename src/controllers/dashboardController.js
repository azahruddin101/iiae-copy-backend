const Lead = require('../models/Lead');
const User = require('../models/User');
const Course = require('../models/Course');
const Batch = require('../models/Batch');
const Payment = require('../models/Payment');
const StudentProfile = require('../models/StudentProfile');

// @desc    Get dashboard metrics based on user role
// @route   GET /api/dashboard
// @access  Private (All roles)
const getDashboardStats = async (req, res) => {
  const role = req.user.role;

  try {
    if (role === 'admin' || role === 'manager') {
      // 1. Lead metrics
      const totalLeads = await Lead.countDocuments({ isDeleted: false });
      
      const leadStatusCounts = await Lead.aggregate([
        { $match: { isDeleted: false } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]);
      
      const leadsByStatus = {
        interested: 0,
        not_interested: 0,
        callback: 0,
        not_picked: 0,
        not_eligible: 0,
        registered: 0,
      };
      leadStatusCounts.forEach((group) => {
        if (leadsByStatus[group._id] !== undefined) {
          leadsByStatus[group._id] = group.count;
        }
      });

      // 2. Student metrics
      const totalStudents = await User.countDocuments({ role: 'student', isDeleted: false });
      const activeStudents = await User.countDocuments({ role: 'student', status: 'active', isDeleted: false });

      // 3. Batches and Courses
      const totalCourses = await Course.countDocuments({ isDeleted: false });
      const totalBatches = await Batch.countDocuments({ isDeleted: false });

      // 4. Financial metrics
      const paymentStats = await Payment.aggregate([
        { $match: { isDeleted: false } },
        { $group: { _id: null, totalCollected: { $sum: '$amount' } } },
      ]);
      const totalCollected = paymentStats[0]?.totalCollected || 0;

      const profileStats = await StudentProfile.aggregate([
        { $match: { isDeleted: false } },
        {
          $group: {
            _id: null,
            totalNetFees: { $sum: '$feeDetails.netFee' },
            totalPaidFees: { $sum: '$feeDetails.paidFee' },
          },
        },
      ]);
      const totalNetFees = profileStats[0]?.totalNetFees || 0;
      const totalPendingFees = Math.max(0, totalNetFees - totalCollected);

      return res.json({
        leads: {
          total: totalLeads,
          ...leadsByStatus,
        },
        students: {
          total: totalStudents,
          active: activeStudents,
        },
        academics: {
          courses: totalCourses,
          batches: totalBatches,
        },
        finance: {
          totalCollected,
          totalPendingFees,
        },
      });
    }

    if (role === 'counsellor') {
      const totalLeads = await Lead.countDocuments({ assignedTo: req.user._id, isDeleted: false });
      
      const leadStatusCounts = await Lead.aggregate([
        { $match: { assignedTo: req.user._id, isDeleted: false } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]);

      const leadsByStatus = {
        interested: 0,
        not_interested: 0,
        callback: 0,
        not_picked: 0,
        not_eligible: 0,
        registered: 0,
      };
      leadStatusCounts.forEach((group) => {
        if (leadsByStatus[group._id] !== undefined) {
          leadsByStatus[group._id] = group.count;
        }
      });

      return res.json({
        leads: {
          total: totalLeads,
          ...leadsByStatus,
        },
      });
    }

    if (role === 'accountant') {
      const totalPayments = await Payment.countDocuments({ isDeleted: false });
      
      const paymentStats = await Payment.aggregate([
        { $match: { isDeleted: false } },
        { $group: { _id: null, totalCollected: { $sum: '$amount' } } },
      ]);
      const totalCollected = paymentStats[0]?.totalCollected || 0;

      const profileStats = await StudentProfile.aggregate([
        { $match: { isDeleted: false } },
        {
          $group: {
            _id: null,
            totalNetFees: { $sum: '$feeDetails.netFee' },
            totalPaidFees: { $sum: '$feeDetails.paidFee' },
          },
        },
      ]);
      const totalNetFees = profileStats[0]?.totalNetFees || 0;
      const totalPending = Math.max(0, totalNetFees - totalCollected);

      // Fetch recent 5 payments
      const recentPayments = await Payment.find({ isDeleted: false })
        .populate('student', 'name email')
        .sort({ date: -1 })
        .limit(5);

      return res.json({
        finance: {
          totalCollected,
          totalPendingFees: totalPending,
          totalPaymentsCount: totalPayments,
        },
        recentPayments,
      });
    }

    if (role === 'teacher') {
      // Find batches assigned to this teacher
      const batches = await Batch.find({ teacher: req.user._id, isDeleted: false });
      const batchIds = batches.map(b => b._id);
      
      // Count total students in these batches
      const studentsCount = batches.reduce((sum, batch) => sum + (batch.students?.length || 0), 0);

      return res.json({
        academics: {
          batchesCount: batches.length,
          studentsCount,
        },
        batches: batches.map(b => ({
          _id: b._id,
          name: b.name,
          studentsCount: b.students?.length || 0,
          schedule: b.schedule,
        })),
      });
    }

    if (role === 'student') {
      const profile = await StudentProfile.findOne({ user: req.user._id, isDeleted: false })
        .populate('course', 'name code')
        .populate('batch', 'name schedule teacher');

      let teacherName = 'Not Assigned';
      if (profile?.batch?.teacher) {
        const teacher = await User.findById(profile.batch.teacher);
        teacherName = teacher ? teacher.name : 'Not Assigned';
      }

      return res.json({
        profile: {
          studentId: profile?.studentId || 'Pending Allocation',
          courseName: profile?.course?.name || 'Not Enrolled',
          batchName: profile?.batch?.name || 'Not Assigned',
          batchSchedule: profile?.batch?.schedule || 'N/A',
          teacherName,
          entranceStatus: profile?.entranceStatus || 'pending',
          entranceScore: profile?.entranceScore || 0,
        },
        finance: {
          totalFee: profile?.feeDetails?.totalFee || 0,
          scholarship: profile?.feeDetails?.scholarshipAmount || 0,
          netFee: profile?.feeDetails?.netFee || 0,
          paidFee: profile?.feeDetails?.paidFee || 0,
          pendingBalance: Math.max(0, (profile?.feeDetails?.netFee || 0) - (profile?.feeDetails?.paidFee || 0)),
        },
      });
    }

    res.status(400).json({ message: 'Unknown User Role' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getDashboardStats,
};
