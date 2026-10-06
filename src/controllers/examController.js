const Exam = require('../models/Exam');
const AdmitCard = require('../models/AdmitCard');
const StudentProfile = require('../models/StudentProfile');
const User = require('../models/User');
const Batch = require('../models/Batch');
const { ROLES } = require('../utils/rbac');

const studentIdOf = (student) => {
  if (!student) return '';
  return String(student._id || student);
};

const loadTeacherStudentIds = async (teacherId) => {
  const batches = await Batch.find({ teacher: teacherId, isDeleted: false }).select('students');
  const ids = new Set();
  batches.forEach((batch) => {
    (batch.students || []).forEach((studentId) => ids.add(String(studentId)));
  });
  return ids;
};

// @desc    Create a new exam (Entrance, Midterm, Final)
// @route   POST /api/exams
// @access  Private (Admin, Manager, Teacher)
const createExam = async (req, res) => {
  const { name, type, maxMarks, date } = req.body;

  try {
    const exam = await Exam.create({
      name,
      type,
      maxMarks,
      date: new Date(date),
      results: [],
    });

    res.status(201).json(exam);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all exams
// @route   GET /api/exams
// @access  Private (Admin, Manager, Teacher, Student)
const getExams = async (req, res) => {
  const filter = { isDeleted: false };

  try {
    // If student, only show exams where they are listed, or show general exams
    if (req.user.role === ROLES.STUDENT) {
      const exams = await Exam.find(filter)
        .select('-results') // Hide all student results
        .lean();
      
      // Fetch results specifically for this student
      const studentResults = await Exam.find({
        ...filter,
        'results.student': req.user._id,
      }).select('name type maxMarks date results.$').lean();

      const combinedExams = exams.map(exam => {
        const studentRes = studentResults.find(sr => sr._id.toString() === exam._id.toString());
        return {
          ...exam,
          myResult: studentRes ? studentRes.results[0] : null,
        };
      });

      return res.json(combinedExams);
    }

    const exams = await Exam.find(filter)
      .populate('results.student', 'name email phone')
      .sort({ date: -1 });

    if (req.user.role === ROLES.TEACHER) {
      const allowed = await loadTeacherStudentIds(req.user._id);
      return res.json(exams.map((exam) => {
        const plain = exam.toObject();
        plain.results = plain.results.filter((result) => allowed.has(studentIdOf(result.student)));
        return plain;
      }));
    }

    res.json(exams);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get exam by ID
// @route   GET /api/exams/:id
// @access  Private
const getExamById = async (req, res) => {
  try {
    const exam = await Exam.findOne({ _id: req.params.id, isDeleted: false })
      .populate('results.student', 'name email phone');

    if (!exam) {
      return res.status(404).json({ message: 'Exam not found' });
    }

    if (req.user.role === ROLES.STUDENT) {
      const mine = (exam.results || []).find(
        (result) => studentIdOf(result.student) === String(req.user._id)
      );
      const plain = exam.toObject();
      delete plain.results;
      plain.myResult = mine
        ? { marksObtained: mine.marksObtained, status: mine.status, remarks: mine.remarks }
        : null;
      return res.json(plain);
    }

    if (req.user.role === ROLES.TEACHER) {
      const allowed = await loadTeacherStudentIds(req.user._id);
      const plain = exam.toObject();
      plain.results = plain.results.filter((result) => allowed.has(studentIdOf(result.student)));
      return res.json(plain);
    }

    res.json(exam);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Submit or update marks for an exam
// @route   POST /api/exams/:id/results
// @access  Private (Admin, Manager, Teacher)
const submitMarks = async (req, res) => {
  const { results } = req.body; // Array of { studentId, marksObtained, status, remarks }

  if (!results || !Array.isArray(results)) {
    return res.status(400).json({ message: 'Results array is required' });
  }

  try {
    const exam = await Exam.findOne({ _id: req.params.id, isDeleted: false });
    if (!exam) {
      return res.status(404).json({ message: 'Exam not found' });
    }

    if (req.user.role === ROLES.TEACHER) {
      const allowed = await loadTeacherStudentIds(req.user._id);
      const outsider = results.some((result) => !allowed.has(String(result.studentId || '')));
      if (outsider) {
        return res.status(403).json({ message: 'You can only enter marks for students in your batches' });
      }
    }

    // Process each result
    for (const result of results) {
      const { studentId, marksObtained, status, remarks } = result;

      // Find if student already has a result in this exam
      const existingResultIndex = exam.results.findIndex(
        (r) => r.student.toString() === studentId.toString()
      );

      const resultPayload = {
        student: studentId,
        marksObtained: Number(marksObtained),
        status: status || 'pending',
        remarks: remarks || '',
      };

      if (existingResultIndex > -1) {
        exam.results[existingResultIndex] = resultPayload;
      } else {
        exam.results.push(resultPayload);
      }

      // If it is an Entrance Exam, automatically update the StudentProfile
      if (exam.type === 'entrance') {
        const profile = await StudentProfile.findOne({ user: studentId, isDeleted: false });
        if (profile) {
          profile.entranceScore = Number(marksObtained);
          
          if (status === 'passed') {
            profile.entranceStatus = 'passed';
          } else if (status === 'failed') {
            profile.entranceStatus = 'failed';
          } else {
            profile.entranceStatus = 'appeared';
          }
          await profile.save();
        }
      }
    }

    await exam.save();

    const populatedExam = await Exam.findById(exam._id)
      .populate('results.student', 'name email phone');

    res.json(populatedExam);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Generate admit card for entrance exam
// @route   POST /api/exams/admit-card
// @access  Private (Admin, Manager)
const generateAdmitCard = async (req, res) => {
  const { studentId, examDate, examTime, examCenter, instructions } = req.body;

  try {
    const studentUser = await User.findOne({ _id: studentId, role: 'student', isDeleted: false });
    if (!studentUser) {
      return res.status(404).json({ message: 'Student user not found' });
    }

    // Check if admit card already exists for this student
    let admitCard = await AdmitCard.findOne({ student: studentId, isDeleted: false });

    // Generate unique roll number if new card
    const rollNumber = admitCard ? admitCard.rollNumber : `ENT-${new Date().getFullYear()}-${String(Math.floor(1000 + Math.random() * 9000))}`;

    const cardPayload = {
      student: studentId,
      rollNumber,
      examDate: new Date(examDate),
      examTime,
      examCenter: examCenter || undefined,
      instructions: instructions || undefined,
      generatedBy: req.user._id,
    };

    if (admitCard) {
      admitCard = await AdmitCard.findByIdAndUpdate(admitCard._id, cardPayload, { new: true });
    } else {
      admitCard = await AdmitCard.create(cardPayload);
    }

    // Update StudentProfile status
    const profile = await StudentProfile.findOne({ user: studentId, isDeleted: false });
    if (profile) {
      profile.entranceStatus = 'admit_card_generated';
      await profile.save();
    }

    res.status(201).json(admitCard);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get admit card for logged-in student or specific student ID
// @route   GET /api/exams/admit-card/:studentId
// @access  Private (Admin, Manager, Student)
const getAdmitCard = async (req, res) => {
  const targetStudentId = req.params.studentId === 'me' ? req.user._id : req.params.studentId;

  // Verify authorization
  if (req.user.role === 'student' && req.user._id.toString() !== targetStudentId.toString()) {
    return res.status(403).json({ message: 'Access denied' });
  }

  try {
    const admitCard = await AdmitCard.findOne({ student: targetStudentId, isDeleted: false })
      .populate('student', 'name email phone')
      .populate('generatedBy', 'name');

    if (!admitCard) {
      return res.status(404).json({ message: 'Admit card not found for this student' });
    }

    res.json(admitCard);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  createExam,
  getExams,
  getExamById,
  submitMarks,
  generateAdmitCard,
  getAdmitCard,
};
