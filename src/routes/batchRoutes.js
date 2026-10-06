const express = require('express');
const router = express.Router();
const {
  createBatch,
  getBatches,
  getBatchById,
  updateBatch,
  deleteBatch,
} = require('../controllers/batchController');
const { protect, authorize } = require('../middleware/auth');

router.use(protect);

router.route('/')
  .post(authorize('admin', 'manager'), createBatch)
  .get(authorize('admin', 'manager', 'accountant', 'teacher'), getBatches);

router.route('/:id')
  .get(authorize('admin', 'manager', 'accountant', 'teacher'), getBatchById)
  .put(authorize('admin', 'manager'), updateBatch)
  .delete(authorize('admin'), deleteBatch);

module.exports = router;
