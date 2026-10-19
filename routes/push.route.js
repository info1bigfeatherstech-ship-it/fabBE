const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const {
  getVapidPublicKeyHandler,
  subscribePush,
  unsubscribePush,
  getPushStatus,
  reportPwaInstall,
} = require('../controllers/push-subscription.controller');

router.get('/vapid-public-key', getVapidPublicKeyHandler);
router.get('/status', verifyToken, getPushStatus);
router.post('/subscribe', verifyToken, subscribePush);
router.delete('/unsubscribe', verifyToken, unsubscribePush);
router.post('/pwa-install', verifyToken, reportPwaInstall);

module.exports = router;
