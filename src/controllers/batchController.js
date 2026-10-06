const Batch = require('../models/Batch');
const StudentProfile = require('../models/StudentProfile');

// @desc    Create a new batch
// @route   POST /api/batches
// @access  Private (Admin, Manager)
const createBatch = async (req, res) => {
  const { name, courseId, teacherId, schedule } = req.body;

  try {
    const batchExists = await Batch.findOne({ name, isDeleted: false });
    if (batchExists) {
      return res.status(400).json({ message: 'Batch with this name already exists' });
    }

    const batch = await Batch.create({
      name,
      course: courseId,
      teacher: teacherId,
      schedule,
      students: [],
    });

    const populatedBatch = await Batch.findById(batch._id)
      .populate('course', 'name code')
      .populate('teacher', 'name email phone');

    res.status(201).json(populatedBatch);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all batches
// @route   GET /api/batches
// @access  Private (Admin, Manager, Accountant, Teacher)
const getBatches = async (req, res) => {
  const filter = { isDeleted: false };

  // If role is teacher, only show batches assigned to them
  if (req.user.role === 'teacher') {
    filter.teacher = req.user._id;
  }

  try {
    const batches = await Batch.find(filter)
      .populate('course', 'name code')
      .populate('teacher', 'name email phone')
      .populate('students', 'name email phone');

    res.json(batches);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get batch by ID
// @route   GET /api/batches/:id
// @access  Private (Admin, Manager, Accountant, Teacher)
const getBatchById = async (req, res) => {
  try {
    const batch = await Batch.findOne({ _id: req.params.id, isDeleted: false })
      .populate('course', 'name code')
      .populate('teacher', 'name email phone')
      .populate('students', 'name email phone');

    if (!batch) {
      return res.status(404).json({ message: 'Batch not found' });
    }

    if (req.user.role === 'teacher' && batch.teacher._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied to this batch details' });
    }

    res.json(batch);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update batch details
// @route   PUT /api/batches/:id
// @access  Private (Admin, Manager)
const updateBatch = async (req, res) => {
  const { name, courseId, teacherId, schedule, students } = req.body;

  try {
    const batch = await Batch.findOne({ _id: req.params.id, isDeleted: false });
    if (!batch) {
      return res.status(404).json({ message: 'Batch not found' });
    }

    batch.name = name !== undefined ? name : batch.name;
    batch.course = courseId !== undefined ? courseId : batch.course;
    batch.teacher = teacherId !== undefined ? teacherId : batch.teacher;
    batch.schedule = schedule !== undefined ? schedule : batch.schedule;

    if (students !== undefined) {
      batch.students = students;

      // Update student profiles batch link
      // Clear batch for students no longer in this batch
      await StudentProfile.updateMany(
        { batch: batch._id, user: { $nin: students } },
        { $unset: { batch: '' } }
      );

      // Set batch for students in this batch
      await StudentProfile.updateMany(
        { user: { $in: students } },
        { batch: batch._id }
      );
    }

    await batch.save();

    const populatedBatch = await Batch.findById(batch._id)
      .populate('course', 'name code')
      .populate('teacher', 'name email phone')
      .populate('students', 'name email phone');

    res.json(populatedBatch);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete batch
// @route   DELETE /api/batches/:id
// @access  Private (Admin)
const deleteBatch = async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.id);
    if (!batch) {
      return res.status(404).json({ message: 'Batch not found' });
    }

    batch.isDeleted = true;
    await batch.save();

    // Clear batch link in student profiles
    await StudentProfile.updateMany(
      { batch: batch._id },
      { $unset: { batch: '' } }
    );

    res.json({ message: 'Batch deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  createBatch,
  getBatches,
  getBatchById,
  updateBatch,
  deleteBatch,
};
