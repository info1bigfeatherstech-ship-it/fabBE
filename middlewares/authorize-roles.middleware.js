/**
 * Role-based authorization middleware.
 * Accepts an array of allowed roles and denies access otherwise.
 */

const authorizeRoles = (...allowedRoles) => {
  return (req, res, next) => {
    const user = req.user || {};
    const role = String(user.role || req.userType || 'user').toLowerCase();

    if (!role) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized access',
        code: 'UNAUTHORIZED'
      });
    }

    if (role === 'admin' || allowedRoles.includes(role)) {
      return next();
    }

    return res.status(403).json({
      success: false,
      message: 'Access denied',
      code: 'FORBIDDEN'
    });
  };
};

module.exports = { authorizeRoles };
