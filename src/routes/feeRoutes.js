const express = require('express');
const router = express.Router();
const {
  recordPayment,
  getPayments,
  getPaymentById,
  getStudentFeeLedger,
} = require('../controllers/feeController');
const { protect, authorize } = require('../middleware/auth');

router.use(protect);

router.route('/')
  .post(authorize('admin', 'accountant'), recordPayment)
  .get(authorize('admin', 'accountant', 'student'), getPayments);

router.get('/ledger/:studentId', authorize('admin', 'accountant', 'student'), getStudentFeeLedger);

router.route('/:id')
  .get(authorize('admin', 'accountant', 'student'), getPaymentById);

module.exports = router;
