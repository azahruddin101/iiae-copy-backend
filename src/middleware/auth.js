const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Protect routes - Verify JWT
const protect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    try {
      // Get token from header
      token = req.headers.authorization.split(' ')[1];

      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Get user from token and attach to request
      req.user = await User.findById(decoded.id).select('-password');

      if (!req.user || req.user.isDeleted) {
        return res.status(401).json({ message: 'Not authorized, user not found' });
      }

      // tokenVersion is bumped when a password, role, or active status changes, and on delete.
      // Tokens issued before that field existed are rejected so they cannot outlive the account.
      if (typeof decoded.tokenVersion !== 'number' || decoded.tokenVersion !== req.user.tokenVersion) {
        return res.status(401).json({ message: 'Session expired. Please log in again.' });
      }

      if (req.user.status === 'inactive') {
        return res.status(403).json({ message: 'User account is inactive. Access denied.' });
      }

      next();
    } catch (error) {
      console.error('JWT verification error:', error.message);
      return res.status(401).json({ message: 'Not authorized, token failed' });
    }
  }

  if (!token) {
    return res.status(401).json({ message: 'Not authorized, no token provided' });
  }
};

// Grant access to specific roles
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        message: `User role '${req.user ? req.user.role : 'guest'}' is not authorized to access this route`,
      });
    }
    next();
  };
};

module.exports = { protect, authorize };
