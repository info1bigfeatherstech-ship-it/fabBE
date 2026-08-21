


const express = require('express');
const { body } = require('express-validator');
const { 
    register,
    getSecurityQuestions,
    verifyOTPAndLogin,
    login,
    logout, 
    me, 
    updateProfile, 
    requestContactChangeOTP,
    verifyContactChangeOTP,
    changePassword,
    findUserForPasswordReset,
    verifySecurityAnswersForPasswordReset,
    verifyPasswordResetOtpFallback,
    resetPasswordDirect,
    // Legacy OTP forgot-password kept live for wholesaleFrontend compatibility
    sendPasswordResetOTP,
    verifyPasswordResetOTP,
    resetPasswordWithOTP,
    refreshAccessToken, 
    googleAuth ,
    getActiveDevices,
    logoutDevice,
    logoutAllDevices
} = require('../controllers/auth.controller');
const { verifyToken } = require('../middlewares/auth.middleware');

const router = express.Router();

// =============================================
// 1️⃣ REGISTER FLOW (email OTP + 1 security question)
// =============================================

router.get('/security-questions', getSecurityQuestions);

router.post(
    '/register',
    [
        body('name')
            .trim()
            .notEmpty()
            .withMessage('Name is required')
            .isLength({ min: 2 })
            .withMessage('Name must be at least 2 characters'),
        body('email')
            .trim()
            .notEmpty()
            .withMessage('Email is required')
            .isEmail()
            .withMessage('Invalid email format')
            .normalizeEmail(),
        body('phone')
            .trim()
            .notEmpty()
            .withMessage('Phone number is required')
            .matches(/^[0-9]{10}$/)
            .withMessage('Phone number must be 10 digits'),
        body('password')
            .notEmpty()
            .withMessage('Password is required')
            .isLength({ min: 6 })
            .withMessage('Password must be at least 6 characters'),
        body('confirmPassword')
            .notEmpty()
            .withMessage('Confirm password is required')
            .custom((value, { req }) => value === req.body.password)
            .withMessage('Passwords do not match'),
        body('securityAnswers')
            .optional()
            .isArray({ min: 1, max: 1 })
            .withMessage('Please choose one security question'),
        body('securityQuestion')
            .optional()
            .isObject()
            .withMessage('Please choose one security question')
    ],
    register
);

router.post(
    '/otp-verify-login',
    [
        body('identifier')
            .optional()
            .trim(),
        body('email')
            .optional()
            .trim(),
        body('phone')
            .optional()
            .trim(),
        body('otp')
            .trim()
            .notEmpty()
            .withMessage('OTP is required')
            .isLength({ min: 4, max: 8 })
            .withMessage('Invalid OTP format')
    ],
    verifyOTPAndLogin
);

// =============================================
// 2️⃣ LOGIN FLOW (Email OR Phone + Password)
// =============================================

router.post(
    '/login',
    [
        body('identifier')
            .trim()
            .notEmpty()
            .withMessage('Email or Phone number is required'),
        body('password')
            .notEmpty()
            .withMessage('Password is required'),
        body('portal')
            .optional()
            .isIn(['ecomm', 'wholesale', 'admin-ecomm', 'admin-wholesale'])
            .withMessage('portal must be one of: ecomm, wholesale, admin-ecomm, admin-wholesale')
    ],
    login
);

// =============================================
// 3️⃣ FORGOT PASSWORD FLOW (ecomm)
// =============================================

router.post(
    '/forgot-password/find-user',
    [
        body('identifier')
            .optional()
            .trim(),
        body('phone')
            .optional()
            .trim(),
        body('email')
            .optional()
            .trim()
    ],
    findUserForPasswordReset
);

router.post(
    '/forgot-password/verify-answers',
    [
        body('challengeToken')
            .trim()
            .notEmpty()
            .withMessage('Reset session is required')
    ],
    verifySecurityAnswersForPasswordReset
);

router.post(
    '/forgot-password/verify-otp-fallback',
    [
        body('challengeToken')
            .trim()
            .notEmpty()
            .withMessage('Reset session is required'),
        body('otp')
            .trim()
            .notEmpty()
            .withMessage('OTP is required')
    ],
    verifyPasswordResetOtpFallback
);

router.post(
    '/forgot-password/reset-direct',
    [
        body('resetToken')
            .trim()
            .notEmpty()
            .withMessage('Reset token is required'),
        body('newPassword')
            .notEmpty()
            .withMessage('New password is required')
            .isLength({ min: 6 })
            .withMessage('Password must be at least 6 characters'),
        body('confirmPassword')
            .notEmpty()
            .withMessage('Confirm password is required')
    ],
    resetPasswordDirect
);

// --- Legacy OTP forgot-password (kept LIVE for wholesaleFrontend) ---
router.post(
    '/forgot-password/request-otp',
    [
        body('identifier')
            .trim()
            .notEmpty()
            .withMessage('Email or Phone number is required')
    ],
    sendPasswordResetOTP
);

router.post(
    '/forgot-password/verify-otp',
    [
        body('identifier')
            .trim()
            .notEmpty()
            .withMessage('Email or Phone number is required'),
        body('otp')
            .trim()
            .notEmpty()
            .withMessage('OTP is required')
    ],
    verifyPasswordResetOTP
);

router.post(
    '/forgot-password/reset',
    [
        body('identifier')
            .trim()
            .notEmpty()
            .withMessage('Email or Phone number is required'),
        body('otp')
            .trim()
            .notEmpty()
            .withMessage('OTP is required'),
        body('newPassword')
            .notEmpty()
            .withMessage('New password is required')
            .isLength({ min: 6 })
            .withMessage('Password must be at least 6 characters')
    ],
    resetPasswordWithOTP
);

// =============================================
// 4️⃣ CHANGE PASSWORD (Logged in user)
// =============================================

router.put(
    '/change-password',
    verifyToken,
    [
        body('oldPassword')
            .notEmpty()
            .withMessage('Old password is required'),
        body('newPassword')
            .notEmpty()
            .withMessage('New password is required')
            .isLength({ min: 6 })
            .withMessage('Password must be at least 6 characters')
    ],
    changePassword
);

// =============================================
// 5️⃣ GOOGLE AUTH
// =============================================

router.post('/google', [
    body('idToken').notEmpty().withMessage('idToken is required')
], googleAuth);

// =============================================
// 6️⃣ REFRESH TOKEN & LOGOUT
// =============================================

router.post('/refresh', refreshAccessToken);
router.post('/logout', verifyToken, logout);

// =============================================
// 7️⃣ USER PROFILE (Protected)
// =============================================

router.get('/me', verifyToken, me);
router.put('/profile', verifyToken, updateProfile);
router.post(
    '/profile/contact-change/request-otp',
    verifyToken,
    [
        body('field')
            .trim()
            .notEmpty()
            .withMessage('field is required')
            .isIn(['email', 'phone'])
            .withMessage('field must be one of: email, phone'),
        body('newValue')
            .trim()
            .notEmpty()
            .withMessage('newValue is required')
    ],
    requestContactChangeOTP
);
router.post(
    '/profile/contact-change/verify-otp',
    verifyToken,
    [
        body('otp')
            .trim()
            .notEmpty()
            .withMessage('otp is required')
    ],
    verifyContactChangeOTP
);

router.get('/devices', verifyToken, getActiveDevices);
router.post('/devices/logout', verifyToken, logoutDevice);
router.post('/logout-all', verifyToken, logoutAllDevices);

module.exports = router;
