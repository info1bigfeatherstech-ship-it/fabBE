const { verifyToken } = require('./auth.middleware');
const User = require('../models/User');

// Middleware that ensures user is authenticated and has admin role
const requireAdmin = async (req, res, next) => {
  try {
    await verifyToken(req, res, async () => {
      const user = await User.findById(req.userId).select('userType role');

      if (!user) {
        return res.status(403).json({ success: false, message: 'User not found' });
      }

      const role = String(user.role || user.userType || 'user').toLowerCase();

      if (role !== 'admin' && role !== 'superadmin' && user.userType !== 'admin') {
        return res.status(403).json({ success: false, message: 'Admin access required' });
      }

      const userId = String(user._id);
      req.user = {
        id: userId,
        role
      };
      req.userId = userId;
      req.userType = user.userType || 'user';

      next();
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error authorizing user', error: error.message });
  }
};

/** Manual wholesaler approve/reject only (owner decisions use signed review link). */
const requireSuperAdmin = async (req, res, next) => {
  try {
    await verifyToken(req, res, async () => {
      const user = await User.findById(req.userId).select('userType role');
      if (!user) {
        return res.status(403).json({ success: false, message: 'User not found' });
      }
      const role = String(user.role || user.userType || 'user').toLowerCase();
      if (role !== 'superadmin') {
        return res.status(403).json({
          success: false,
          message:
            'Manual approve/reject is restricted to superadmin. Use the owner review link from the admin panel.'
        });
      }
      const userId = String(user._id);
      req.user = {
        id: userId,
        role
      };
      req.userId = userId;
      req.userType = user.userType || 'user';
      next();
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error authorizing user', error: error.message });
  }
};

module.exports = { requireAdmin, requireSuperAdmin };

