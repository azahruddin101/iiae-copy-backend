const express = require('express');
const router = express.Router();
const {
  createCourse,
  getCourses,
  getCourseById,
  updateCourse,
  deleteCourse,
} = require('../controllers/courseController');
const { protect, authorize } = require('../middleware/auth');

router.use(protect);

router.route('/')
  .post(authorize('admin', 'manager'), createCourse)
  .get(getCourses);

router.route('/:id')
  .get(getCourseById)
  .put(authorize('admin', 'manager'), updateCourse)
  .delete(authorize('admin'), deleteCourse);

module.exports = router;
