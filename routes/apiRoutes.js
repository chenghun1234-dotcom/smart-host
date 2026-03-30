const express = require('express');

const roomController = require('../controllers/roomController');
const kepcoController = require('../controllers/kepcoController');
const notificationController = require('../controllers/notificationController');
const calendarController = require('../controllers/calendarController');

const router = express.Router();

router.get('/health', (req, res) => {
  res.status(200).json({ success: true });
});

router.get('/rooms', roomController.getDashboardData);
router.post('/rooms', roomController.createRoom);
router.post('/rooms/:id/ical', roomController.setRoomIcalUrl);
router.get('/monetization/recommended-devices', roomController.getRecommendedDevices);
router.post('/monetization/affiliate-click', roomController.trackAffiliateClick);
router.get('/monetization/affiliate-stats', roomController.getAffiliateStats);
router.post('/checkout/start', roomController.startCheckout);
router.get('/checkout/:checkoutId', roomController.getCheckoutStatus);
router.get('/subscription/status', roomController.getSubscriptionStatus);
router.get('/subscription/plans', roomController.getSubscriptionPlans);
router.post('/subscription/mock-upgrade', roomController.mockUpgradeToPro);
router.post('/subscription/issue-token', roomController.issueSubscriptionToken);
router.post('/subscription/redeem-token', roomController.redeemSubscriptionToken);
router.post('/webhooks/payment', roomController.paymentWebhook);
router.get('/devices', roomController.listDevices);
router.get('/devices/:deviceId/status', roomController.getDeviceStatus);
router.post('/devices/:deviceId/commands', roomController.sendDeviceCommand);
router.post('/webhooks/device-status', roomController.receiveDeviceStatusWebhook);
router.get('/devices/:deviceId/logs', roomController.getDeviceLogs);
router.get('/energy/realtime', roomController.getRealtimeEnergy);
router.get('/rooms/:id/location', roomController.getDeviceLocation);
router.get('/bridge/agents', roomController.listBridgeAgents);
router.post('/bridge/agents/:agentId/commands', roomController.sendBridgeCommand);
router.get('/rooms/:id/ac', roomController.getAirConStatus);
router.post('/devices/:id/toggle', roomController.toggleDevicePower);
router.post('/sync/:id', roomController.syncCalendarAndAutomate);
router.post('/rooms/:id/ac/temperature', roomController.setAirConTemperature);
router.post('/ai/aircon/regulate', roomController.regulateAllAirCons);
router.get('/kepco/price', kepcoController.getCachedPowerPrice);
router.post('/kepco/force-refresh', kepcoController.forceRefreshPrice);
router.get('/global/price', kepcoController.getGlobalPowerPrice);
router.get('/global/markets', kepcoController.listGlobalMarkets);
router.post('/global/force-refresh', kepcoController.forceRefreshGlobalPrices);
router.post('/prices/sync-kr', kepcoController.syncKr);
router.post('/prices/sync-uk', kepcoController.syncUk);
router.post('/prices/sync-us', kepcoController.syncUs);
router.post('/notifications/register', notificationController.registerDevice);
router.post('/notifications/send-peak-alert', notificationController.sendPeakTimeAlert);
router.post('/notifications/send', notificationController.sendCustomNotification);
router.post('/calendar/check-checkouts', calendarController.checkCheckoutsAndShutdown);
router.post('/calendar/preview', calendarController.previewIcal);

module.exports = router;
