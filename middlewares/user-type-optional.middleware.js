// middleware/user-type-optional.middleware.js
const User = require('../models/User');
const jwt = require('jsonwebtoken');

const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      req.userType = 'user';
      req.userId = null;
      return next();
    }

    const token = authHeader.startsWith('Bearer ') 
      ? authHeader.slice(7) 
      : authHeader;

    if (!token) {
      req.userType = 'user';
      req.userId = null;
      return next();
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    if (decoded.type !== 'access') {
      req.userType = 'user';
      req.userId = null;
      return next();
    }

    const user = await User.findById(decoded.id).select('userType');
    
    if (user && user.userType) {
      req.userType = user.userType;
      req.userId = decoded.id;
    } else {
      req.userType = 'user';
      req.userId = null;
    }
    
    next();
  } catch (error) {
    req.userType = 'user';
    req.userId = null;
    next();
  }
};

module.exports = { optionalAuth };