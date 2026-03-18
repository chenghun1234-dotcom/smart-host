const express = require('express');

const roomController = require('../controllers/roomController');
const kepcoController = require('../controllers/kepcoController');

const router = express.Router();

router.get('/health', (req, res) => {
  res.status(200).json({ success: true });
});

router.get('/rooms', roomController.getDashboardData);
router.post('/devices/:id/toggle', roomController.toggleDevicePower);
router.post('/sync/:id', roomController.syncCalendarAndAutomate);
router.get('/kepco/price', kepcoController.getCachedPowerPrice);
router.post('/kepco/force-refresh', kepcoController.forceRefreshPrice);

module.exports = router;
