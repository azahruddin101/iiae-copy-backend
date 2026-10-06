const Course = require('../models/Course');

// @desc    Create a new course
// @route   POST /api/courses
// @access  Private (Admin, Manager)
const createCourse = async (req, res) => {
  const { name, code, duration, baseFees, description } = req.body;

  try {
    const courseExists = await Course.findOne({ code, isDeleted: false });
    if (courseExists) {
      return res.status(400).json({ message: 'Course with this code already exists' });
    }

    const course = await Course.create({
      name,
      code,
      duration,
      baseFees,
      description,
    });

    res.status(201).json(course);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all courses
// @route   GET /api/courses
// @access  Private (All roles)
const getCourses = async (req, res) => {
  try {
    const courses = await Course.find({ isDeleted: false });
    res.json(courses);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get course by ID
// @route   GET /api/courses/:id
// @access  Private
const getCourseById = async (req, res) => {
  try {
    const course = await Course.findOne({ _id: req.params.id, isDeleted: false });
    if (!course) {
      return res.status(404).json({ message: 'Course not found' });
    }
    res.json(course);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update course details
// @route   PUT /api/courses/:id
// @access  Private (Admin, Manager)
const updateCourse = async (req, res) => {
  const { name, code, duration, baseFees, description } = req.body;

  try {
    const course = await Course.findOne({ _id: req.params.id, isDeleted: false });
    if (!course) {
      return res.status(404).json({ message: 'Course not found' });
    }

    course.name = name !== undefined ? name : course.name;
    course.code = code !== undefined ? code : course.code;
    course.duration = duration !== undefined ? duration : course.duration;
    course.baseFees = baseFees !== undefined ? baseFees : course.baseFees;
    course.description = description !== undefined ? description : course.description;

    await course.save();
    res.json(course);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete course (Soft delete)
// @route   DELETE /api/courses/:id
// @access  Private (Admin)
const deleteCourse = async (req, res) => {
  try {
    const course = await Course.findById(req.params.id);
    if (!course) {
      return res.status(404).json({ message: 'Course not found' });
    }

    course.isDeleted = true;
    await course.save();

    res.json({ message: 'Course deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  createCourse,
  getCourses,
  getCourseById,
  updateCourse,
  deleteCourse,
};
