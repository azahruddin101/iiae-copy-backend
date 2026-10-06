// Single list of CRM roles and the rules for who may create, edit, or read an account.
// Route middleware still checks the caller's role. These helpers cover the cases a
// role list cannot express, such as "a manager may edit a counsellor but cannot promote them".

const ROLES = Object.freeze({
  ADMIN: 'admin',
  MANAGER: 'manager',
  COUNSELLOR: 'counsellor',
  ACCOUNTANT: 'accountant',
  TEACHER: 'teacher',
  STUDENT: 'student',
});

const ALL_ROLES = Object.freeze(Object.values(ROLES));

// Accounts a manager may create, and may edit without changing the role.
const MANAGER_WRITABLE_ROLES = Object.freeze([ROLES.STUDENT, ROLES.COUNSELLOR]);

const httpError = (statusCode, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const assertCanCreateUser = (actor, role) => {
  if (!ALL_ROLES.includes(role)) {
    throw httpError(400, 'Invalid role');
  }

  if (actor.role === ROLES.ADMIN) return;

  if (actor.role === ROLES.MANAGER && MANAGER_WRITABLE_ROLES.includes(role)) return;

  throw httpError(403, 'You cannot create an account with this role');
};

// Returns the role the account should keep after this update.
const assertCanUpdateUser = (actor, existing, { role, password, status, name, email, phone }) => {
  const nextRole = role || existing.role;

  if (!ALL_ROLES.includes(nextRole)) {
    throw httpError(400, 'Invalid role');
  }

  if (actor.role === ROLES.ADMIN) {
    if (String(actor._id) === String(existing._id) && nextRole !== existing.role) {
      throw httpError(403, 'You cannot change your own role');
    }
    return nextRole;
  }

  if (actor.role === ROLES.MANAGER) {
    if (!MANAGER_WRITABLE_ROLES.includes(existing.role)) {
      throw httpError(403, 'You can only update student and counsellor accounts');
    }
    if (nextRole !== existing.role) {
      throw httpError(403, 'You cannot change a user role');
    }
    return nextRole;
  }

  // Accountants record scholarships and registration payment on a student profile.
  // They cannot rename the account, reset its password, or change its role.
  if (actor.role === ROLES.ACCOUNTANT) {
    if (existing.role !== ROLES.STUDENT) {
      throw httpError(403, 'You can only update student accounts');
    }
    if (nextRole !== existing.role || password || (status && status !== existing.status)) {
      throw httpError(403, 'You cannot change this account');
    }
    if (
      (name && name !== existing.name) ||
      (email && email !== existing.email) ||
      (phone && phone !== existing.phone)
    ) {
      throw httpError(403, 'You cannot change this account');
    }
    return nextRole;
  }

  throw httpError(403, 'You are not allowed to update this account');
};

const assertKeepsAnActiveAdmin = async (User, existing, { nextRole, nextStatus, deleting }) => {
  if (existing.role !== ROLES.ADMIN) return;

  const removesAdmin = deleting || nextRole !== ROLES.ADMIN || nextStatus === 'inactive';
  if (!removesAdmin) return;

  const others = await User.countDocuments({
    role: ROLES.ADMIN,
    status: 'active',
    isDeleted: false,
    _id: { $ne: existing._id },
  });

  if (others === 0) {
    throw httpError(403, 'The last active admin account cannot be removed or deactivated');
  }
};

const canReadUser = (actor, target) => {
  if (!actor || !target) return false;
  if (String(actor._id) === String(target._id)) return true;
  if (actor.role === ROLES.ADMIN || actor.role === ROLES.MANAGER) return true;
  if (
    (actor.role === ROLES.ACCOUNTANT || actor.role === ROLES.TEACHER) &&
    target.role === ROLES.STUDENT
  ) {
    return true;
  }
  return false;
};

const canListAllUsers = (actor) =>
  actor && (actor.role === ROLES.ADMIN || actor.role === ROLES.MANAGER);

module.exports = {
  ROLES,
  ALL_ROLES,
  assertCanCreateUser,
  assertCanUpdateUser,
  assertKeepsAnActiveAdmin,
  canReadUser,
  canListAllUsers,
};
