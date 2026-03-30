const ical = require('node-ical');
const { DateTime } = require('luxon');

const db = require('../db');
const notificationController = require('./notificationController');

function readCronSecret() {
  return (process.env.CRON_SECRET ?? '').toString();
}

function readAuthToken(req) {
  const auth = req.headers?.authorization?.toString() ?? '';
  if (!auth) return '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7);
  return auth;
}

function isAuthorizedCron(req) {
  const required = readCronSecret();
  if (!required) return { ok: false, reason: 'CRON_SECRET_NOT_SET' };
  const token = readAuthToken(req);
  if (!token) return { ok: false, reason: 'MISSING_TOKEN' };
  if (token !== required) return { ok: false, reason: 'INVALID_TOKEN' };
  return { ok: true };
}

function buildDeviceExternalId(roomId, deviceType, fallbackVirtualId) {
  const v = (fallbackVirtualId ?? '').toString().trim();
  if (v) return v;

  const type = (deviceType ?? '').toString().trim().toUpperCase();
  if (type === 'PLUG') return `${roomId}-plug`;
  if (type === 'AC') return `${roomId}-ac`;
  return `${roomId}-${type.toLowerCase() || 'device'}`;
}

function getAgentIdForExternalDeviceId(externalDeviceId) {
  const s = (externalDeviceId ?? '').toString();
  const idx = s.indexOf('-');
  if (idx <= 0) return '';
  return s.slice(0, idx);
}

function sendToLocalAgent(req, agentId, message) {
  const sendToAgent = req.app?.locals?.bridge?.sendToAgent;
  if (typeof sendToAgent !== 'function') return true;
  if (!agentId) return false;
  return sendToAgent(agentId, message) === true;
}

function buildPowerOffMessage(externalDeviceId) {
  return {
    type: 'IOT_CONTROL',
    ts: new Date().toISOString(),
    requestId: `auto-${Date.now()}`,
    deviceId: externalDeviceId,
    action: 'SET_POWER',
    value: false,
  };
}

function readDefaultCheckoutHour() {
  const raw = Number(process.env.DEFAULT_CHECKOUT_HOUR ?? 11);
  return Number.isFinite(raw) ? raw : 11;
}

function readDefaultCheckoutMinute() {
  const raw = Number(process.env.DEFAULT_CHECKOUT_MINUTE ?? 0);
  return Number.isFinite(raw) ? raw : 0;
}

async function listRoomsWithCalendars() {
  try {
    const result = await db.query(
      `SELECT id, user_id, room_name, region, timezone, airbnb_ical_url, cleaning_hours, checkout_hour, checkout_minute
       FROM rooms
       WHERE airbnb_ical_url IS NOT NULL AND airbnb_ical_url <> ''`,
    );
    return result.rows ?? [];
  } catch (error) {
    const message = error?.message?.toString?.() ?? '';
    if (message.includes('checkout_hour') || message.includes('checkout_minute')) {
      const result = await db.query(
        `SELECT id, user_id, room_name, region, timezone, airbnb_ical_url, cleaning_hours
         FROM rooms
         WHERE airbnb_ical_url IS NOT NULL AND airbnb_ical_url <> ''`,
      );
      return result.rows ?? [];
    }
    throw error;
  }
}

async function listDevicesForRoom(roomId) {
  const result = await db.query(
    `SELECT id, room_id, device_type, virtual_id
     FROM devices
     WHERE room_id = $1`,
    [roomId],
  );
  return result.rows ?? [];
}

function isSameLocalDay(now, dateTime) {
  return (
    now.year === dateTime.year && now.month === dateTime.month && now.day === dateTime.day
  );
}

function computeShutdownTime(checkoutDate, cleaningHours) {
  const checkoutHour = readDefaultCheckoutHour();
  const checkoutMinute = readDefaultCheckoutMinute();
  const cleaning = Number(cleaningHours ?? 2);
  const hours = Number.isFinite(cleaning) ? cleaning : 2;
  return checkoutDate
    .set({ hour: checkoutHour, minute: checkoutMinute, second: 0, millisecond: 0 })
    .plus({ hours });
}

async function parseEventsFromUrl(url) {
  const text = (url ?? '').toString().trim();
  if (!text) return null;
  return ical.async.fromURL(text);
}

function extractCheckoutDates(events) {
  const list = [];
  const map = events && typeof events === 'object' ? events : {};
  for (const key of Object.keys(map)) {
    const event = map[key];
    if (!event || event.type !== 'VEVENT') continue;
    if (!(event.end instanceof Date)) continue;
    list.push(event.end);
  }
  return list;
}

function clampHour(value, fallback = 11) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 23) return 23;
  return Math.floor(n);
}

function clampMinute(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 59) return 59;
  return Math.floor(n);
}

function clampCleaningHours(value, fallback = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 24) return 24;
  return n;
}

function computeShutdownTimeCustom(checkoutDate, checkoutHour, cleaningHours) {
  const hour = clampHour(checkoutHour, 11);
  const cleaning = clampCleaningHours(cleaningHours, 2);
  return checkoutDate
    .set({ hour, minute: 0, second: 0, millisecond: 0 })
    .plus({ hours: cleaning });
}

function computeShutdownTimeCustomMinutes(checkoutDate, checkoutHour, checkoutMinute, cleaningHours) {
  const hour = clampHour(checkoutHour, 11);
  const minute = clampMinute(checkoutMinute, 0);
  const cleaning = clampCleaningHours(cleaningHours, 2);
  return checkoutDate
    .set({ hour, minute, second: 0, millisecond: 0 })
    .plus({ hours: cleaning });
}

exports.previewIcal = async (req, res) => {
  const icalUrl = (req.body?.icalUrl ?? '').toString().trim();
  const timeZone = (req.body?.timeZone ?? '').toString().trim() || 'Asia/Seoul';
  const checkoutHour = clampHour(req.body?.checkoutHour, 11);
  const checkoutMinute = clampMinute(req.body?.checkoutMinute, 0);
  const cleaningHours = clampCleaningHours(req.body?.cleaningHours, 2);

  if (!icalUrl || !(icalUrl.startsWith('http://') || icalUrl.startsWith('https://'))) {
    return res.status(400).json({ success: false, message: '유효한 iCal URL이 필요합니다.' });
  }

  try {
    const now = DateTime.now().setZone(timeZone);
    const horizon = now.plus({ days: 30 }).endOf('day');
    const events = await parseEventsFromUrl(icalUrl);
    const checkoutDates = extractCheckoutDates(events)
      .map((d) => DateTime.fromJSDate(d).setZone(timeZone))
      .filter((dt) => dt.isValid);

    const uniqueUpcoming = new Map();
    for (const dt of checkoutDates) {
      if (dt < now.startOf('day')) continue;
      if (dt > horizon) continue;
      const key = dt.toISODate();
      if (!key) continue;
      if (!uniqueUpcoming.has(key)) uniqueUpcoming.set(key, dt);
    }

    const upcomingList = Array.from(uniqueUpcoming.values()).sort((a, b) => a.toMillis() - b.toMillis());
    const nextCheckout = upcomingList.length > 0 ? upcomingList[0] : null;
    const nextShutdownAt = nextCheckout
      ? computeShutdownTimeCustomMinutes(nextCheckout, checkoutHour, checkoutMinute, cleaningHours)
      : null;

    return res.status(200).json({
      success: true,
      upcomingCheckoutCount: upcomingList.length,
      timeZone,
      nextCheckoutDate: nextCheckout ? nextCheckout.toISO() : null,
      nextShutdownAt: nextShutdownAt ? nextShutdownAt.toISO() : null,
    });
  } catch (error) {
    return res.status(502).json({
      success: false,
      message: 'iCal 주소를 불러오지 못했습니다.',
      detail: error?.message ?? String(error),
    });
  }
};

exports.checkCheckoutsAndShutdown = async (req, res) => {
  const auth = isAuthorizedCron(req);
  if (!auth.ok) {
    const status = auth.reason === 'INVALID_TOKEN' || auth.reason === 'MISSING_TOKEN' ? 403 : 500;
    return res.status(status).json({ success: false, reason: auth.reason });
  }

  if (!db.isEnabled()) {
    return res.status(503).json({
      success: false,
      message: 'DATABASE_URL이 설정되지 않아 캘린더 자동화를 실행할 수 없습니다.',
    });
  }

  const rooms = await listRoomsWithCalendars();
  const results = [];

  for (const room of rooms) {
    const roomId = room.id?.toString?.() ?? '';
    const timeZone = room.timezone?.toString?.() ?? 'Asia/Seoul';
    const icalUrl = room.airbnb_ical_url?.toString?.() ?? '';

    if (!roomId || !icalUrl) {
      results.push({ roomId, ok: false, reason: 'INVALID_ROOM' });
      continue;
    }

    try {
      const now = DateTime.now().setZone(timeZone);
      const events = await parseEventsFromUrl(icalUrl);
      const checkoutDates = extractCheckoutDates(events);

      let fired = false;
      let target = null;

      for (const d of checkoutDates) {
        const checkoutDate = DateTime.fromJSDate(d).setZone(timeZone);
        if (!isSameLocalDay(now, checkoutDate)) continue;

        const shutdownAt = computeShutdownTimeCustomMinutes(
          checkoutDate,
          room.checkout_hour ?? readDefaultCheckoutHour(),
          room.checkout_minute ?? readDefaultCheckoutMinute(),
          room.cleaning_hours,
        );
        target = shutdownAt.toISO();

        if (now < shutdownAt) continue;

        const devices = await listDevicesForRoom(roomId);
        let sent = 0;
        for (const device of devices) {
          const externalId = buildDeviceExternalId(roomId, device.device_type, device.virtual_id);
          const agentId = getAgentIdForExternalDeviceId(externalId) || roomId;
          if (sendToLocalAgent(req, agentId, buildPowerOffMessage(externalId))) sent += 1;
        }

        let notified = false;
        const userId = room.user_id?.toString?.() ?? '';
        if (sent > 0 && userId) {
          try {
            const result = await notificationController.sendAutomationAlertToUser({
              userId,
              roomName: room.room_name ?? '',
              timeZone,
            });
            notified = result?.ok === true;
          } catch (_) {}
        }

        fired = true;
        results.push({
          roomId,
          roomName: room.room_name ?? '',
          ok: true,
          action: 'POWER_OFF',
          sent,
          notified,
          timeZone,
          targetShutdownAt: target,
        });
        break;
      }

      if (!fired) {
        results.push({
          roomId,
          roomName: room.room_name ?? '',
          ok: true,
          action: 'SKIP',
          timeZone,
          targetShutdownAt: target,
        });
      }
    } catch (error) {
      results.push({
        roomId,
        roomName: room.room_name ?? '',
        ok: false,
        reason: 'ICAL_PARSE_FAILED',
        message: error?.message ?? String(error),
      });
    }
  }

  return res.status(200).json({ success: true, rooms: rooms.length, results });
};
