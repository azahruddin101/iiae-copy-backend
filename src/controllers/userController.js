const User = require('../models/User');
const StudentProfile = require('../models/StudentProfile');
const Course = require('../models/Course');
const {
  ROLES,
  assertCanCreateUser,
  assertCanUpdateUser,
  assertKeepsAnActiveAdmin,
  canReadUser,
  canListAllUsers,
} = require('../utils/rbac');

const MIN_PASSWORD_LENGTH = 8;

const sendKnownError = (res, error) => {
  if (error.statusCode) {
    res.status(error.statusCode).json({ message: error.message });
    return true;
  }
  return false;
};

// Helper to generate a unique Student ID (Roll Number)
// e.g. Innovbit/2026/0001
const generateStudentId = async () => {
  const currentYear = new Date().getFullYear();
  const prefix = `Innovbit/${currentYear}/`;
  
  // Find count of profiles created in current year
  const count = await StudentProfile.countDocuments({
    studentId: new RegExp(`^Innovbit/${currentYear}/`)
  });
  
  // Format to 4 digits: e.g. 0001
  const sequenceNum = String(count + 1).padStart(4, '0');
  return `${prefix}${sequenceNum}`;
};

// @desc    Create a new user
// @route   POST /api/users
// @access  Private/Admin (or Manager for students)
const createUser = async (req, res) => {
  const {
    name,
    email,
    phone,
    password,
    role,
    status,
    // Student specific fields
    courseId,
    fatherName,
    motherName,
    dob,
    gender,
    address,
    tenthPercentage,
    twelfthPercentage,
  } = req.body;

  try {
    assertCanCreateUser(req.user, role);

    if (!password || String(password).length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }

    // Check if email already exists
    const emailExists = await User.findOne({ email, isDeleted: false });
    if (emailExists) {
      return res.status(400).json({ message: 'User with this email already exists' });
    }

    // Create User
    const user = await User.create({
      name,
      email,
      phone,
      password,
      role,
      status: status || 'active',
    });

    // If role is Student, create StudentProfile
    if (role === 'student') {
      if (!courseId) {
        return res.status(400).json({ message: 'Course is required for student role' });
      }

      const course = await Course.findById(courseId);
      if (!course) {
        return res.status(404).json({ message: 'Course not found' });
      }

      const studentId = await generateStudentId();

      await StudentProfile.create({
        studentId,
        user: user._id,
        fatherName: fatherName || '',
        motherName: motherName || '',
        dob: dob ? new Date(dob) : null,
        gender: gender || 'Male',
        address: address || '',
        course: courseId,
        entranceStatus: 'pending',
        feeDetails: {
          totalFee: course.baseFees,
          scholarshipAmount: 0,
          netFee: course.baseFees,
          paidFee: 0,
        },
        academicDetails: {
          tenthPercentage: tenthPercentage || 0,
          twelfthPercentage: twelfthPercentage || 0,
        },
      });
    }

    // Return created user (exclude password)
    const createdUser = await User.findById(user._id).select('-password');
    res.status(201).json(createdUser);
  } catch (error) {
    if (sendKnownError(res, error)) return;
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all users
// @route   GET /api/users
// @access  Private (Admin, Manager, Accountant, Teacher)
const getUsers = async (req, res) => {
  const { role, status } = req.query;
  const filter = { isDeleted: false };

  if (!canListAllUsers(req.user)) {
    if (role && role !== ROLES.STUDENT) {
      return res.status(403).json({ message: 'You can only view student accounts' });
    }
    filter.role = ROLES.STUDENT;
  } else if (role) {
    filter.role = role;
  }
  if (status) filter.status = status;

  try {
    // If requesting students, we can populate their student profiles
    if (filter.role === ROLES.STUDENT) {
      const students = await User.find(filter).select('-password').lean();
      const studentIds = students.map(s => s._id);

      const profileFilter = { user: { $in: studentIds }, isDeleted: false };
      const registrationList = req.query.registrationFeePaid !== undefined;
      if (registrationList) {
        profileFilter.registrationFeePaid = req.query.registrationFeePaid === 'true';
        profileFilter.formSubmittedAt = { $ne: null };
      }
      if (req.user.role === ROLES.COUNSELLOR) {
        profileFilter.registeredBy = req.user._id;
        profileFilter.formSubmittedAt = { $ne: null };
      }

      const profiles = await StudentProfile.find(profileFilter)
        .populate('course', 'name code baseFees')
        .populate('batch', 'name schedule')
        .populate('registeredBy', 'name')
        .lean();

      // Map profiles to student users, skipping those filtered out
      const studentData = [];
      for (const student of students) {
        const profile = profiles.find(p => p.user.toString() === student._id.toString());
        if ((registrationList || req.user.role === ROLES.COUNSELLOR) && !profile) {
          continue;
        }
        studentData.push({
          ...student,
          profile: profile || null,
        });
      }

      return res.json(studentData);
    }

    const users = await User.find(filter).select('-password');
    res.json(users);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get user by ID
// @route   GET /api/users/:id
// @access  Private
const getUserById = async (req, res) => {
  try {
    const user = await User.findOne({ _id: req.params.id, isDeleted: false }).select('-password').lean();
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (req.user.role === ROLES.COUNSELLOR) {
      const ownsStudent = user.role === ROLES.STUDENT && await StudentProfile.exists({
        user: user._id,
        registeredBy: req.user._id,
        isDeleted: false,
        formSubmittedAt: { $ne: null },
      });
      if (!ownsStudent) {
        return res.status(403).json({ message: 'You can only view students you registered' });
      }
    } else if (!canReadUser(req.user, user)) {
      return res.status(403).json({ message: 'You are not allowed to view this account' });
    }

    if (user.role === 'student') {
      const profile = await StudentProfile.findOne({ user: user._id, isDeleted: false })
        .populate('course', 'name code baseFees')
        .populate('batch', 'name schedule')
        .lean();
      
      user.profile = profile || null;
    }

    res.json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update user details
// @route   PUT /api/users/:id
// @access  Private/Admin (or Manager for students)
const updateUser = async (req, res) => {
  const {
    name,
    email,
    phone,
    password,
    role,
    status,
    // Student specific fields
    courseId,
    batchId,
    fatherName,
    motherName,
    dob,
    gender,
    address,
    entranceStatus,
    entranceScore,
    scholarshipAmount,
    discountRemarks,
    tenthPercentage,
    twelfthPercentage,
  } = req.body;

  try {
    const user = await User.findOne({ _id: req.params.id, isDeleted: false });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (req.user.role === ROLES.COUNSELLOR) {
      if (user.role !== ROLES.STUDENT || req.body.registrationFeePaid === undefined) {
        return res.status(403).json({ message: 'You can only update the registration payment for students you registered' });
      }
      const profile = await StudentProfile.findOne({
        user: user._id,
        registeredBy: req.user._id,
        isDeleted: false,
        formSubmittedAt: { $ne: null },
      });
      if (!profile) {
        return res.status(403).json({ message: 'You can only update students you registered' });
      }
      profile.registrationFeePaid = Boolean(req.body.registrationFeePaid);
      await profile.save();
      const updatedUser = await User.findById(user._id).select('-password').lean();
      updatedUser.profile = await StudentProfile.findOne({ user: user._id, isDeleted: false })
        .populate('course', 'name code baseFees')
        .populate('registeredBy', 'name')
        .lean();
      return res.json(updatedUser);
    }

    if (password && String(password).length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }

    const nextRole = assertCanUpdateUser(req.user, user, { role, password, status, name, email, phone });
    const nextStatus = status || user.status;
    await assertKeepsAnActiveAdmin(User, user, { nextRole, nextStatus });

    const previousRole = user.role;
    const previousStatus = user.status;

    // Update basic user details
    user.name = name || user.name;
    user.email = email || user.email;
    user.phone = phone || user.phone;
    user.role = nextRole;
    user.status = nextStatus;

    if (password) {
      user.password = password;
    }

    const deactivated = user.status === 'inactive' && previousStatus !== 'inactive';
    if (password || user.role !== previousRole || deactivated) {
      user.tokenVersion += 1;
    }

    await user.save();

    // If role is student, update profile as well
    if (user.role === 'student') {
      const profile = await StudentProfile.findOne({ user: user._id, isDeleted: false });
      if (profile) {
        profile.fatherName = fatherName !== undefined ? fatherName : profile.fatherName;
        profile.motherName = motherName !== undefined ? motherName : profile.motherName;
        profile.dob = dob ? new Date(dob) : profile.dob;
        profile.gender = gender || profile.gender;
        profile.address = address !== undefined ? address : profile.address;
        profile.entranceStatus = entranceStatus || profile.entranceStatus;
        profile.entranceScore = entranceScore !== undefined ? entranceScore : profile.entranceScore;
        
        if (courseId) {
          const course = await Course.findById(courseId);
          if (course) {
            profile.course = courseId;
            profile.feeDetails.totalFee = course.baseFees;
          }
        }
        
        if (batchId !== undefined) {
          profile.batch = batchId || null;
        }

        if (scholarshipAmount !== undefined) {
          profile.feeDetails.scholarshipAmount = scholarshipAmount;
        }
        
        if (discountRemarks !== undefined) {
          profile.feeDetails.discountRemarks = discountRemarks;
        }

        if (req.body.registrationFeePaid !== undefined) {
          profile.registrationFeePaid = req.body.registrationFeePaid;
        }

        if (tenthPercentage !== undefined) profile.academicDetails.tenthPercentage = tenthPercentage;
        if (twelfthPercentage !== undefined) profile.academicDetails.twelfthPercentage = twelfthPercentage;

        await profile.save();
      } else if (courseId) {
        // Create profile if it didn't exist
        const studentId = await generateStudentId();
        const course = await Course.findById(courseId);
        await StudentProfile.create({
          studentId,
          user: user._id,
          fatherName: fatherName || '',
          motherName: motherName || '',
          dob: dob ? new Date(dob) : null,
          gender: gender || 'Male',
          address: address || '',
          course: courseId,
          entranceStatus: entranceStatus || 'pending',
          entranceScore: entranceScore || 0,
          feeDetails: {
            totalFee: course ? course.baseFees : 0,
            scholarshipAmount: scholarshipAmount || 0,
            netFee: course ? course.baseFees - (scholarshipAmount || 0) : 0,
            paidFee: 0,
          },
          academicDetails: {
            tenthPercentage: tenthPercentage || 0,
            twelfthPercentage: twelfthPercentage || 0,
          },
        });
      }
    }

    const updatedUser = await User.findById(user._id).select('-password').lean();
    if (updatedUser.role === 'student') {
      updatedUser.profile = await StudentProfile.findOne({ user: user._id, isDeleted: false })
        .populate('course', 'name code baseFees')
        .populate('batch', 'name schedule')
        .lean();
    }

    res.json(updatedUser);
  } catch (error) {
    if (sendKnownError(res, error)) return;
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete user (Soft delete)
// @route   DELETE /api/users/:id
// @access  Private/Admin
const deleteUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user || user.isDeleted) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (String(req.user._id) === String(user._id)) {
      return res.status(403).json({ message: 'You cannot delete your own account' });
    }

    await assertKeepsAnActiveAdmin(User, user, { deleting: true });

    user.isDeleted = true;
    user.status = 'inactive';
    user.tokenVersion += 1;
    await user.save();

    if (user.role === 'student') {
      const profile = await StudentProfile.findOne({ user: user._id });
      if (profile) {
        profile.isDeleted = true;
        await profile.save();
      }
    }

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    if (sendKnownError(res, error)) return;
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  createUser,
  getUsers,
  getUserById,
  updateUser,
  deleteUser,
};
