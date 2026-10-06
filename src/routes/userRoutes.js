const express = require('express');
const router = express.Router();
const {
  createUser,
  getUsers,
  getUserById,
  updateUser,
  deleteUser,
} = require('../controllers/userController');
const { protect, authorize } = require('../middleware/auth');
const { ROLES } = require('../utils/rbac');

router.use(protect);

router.route('/')
  .post(authorize(ROLES.ADMIN, ROLES.MANAGER), createUser)
  .get(authorize(ROLES.ADMIN, ROLES.MANAGER, ROLES.COUNSELLOR, ROLES.ACCOUNTANT, ROLES.TEACHER), getUsers);

router.route('/:id')
  .get(getUserById)
  .put(authorize(ROLES.ADMIN, ROLES.MANAGER, ROLES.COUNSELLOR, ROLES.ACCOUNTANT), updateUser)
  .delete(authorize(ROLES.ADMIN), deleteUser);

module.exports = router;
