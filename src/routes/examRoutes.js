const express = require('express');
const router = express.Router();
const {
  createExam,
  getExams,
  getExamById,
  submitMarks,
  generateAdmitCard,
  getAdmitCard,
} = require('../controllers/examController');
const { protect, authorize } = require('../middleware/auth');
const { ROLES } = require('../utils/rbac');

router.use(protect);

const graders = [ROLES.ADMIN, ROLES.MANAGER, ROLES.TEACHER];
const examReaders = [...graders, ROLES.STUDENT];

router.post('/admit-card', authorize(ROLES.ADMIN, ROLES.MANAGER), generateAdmitCard);
router.get('/admit-card/:studentId', authorize(ROLES.ADMIN, ROLES.MANAGER, ROLES.STUDENT), getAdmitCard);

router.route('/')
  .post(authorize(...graders), createExam)
  .get(authorize(...examReaders), getExams);

router.route('/:id')
  .get(authorize(...examReaders), getExamById);

router.post('/:id/results', authorize(...graders), submitMarks);

module.exports = router;
