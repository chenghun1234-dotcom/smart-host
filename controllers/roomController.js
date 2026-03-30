const ical = require('node-ical');
const axios = require('axios');
const kepcoController = require('./kepcoController');
const db = require('../db');

let mockDb = {
  totalSavedAmount: 342.5,
  rooms: [
    {
      id: 'r1',
      name: 'Room 101',
      status: 'Occupied',
      isPowerOn: true,
      icalUrl: '에어비앤비_ical_링크_1',
      ac: {
        power: true,
        currentTemp: 24,
        targetTemp: 24,
        mode: 'COOL',
        aiMode: 'NORMAL',
      },
    },
    {
      id: 'r2',
      name: 'Room 102',
      status: 'Vacant',
      isPowerOn: false,
      icalUrl: '에어비앤비_ical_링크_2',
      ac: {
        power: false,
        currentTemp: 26,
        targetTemp: 28,
        mode: 'COOL',
        aiMode: 'SAVING',
      },
    },
    {
      id: 'r3',
      name: 'Room 201',
      status: 'Vacant',
      isPowerOn: true,
      icalUrl: '에어비앤비_ical_링크_3',
      ac: {
        power: true,
        currentTemp: 25,
        targetTemp: 24,
        mode: 'COOL',
        aiMode: 'PEAK_ALARM',
      },
    },
  ],
};

function isUuidText(text) {
  const s = (text ?? '').toString().trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
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
  return Math.round(n);
}

function mapRoomRowToApi(row) {
  return {
    id: row?.id?.toString?.() ?? '',
    name: row?.room_name?.toString?.() ?? '',
    status: 'Vacant',
    isPowerOn: false,
    icalUrl: row?.airbnb_ical_url?.toString?.() ?? null,
  };
}

async function listRoomsFromDb() {
  const roomsRes = await db.query(
    `SELECT id, room_name, airbnb_ical_url, total_saved_amount
     FROM rooms
     ORDER BY room_name ASC`,
  );
  const rooms = (roomsRes.rows ?? []).map(mapRoomRowToApi);
  const totalSavedAmount = (roomsRes.rows ?? []).reduce((acc, r) => {
    const n = Number(r?.total_saved_amount ?? 0);
    return acc + (Number.isFinite(n) ? n : 0);
  }, 0);
  return { rooms, totalSavedAmount };
}

async function createRoomInDb({ name, icalUrl, userId }) {
  const uid = isUuidText(userId) ? userId : null;
  try {
    const inserted = await db.query(
      `INSERT INTO rooms (user_id, room_name, airbnb_ical_url, cleaning_hours, checkout_hour, checkout_minute)
       VALUES ($1, $2, $3, 2, 11, 0)
       RETURNING id, room_name, airbnb_ical_url, total_saved_amount`,
      [uid, name, icalUrl || null],
    );
    return inserted.rows?.[0] ?? null;
  } catch (error) {
    const message = error?.message?.toString?.() ?? '';
    if (message.includes('checkout_hour') || message.includes('checkout_minute')) {
      const inserted = await db.query(
        `INSERT INTO rooms (user_id, room_name, airbnb_ical_url, cleaning_hours)
         VALUES ($1, $2, $3, 2)
         RETURNING id, room_name, airbnb_ical_url, total_saved_amount`,
        [uid, name, icalUrl || null],
      );
      return inserted.rows?.[0] ?? null;
    }
    throw error;
  }
}

async function updateRoomCalendarInDb({ roomId, icalUrl, checkoutHour, checkoutMinute, cleaningHours }) {
  const id = (roomId ?? '').toString().trim();
  if (!isUuidText(id)) return { ok: false, reason: 'INVALID_ROOM_ID' };

  const ch = clampHour(checkoutHour, 11);
  const cm = clampMinute(checkoutMinute, 0);
  const cl = clampCleaningHours(cleaningHours, 2);

  try {
    const updated = await db.query(
      `UPDATE rooms
       SET airbnb_ical_url = $2, cleaning_hours = $3, checkout_hour = $4, checkout_minute = $5
       WHERE id = $1`,
      [id, icalUrl || null, cl, ch, cm],
    );
    if ((updated.rowCount ?? 0) === 0) return { ok: false, reason: 'NOT_FOUND' };
    return { ok: true };
  } catch (error) {
    const message = error?.message?.toString?.() ?? '';
    if (message.includes('checkout_hour') || message.includes('checkout_minute')) {
      const updated = await db.query(
        `UPDATE rooms
         SET airbnb_ical_url = $2, cleaning_hours = $3
         WHERE id = $1`,
        [id, icalUrl || null, cl],
      );
      if ((updated.rowCount ?? 0) === 0) return { ok: false, reason: 'NOT_FOUND' };
      return { ok: true };
    }
    throw error;
  }
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isTodayBookedFromEvents(parsed) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTomorrow = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  );

  for (const item of Object.values(parsed)) {
    if (!item || item.type !== 'VEVENT') continue;
    const start = item.start instanceof Date ? item.start : null;
    const end = item.end instanceof Date ? item.end : null;
    if (!start || !end) continue;

    const overlapsToday = start < startOfTomorrow && end > startOfToday;
    if (overlapsToday) return true;
  }

  return false;
}

function readNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const num = Number(raw);
  return Number.isFinite(num) ? num : fallback;
}

function ensureAc(room) {
  if (!room.ac) {
    room.ac = {
      power: false,
      currentTemp: 26,
      targetTemp: 28,
      mode: 'COOL',
      aiMode: 'SAVING',
    };
  }
  return room.ac;
}

const deviceEvents = [];
const deviceLogs = [];
const deviceState = {
  irLastCommandByRoomId: {},
  gatewayOnline: true,
};

let subscriptionTier = (process.env.SUBSCRIPTION_TIER ?? 'FREE').toString().toUpperCase();
const affiliateClickEvents = [];
const affiliateClickStats = new Map();
const checkoutSessions = new Map();

function normalizeTier(raw) {
  const value = (raw ?? '').toString().toUpperCase();
  if (value === 'PRO') return 'PRO';
  if (value === 'ENTERPRISE') return 'ENTERPRISE';
  return 'FREE';
}

function randomId() {
  try {
    const crypto = require('crypto');
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return crypto.randomBytes(16).toString('hex');
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function readWebhookSecret() {
  return (process.env.PAYMENT_WEBHOOK_SECRET ?? '').toString();
}

function verifyWebhookAuth(req) {
  const required = readWebhookSecret();
  if (!required) return { ok: false, reason: 'PAYMENT_WEBHOOK_SECRET_NOT_SET' };
  const token = readAuthToken(req);
  if (!token) return { ok: false, reason: 'MISSING_TOKEN' };
  if (token !== required) return { ok: false, reason: 'INVALID_TOKEN' };
  return { ok: true };
}

const appleRootCaG3Pem = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----`;

function base64UrlDecodeToBuffer(input) {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function toPemCertificate(derBase64) {
  const body = derBase64.match(/.{1,64}/g)?.join('\n') ?? derBase64;
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

function verifyTossWebhook(req) {
  const secret = (process.env.TOSS_WEBHOOK_SECRET ?? '').toString();
  if (!secret) return { ok: false, reason: 'TOSS_WEBHOOK_SECRET_NOT_SET' };
  const signature = req.headers?.['tosspayments-webhook-signature']?.toString() ?? '';
  const ts = req.headers?.['tosspayments-webhook-transmission-time']?.toString() ?? '';
  if (!signature || !ts) return { ok: false, reason: 'MISSING_TOSS_HEADERS' };

  const crypto = require('crypto');
  const rawBody = req.rawBody?.toString?.() ?? JSON.stringify(req.body ?? {});
  const message = `${rawBody}:${ts}`;
  const digest = crypto.createHmac('sha256', secret).update(message).digest();
  const expectedBase64 = digest.toString('base64');
  const expectedHex = digest.toString('hex');

  if (signature === expectedBase64 || signature === expectedHex) return { ok: true };
  return { ok: false, reason: 'INVALID_TOSS_SIGNATURE' };
}

let paypalTokenCache = { token: null, exp: 0 };

async function verifyPayPalWebhook(req) {
  const clientId = (process.env.PAYPAL_CLIENT_ID ?? '').toString();
  const clientSecret = (process.env.PAYPAL_CLIENT_SECRET ?? '').toString();
  const webhookId = (process.env.PAYPAL_WEBHOOK_ID ?? '').toString();
  const mode = (process.env.PAYPAL_MODE ?? 'sandbox').toString().toLowerCase();
  if (!clientId || !clientSecret || !webhookId) return { ok: false, reason: 'PAYPAL_NOT_CONFIGURED' };

  const baseUrl = mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  const now = Date.now();
  if (!paypalTokenCache.token || paypalTokenCache.exp <= now) {
    const tokenRes = await axios.post(
      `${baseUrl}/v1/oauth2/token`,
      'grant_type=client_credentials',
      {
        auth: { username: clientId, password: clientSecret },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 8000,
      },
    );
    const token = tokenRes?.data?.access_token?.toString?.() ?? '';
    const expiresIn = Number(tokenRes?.data?.expires_in ?? 0);
    if (!token) return { ok: false, reason: 'PAYPAL_OAUTH_FAILED' };
    paypalTokenCache = { token, exp: now + Math.max(0, expiresIn - 60) * 1000 };
  }

  const verification = {
    auth_algo: req.headers?.['paypal-auth-algo']?.toString() ?? '',
    cert_url: req.headers?.['paypal-cert-url']?.toString() ?? '',
    transmission_id: req.headers?.['paypal-transmission-id']?.toString() ?? '',
    transmission_sig: req.headers?.['paypal-transmission-sig']?.toString() ?? '',
    transmission_time: req.headers?.['paypal-transmission-time']?.toString() ?? '',
    webhook_id: webhookId,
    webhook_event: req.body ?? {},
  };

  if (
    !verification.auth_algo ||
    !verification.cert_url ||
    !verification.transmission_id ||
    !verification.transmission_sig ||
    !verification.transmission_time
  ) {
    return { ok: false, reason: 'MISSING_PAYPAL_HEADERS' };
  }

  const verifyRes = await axios.post(
    `${baseUrl}/v1/notifications/verify-webhook-signature`,
    verification,
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${paypalTokenCache.token}`,
      },
      timeout: 8000,
    },
  );

  const status = verifyRes?.data?.verification_status?.toString?.() ?? '';
  if (status === 'SUCCESS') return { ok: true };
  return { ok: false, reason: 'PAYPAL_VERIFICATION_FAILED' };
}

function verifyAppleJwsAndDecodePayload(jws) {
  const raw = (jws ?? '').toString().trim();
  const parts = raw.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'INVALID_JWS_FORMAT' };
  const [encodedHeader, encodedPayload, encodedSig] = parts;

  let header = null;
  try {
    header = JSON.parse(base64UrlDecodeToString(encodedHeader));
  } catch {
    return { ok: false, reason: 'INVALID_JWS_HEADER' };
  }

  const x5c = Array.isArray(header?.x5c) ? header.x5c : [];
  if (x5c.length < 2) return { ok: false, reason: 'MISSING_X5C_CHAIN' };

  const crypto = require('crypto');
  if (typeof crypto.X509Certificate !== 'function') {
    return { ok: false, reason: 'X509_NOT_SUPPORTED' };
  }

  const certs = x5c.map((b64) => new crypto.X509Certificate(toPemCertificate(b64)));
  const root = new crypto.X509Certificate(appleRootCaG3Pem);

  for (let i = 0; i < certs.length - 1; i += 1) {
    const leaf = certs[i];
    const issuer = certs[i + 1];
    if (!leaf.checkIssued(issuer)) return { ok: false, reason: 'INVALID_CERT_CHAIN' };
    if (!leaf.verify(issuer.publicKey)) return { ok: false, reason: 'INVALID_CERT_SIGNATURE' };
  }

  const top = certs[certs.length - 1];
  if (!top.checkIssued(root)) return { ok: false, reason: 'INVALID_ROOT_ISSUER' };
  if (!top.verify(root.publicKey)) return { ok: false, reason: 'INVALID_ROOT_SIGNATURE' };

  const alg = header?.alg?.toString?.() ?? '';
  const algorithm =
    alg === 'ES256' || alg === 'RS256'
      ? 'sha256'
      : alg === 'ES384' || alg === 'RS384'
        ? 'sha384'
        : alg === 'ES512' || alg === 'RS512'
          ? 'sha512'
          : '';
  if (!algorithm) return { ok: false, reason: 'UNSUPPORTED_JWS_ALG' };

  const signedData = Buffer.from(`${encodedHeader}.${encodedPayload}`, 'utf8');
  const signature = base64UrlDecodeToBuffer(encodedSig);
  const ok = crypto.verify(algorithm, signedData, certs[0].publicKey, signature);
  if (!ok) return { ok: false, reason: 'INVALID_JWS_SIGNATURE' };

  let payload = null;
  try {
    payload = JSON.parse(base64UrlDecodeToString(encodedPayload));
  } catch {
    return { ok: false, reason: 'INVALID_JWS_PAYLOAD' };
  }

  return { ok: true, header, payload };
}

function decodeAppleJwsPayload(jws) {
  const raw = (jws ?? '').toString().trim();
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(base64UrlDecodeToString(parts[1]));
  } catch {
    return null;
  }
}

function base64UrlEncode(input) {
  const raw = typeof input === 'string' ? input : JSON.stringify(input);
  return Buffer.from(raw)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecodeToString(input) {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function readLicenseSecret() {
  return (process.env.LICENSE_SECRET ?? '').toString();
}

function signLicensePayload(payload) {
  const secret = readLicenseSecret();
  if (!secret) return '';
  const crypto = require('crypto');
  return crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function issueLicenseToken({ tier, exp }) {
  const payload = {
    tier: normalizeTier(tier),
    exp: typeof exp === 'number' ? exp : null,
  };
  const payloadEncoded = base64UrlEncode(payload);
  const sig = signLicensePayload(payloadEncoded);
  if (!sig) return null;
  return `${payloadEncoded}.${sig}`;
}

function verifyLicenseToken(token) {
  const secret = readLicenseSecret();
  if (!secret) {
    return { ok: false, reason: 'LICENSE_SECRET_NOT_SET' };
  }

  const raw = (token ?? '').toString().trim();
  const parts = raw.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'INVALID_FORMAT' };
  const [payloadEncoded, sig] = parts;
  const expected = signLicensePayload(payloadEncoded);
  if (!expected || sig !== expected) return { ok: false, reason: 'INVALID_SIGNATURE' };

  let payload = null;
  try {
    payload = JSON.parse(base64UrlDecodeToString(payloadEncoded));
  } catch {
    return { ok: false, reason: 'INVALID_PAYLOAD' };
  }

  const tier = normalizeTier(payload?.tier);
  const exp = payload?.exp;
  if (typeof exp === 'number' && Date.now() > exp) return { ok: false, reason: 'EXPIRED' };
  return { ok: true, tier, exp: typeof exp === 'number' ? exp : null };
}

function readAuthToken(req) {
  const auth = req.headers?.authorization?.toString() ?? '';
  const direct = req.headers?.['x-bridge-token']?.toString() ?? '';
  if (direct) return direct;
  if (!auth) return '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7);
  return auth;
}

function isAuthorizedAdmin(req) {
  const required = (process.env.BRIDGE_TOKEN ?? '').toString();
  if (!required) return true;
  return readAuthToken(req) === required;
}

function buildSubscriptionStatus(tier) {
  const normalized = normalizeTier(tier);
  if (normalized === 'PRO') {
    return {
      tier: 'PRO',
      limits: { maxRooms: null },
      features: {
        aiPrecooling: true,
        peakDefense: true,
        powerReports: true,
        multiProperty: false,
      },
    };
  }
  if (normalized === 'ENTERPRISE') {
    return {
      tier: 'ENTERPRISE',
      limits: { maxRooms: null },
      features: {
        aiPrecooling: true,
        peakDefense: true,
        powerReports: true,
        multiProperty: true,
      },
    };
  }
  return {
    tier: 'FREE',
    limits: { maxRooms: 1 },
    features: {
      aiPrecooling: false,
      peakDefense: false,
      powerReports: false,
      multiProperty: false,
    },
  };
}

function detectMarket(req) {
  const explicit = req.query?.market?.toString()?.toUpperCase?.() ?? '';
  if (explicit === 'KR' || explicit === 'US') return explicit;
  const accept = req.headers?.['accept-language']?.toString()?.toLowerCase?.() ?? '';
  if (accept.includes('ko')) return 'KR';
  return 'US';
}

function readEnvUrl(name) {
  const value = process.env[name];
  if (!value) return '';
  const text = value.toString();
  return isHttpUrl(text) ? text : '';
}

function listRecommendedDevices(market) {
  const isKr = market === 'KR';
  const storeName = isKr ? '쿠팡' : 'Amazon';
  const plugUrl = isKr
    ? readEnvUrl('COUPANG_PARTNERS_PLUG_URL')
    : readEnvUrl('AMAZON_ASSOC_PLUG_URL');
  const irUrl = isKr
    ? readEnvUrl('COUPANG_PARTNERS_IRHUB_URL')
    : readEnvUrl('AMAZON_ASSOC_IRHUB_URL');

  return [
    {
      productId: 'smart-plug-energy-v1',
      kind: 'SMART_PLUG',
      friendlyName: '스마트 플러그 (전력측정)',
      recommendedReason: '전력 측정 + 차단을 한 번에',
      storeName,
      affiliateUrl: plugUrl,
      priority: 1,
    },
    {
      productId: 'ir-hub-v1',
      kind: 'IR_HUB',
      friendlyName: 'IR 허브 (에어컨 리모컨 대체)',
      recommendedReason: '구형 에어컨도 AI 제어 가능',
      storeName,
      affiliateUrl: irUrl,
      priority: 2,
    },
  ];
}

function buildAffiliateStatsKey({ productId, market, source }) {
  return `${market ?? ''}__${source ?? ''}__${productId ?? ''}`;
}

function appendAffiliateClickEvent(entry) {
  affiliateClickEvents.push(entry);
  if (affiliateClickEvents.length > 1000) {
    affiliateClickEvents.splice(0, affiliateClickEvents.length - 1000);
  }

  const key = buildAffiliateStatsKey(entry);
  const current = affiliateClickStats.get(key) ?? {
    productId: entry.productId,
    market: entry.market,
    source: entry.source,
    clicks: 0,
    firstAt: entry.ts,
    lastAt: entry.ts,
  };
  current.clicks += 1;
  current.lastAt = entry.ts;
  affiliateClickStats.set(key, current);
}

function buildDeviceId(kind, roomId) {
  return `${kind}-${roomId}`;
}

function getRoomById(roomId) {
  return mockDb.rooms.find((r) => r.id === roomId) ?? null;
}

function listIndustryDevices() {
  const devices = [];
  for (const room of mockDb.rooms) {
    devices.push({
      deviceId: buildDeviceId('ac', room.id),
      kind: 'AC',
      roomId: room.id,
      name: `${room.name} 에어컨`,
      online: true,
    });
    devices.push({
      deviceId: buildDeviceId('breaker', room.id),
      kind: 'INTELLIGENT_BREAKER',
      roomId: room.id,
      name: `${room.name} 차단기/전력계`,
      online: true,
    });
    devices.push({
      deviceId: buildDeviceId('irhub', room.id),
      kind: 'IR_HUB',
      roomId: room.id,
      name: `${room.name} IR 허브`,
      online: true,
    });
  }

  devices.push({
    deviceId: 'gateway-main',
    kind: 'GATEWAY',
    roomId: null,
    name: '메인 게이트웨이',
    online: deviceState.gatewayOnline,
  });

  return devices;
}

function getDeviceStatus(deviceId) {
  if (deviceId === 'gateway-main') {
    return {
      deviceId,
      kind: 'GATEWAY',
      online: deviceState.gatewayOnline,
    };
  }

  const [kind, roomId] = String(deviceId).split('-', 2);
  const room = getRoomById(roomId);
  if (!room) return null;

  if (kind === 'ac') {
    return {
      deviceId,
      kind: 'AC',
      roomId,
      ac: ensureAc(room),
      status: room.status,
    };
  }

  if (kind === 'breaker') {
    const ac = ensureAc(room);
    const watts =
      (room.isPowerOn ? 80 : 0) +
      (ac.power ? Math.max(0, 250 - Math.abs(ac.currentTemp - ac.targetTemp) * 30) : 0);

    return {
      deviceId,
      kind: 'INTELLIGENT_BREAKER',
      roomId,
      watts,
      isPowerOn: room.isPowerOn,
      status: room.status,
    };
  }

  if (kind === 'irhub') {
    return {
      deviceId,
      kind: 'IR_HUB',
      roomId,
      lastCommand: deviceState.irLastCommandByRoomId[roomId] ?? null,
      status: room.status,
    };
  }

  return null;
}

function appendDeviceLog(entry) {
  deviceLogs.push(entry);
  if (deviceLogs.length > 500) deviceLogs.splice(0, deviceLogs.length - 500);
}

function appendDeviceEvent(entry) {
  deviceEvents.push(entry);
  if (deviceEvents.length > 500) deviceEvents.splice(0, deviceEvents.length - 500);
}

async function setAirConTemperatureInternal(roomId, targetTemp, aiMode) {
  const room = mockDb.rooms.find((r) => r.id === roomId);
  if (!room) return false;
  const ac = ensureAc(room);
  ac.targetTemp = targetTemp;
  if (aiMode) ac.aiMode = aiMode;
  console.log(`[Mock IoT] ${room.name} 에어컨 온도를 ${targetTemp}도로 설정했습니다. (모드: ${aiMode ?? ac.aiMode})`);
  appendDeviceLog({
    ts: new Date().toISOString(),
    deviceId: buildDeviceId('ac', roomId),
    event: 'SET_TARGET_TEMP',
    payload: { targetTemp, aiMode: aiMode ?? ac.aiMode },
  });
  return true;
}

async function regulateAirConTemperature(roomId, options) {
  const room = mockDb.rooms.find((r) => r.id === roomId);
  if (!room) return { roomId, applied: false, reason: 'ROOM_NOT_FOUND' };

  const ac = ensureAc(room);
  if (!ac.power) return { roomId, applied: false, reason: 'AC_OFF' };

  const kepcoCache = kepcoController.getKepcoCacheSnapshot?.() ?? null;
  const prices = Array.isArray(kepcoCache?.tomorrowPrices)
    ? kepcoCache.tomorrowPrices
    : [];
  const avg = Number(kepcoCache?.averagePrice ?? 0);
  const currentHour = new Date().getHours();
  const currentPrice = Number(prices[currentHour] ?? 0);
  const nextHourPrice = Number(prices[(currentHour + 1) % 24] ?? 0);
  const next2HourPrice = Number(prices[(currentHour + 2) % 24] ?? 0);

  const highThreshold =
    avg > 0 ? avg * options.priceHighMultiplier : options.priceHighAbsolute;
  const isCurrentlyPeak = currentPrice > highThreshold;
  const isPeakApproaching =
    nextHourPrice >= highThreshold || next2HourPrice >= highThreshold;

  let targetTemp = options.tempNormal;
  let aiMode = 'NORMAL';

  if (room.status === 'Vacant') {
    targetTemp = options.tempVacant;
    aiMode = 'SAVING';
  } else if (isCurrentlyPeak) {
    targetTemp = options.tempPeak;
    aiMode = 'PEAK_CONTROL';
  } else if (isPeakApproaching && avg > 0 && currentPrice < avg) {
    targetTemp = options.tempPrecool;
    aiMode = 'PRE_COOLING';
  }

  if (ac.targetTemp === targetTemp && ac.aiMode === aiMode) {
    return { roomId, applied: false, reason: 'NO_CHANGE', targetTemp, aiMode };
  }

  await setAirConTemperatureInternal(roomId, targetTemp, aiMode);
  return {
    roomId,
    applied: true,
    targetTemp,
    aiMode,
    currentHour,
    currentPrice,
    averagePrice: avg,
  };
}

exports.getDashboardData = (req, res) => {
  if (db.isEnabled()) {
    return listRoomsFromDb()
      .then(({ rooms, totalSavedAmount }) =>
        res.status(200).json({
          success: true,
          totalSavedAmount,
          rooms,
        }),
      )
      .catch(() =>
        res.status(500).json({
          success: false,
          message: 'DB에서 객실 정보를 불러오지 못했습니다.',
        }),
      );
  }
  res.status(200).json({
    success: true,
    totalSavedAmount: mockDb.totalSavedAmount,
    rooms: mockDb.rooms,
  });
};

exports.createRoom = (req, res) => {
  const name = req.body?.name?.toString()?.trim?.() ?? '';
  const icalUrlRaw = req.body?.icalUrl?.toString() ?? '';
  const icalUrl = icalUrlRaw.trim();
  const userId = req.body?.userId?.toString?.().trim?.() ?? '';
  const requestedIdRaw = req.body?.id?.toString() ?? '';
  const requestedId = requestedIdRaw.trim();

  if (!name) {
    return res.status(400).json({ success: false, message: 'name 값이 필요합니다.' });
  }

  if (db.isEnabled()) {
    return createRoomInDb({ name, icalUrl, userId })
      .then((row) => {
        if (!row) return res.status(500).json({ success: false, message: '객실 생성에 실패했습니다.' });
        const room = mapRoomRowToApi(row);
        return res.status(201).json({
          success: true,
          room,
          totalSavedAmount: Number(row?.total_saved_amount ?? 0) || 0,
          rooms: [room],
        });
      })
      .catch(() => res.status(500).json({ success: false, message: 'DB에 객실을 생성하지 못했습니다.' }));
  }

  let id = requestedId;
  if (id) {
    if (getRoomById(id)) {
      return res.status(409).json({ success: false, message: '이미 존재하는 객실 id 입니다.' });
    }
  } else {
    const used = new Set(mockDb.rooms.map((r) => String(r.id)));
    let n = 1;
    while (used.has(`r${n}`)) n += 1;
    id = `r${n}`;
  }

  const room = {
    id,
    name,
    status: 'Vacant',
    isPowerOn: false,
    icalUrl: icalUrl || null,
    ac: {
      power: false,
      currentTemp: 26,
      targetTemp: 28,
      mode: 'COOL',
      aiMode: 'SAVING',
    },
  };

  mockDb.rooms.push(room);

  return res.status(201).json({
    success: true,
    room,
    totalSavedAmount: mockDb.totalSavedAmount,
    rooms: mockDb.rooms,
  });
};

exports.setRoomIcalUrl = (req, res) => {
  const roomId = req.params.id?.toString() ?? '';
  const raw = req.body?.icalUrl?.toString() ?? '';
  const icalUrl = raw.trim();
  const checkoutHour = req.body?.checkoutHour;
  const checkoutMinute = req.body?.checkoutMinute;
  const cleaningHours = req.body?.cleaningHours;

  if (db.isEnabled()) {
    return updateRoomCalendarInDb({
      roomId,
      icalUrl,
      checkoutHour,
      checkoutMinute,
      cleaningHours,
    })
      .then((result) => {
        if (!result.ok) {
          if (result.reason === 'NOT_FOUND') {
            return res.status(404).json({ success: false, message: '객실을 찾을 수 없습니다.' });
          }
          return res.status(400).json({ success: false, message: 'roomId가 올바르지 않습니다.' });
        }
        return res.status(200).json({ success: true });
      })
      .catch(() => res.status(500).json({ success: false, message: 'DB에 캘린더 설정을 저장하지 못했습니다.' }));
  }

  const room = getRoomById(roomId);
  if (!room) {
    return res.status(404).json({ success: false, message: '객실을 찾을 수 없습니다.' });
  }

  room.icalUrl = icalUrl || null;
  room.checkoutHour = clampHour(checkoutHour, 11);
  room.checkoutMinute = clampMinute(checkoutMinute, 0);
  room.cleaningHours = clampCleaningHours(cleaningHours, 2);

  return res.status(200).json({ success: true, room });
};

exports.listDevices = (req, res) => {
  return res.status(200).json({
    success: true,
    devices: listIndustryDevices(),
  });
};

exports.getRecommendedDevices = (req, res) => {
  const market = detectMarket(req);
  return res.status(200).json({
    success: true,
    market,
    devices: listRecommendedDevices(market),
  });
};

exports.trackAffiliateClick = (req, res) => {
  const market = detectMarket(req);
  const productId = req.body?.productId?.toString() ?? '';
  const source = req.body?.source?.toString() ?? 'unknown';
  const kind = req.body?.kind?.toString() ?? '';

  if (!productId) {
    return res.status(400).json({ success: false, message: 'productId 값이 필요합니다.' });
  }

  const ts = new Date().toISOString();
  const entry = {
    ts,
    market,
    productId,
    kind,
    source,
    ua: req.headers?.['user-agent']?.toString() ?? '',
  };

  appendAffiliateClickEvent(entry);
  console.log(`[AffiliateClick] ${JSON.stringify(entry)}`);

  return res.status(200).json({ success: true });
};

exports.getAffiliateStats = (req, res) => {
  if (!isAuthorizedAdmin(req)) {
    return res.status(403).json({ success: false, message: '접근 권한이 없습니다.' });
  }

  const stats = Array.from(affiliateClickStats.values()).sort((a, b) => b.clicks - a.clicks);
  return res.status(200).json({
    success: true,
    stats,
    lastEvents: affiliateClickEvents.slice(-50),
  });
};

exports.startCheckout = (req, res) => {
  const provider = req.body?.provider?.toString()?.toLowerCase?.() ?? '';
  const tier = normalizeTier(req.body?.tier?.toString() ?? 'PRO');

  if (!provider) {
    return res.status(400).json({ success: false, message: 'provider 값이 필요합니다.' });
  }

  const checkoutId = randomId();
  const createdAt = new Date().toISOString();
  const session = {
    checkoutId,
    provider,
    tier,
    status: 'PENDING',
    createdAt,
    updatedAt: createdAt,
    transactionId: null,
    token: null,
    exp: null,
  };
  checkoutSessions.set(checkoutId, session);

  return res.status(200).json({
    success: true,
    checkoutId,
    tier,
    provider,
    status: session.status,
    pollUrl: `/api/v1/checkout/${checkoutId}`,
    webhookUrl: `/api/v1/webhooks/payment`,
    requiredMetadata: { checkoutId },
  });
};

exports.getCheckoutStatus = (req, res) => {
  const checkoutId = req.params.checkoutId?.toString() ?? '';
  const session = checkoutSessions.get(checkoutId);
  if (!session) return res.status(404).json({ success: false, message: 'checkoutId를 찾을 수 없습니다.' });

  return res.status(200).json({
    success: true,
    checkoutId: session.checkoutId,
    provider: session.provider,
    tier: session.tier,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    transactionId: session.transactionId,
    token: session.status === 'PAID' ? session.token : null,
    exp: session.status === 'PAID' ? session.exp : null,
  });
};

exports.paymentWebhook = async (req, res) => {
  const explicitProvider = req.body?.provider?.toString()?.toLowerCase?.() ?? '';
  const inferredProvider = req.body?.signedPayload
    ? 'appstore'
    : req.headers?.['paypal-transmission-id']
      ? 'paypal'
      : req.headers?.['tosspayments-webhook-signature']
        ? 'toss'
        : '';
  const provider = explicitProvider || inferredProvider;

  let verified = { ok: false, reason: 'UNKNOWN_PROVIDER' };
  let applePayload = null;
  try {
    if (provider === 'toss') {
      verified = verifyTossWebhook(req);
    } else if (provider === 'paypal') {
      verified = await verifyPayPalWebhook(req);
    } else if (provider === 'appstore') {
      const signedPayload = req.body?.signedPayload?.toString() ?? '';
      const result = verifyAppleJwsAndDecodePayload(signedPayload);
      verified = result.ok ? { ok: true } : { ok: false, reason: result.reason };
      applePayload = result.ok ? result.payload : null;
    } else {
      verified = verifyWebhookAuth(req);
    }
  } catch (error) {
    const message = typeof error?.message === 'string' ? error.message : 'UNKNOWN_ERROR';
    verified = { ok: false, reason: message };
  }

  if (!verified.ok) {
    return res.status(401).json({ success: false, reason: verified.reason });
  }

  let eventType = req.body?.eventType?.toString()?.toUpperCase?.() ?? '';
  let checkoutId = req.body?.checkoutId?.toString() ?? '';
  let transactionId = req.body?.transactionId?.toString() ?? null;
  let tier = normalizeTier(req.body?.tier?.toString() ?? 'PRO');
  let days = Number(req.body?.days ?? 3650);

  if (provider === 'toss') {
    const statusRaw =
      req.body?.status?.toString() ??
      req.body?.data?.status?.toString() ??
      '';
    const status = statusRaw.toUpperCase();
    const tossEventType = req.body?.eventType?.toString()?.toUpperCase?.() ?? '';
    eventType =
      status === 'DONE' || status === 'PAID' || status === 'COMPLETED'
        ? 'PAYMENT_SUCCEEDED'
        : status === 'CANCELED' || status === 'FAILED' || status === 'ABORTED' || status === 'EXPIRED'
          ? 'PAYMENT_FAILED'
          : tossEventType || 'UNKNOWN';
    checkoutId =
      req.body?.checkoutId?.toString() ??
      req.body?.orderId?.toString() ??
      req.body?.data?.orderId?.toString() ??
      checkoutId;
    transactionId =
      req.body?.paymentKey?.toString() ??
      req.body?.data?.paymentKey?.toString() ??
      transactionId;
  } else if (provider === 'paypal') {
    const paypalEventType = req.body?.event_type?.toString()?.toUpperCase?.() ?? '';
    eventType =
      paypalEventType === 'BILLING.SUBSCRIPTION.ACTIVATED' ||
      paypalEventType === 'PAYMENT.SALE.COMPLETED' ||
      paypalEventType === 'CHECKOUT.ORDER.APPROVED'
        ? 'SUBSCRIPTION_ACTIVATED'
        : paypalEventType === 'BILLING.SUBSCRIPTION.CANCELLED' ||
            paypalEventType === 'BILLING.SUBSCRIPTION.SUSPENDED' ||
            paypalEventType === 'BILLING.SUBSCRIPTION.EXPIRED'
          ? 'SUBSCRIPTION_CANCELED'
          : paypalEventType || 'UNKNOWN';
    checkoutId =
      req.body?.resource?.custom_id?.toString() ??
      req.body?.resource?.custom?.toString() ??
      checkoutId;
    transactionId = req.body?.id?.toString() ?? req.body?.resource?.id?.toString() ?? transactionId;
  } else if (provider === 'appstore') {
    const notificationType = applePayload?.notificationType?.toString()?.toUpperCase?.() ?? '';
    eventType =
      notificationType === 'SUBSCRIBED' ||
      notificationType === 'DID_RENEW' ||
      notificationType === 'DID_RECOVER'
        ? 'SUBSCRIPTION_ACTIVATED'
        : notificationType === 'CANCEL' ||
            notificationType === 'DID_FAIL_TO_RENEW' ||
            notificationType === 'EXPIRED'
          ? 'SUBSCRIPTION_CANCELED'
          : notificationType || 'UNKNOWN';

    const txInfo = decodeAppleJwsPayload(applePayload?.data?.signedTransactionInfo);
    checkoutId = txInfo?.appAccountToken?.toString?.() ?? checkoutId;
    transactionId =
      txInfo?.transactionId?.toString?.() ??
      txInfo?.originalTransactionId?.toString?.() ??
      applePayload?.notificationUUID?.toString?.() ??
      transactionId;
  }

  if (!provider || !eventType) {
    return res.status(400).json({ success: false, message: 'provider/eventType 값을 확인할 수 없습니다.' });
  }

  if (!Number.isFinite(days)) days = 3650;
  const exp = Date.now() + Math.max(1, days) * 24 * 60 * 60 * 1000;
  const now = new Date().toISOString();
  const session = checkoutId ? checkoutSessions.get(checkoutId) : null;

  if (eventType === 'PAYMENT_SUCCEEDED' || eventType === 'SUBSCRIPTION_ACTIVATED') {
    const token = issueLicenseToken({ tier, exp });
    if (!token) {
      return res.status(500).json({ success: false, message: 'LICENSE_SECRET이 필요합니다.' });
    }

    if (session) {
      session.status = 'PAID';
      session.updatedAt = now;
      session.transactionId = transactionId;
      session.token = token;
      session.exp = exp;
      checkoutSessions.set(session.checkoutId, session);
    }

    console.log(
      `[PaymentWebhook] ${JSON.stringify({ provider, eventType, checkoutId, tier, transactionId, ts: now })}`,
    );
    return res.status(200).json({ success: true });
  }

  if (eventType === 'PAYMENT_FAILED' || eventType === 'SUBSCRIPTION_CANCELED') {
    if (session) {
      session.status = 'FAILED';
      session.updatedAt = now;
      session.transactionId = transactionId;
      checkoutSessions.set(session.checkoutId, session);
    }
    console.log(`[PaymentWebhook] ${JSON.stringify({ provider, eventType, checkoutId, transactionId, ts: now })}`);
    return res.status(200).json({ success: true });
  }

  console.log(`[PaymentWebhook] ${JSON.stringify({ provider, eventType, checkoutId, transactionId, ts: now })}`);
  return res.status(200).json({ success: true });
};

exports.getSubscriptionStatus = (req, res) => {
  return res.status(200).json({
    success: true,
    status: buildSubscriptionStatus(subscriptionTier),
  });
};

exports.getSubscriptionPlans = (req, res) => {
  return res.status(200).json({
    success: true,
    plans: [
      {
        tier: 'FREE',
        priceMonthlyUsd: 0,
        limits: { maxRooms: 1 },
        features: {
          aiPrecooling: false,
          peakDefense: false,
          powerReports: false,
          multiProperty: false,
        },
      },
      {
        tier: 'PRO',
        priceMonthlyUsd: 9.99,
        limits: { maxRooms: null },
        features: {
          aiPrecooling: true,
          peakDefense: true,
          powerReports: true,
          multiProperty: false,
        },
      },
      {
        tier: 'ENTERPRISE',
        priceMonthlyUsd: null,
        limits: { maxRooms: null },
        features: {
          aiPrecooling: true,
          peakDefense: true,
          powerReports: true,
          multiProperty: true,
        },
      },
    ],
  });
};

exports.mockUpgradeToPro = (req, res) => {
  if (!isAuthorizedAdmin(req)) {
    return res.status(403).json({ success: false, message: '접근 권한이 없습니다.' });
  }
  subscriptionTier = 'PRO';
  return res.status(200).json({
    success: true,
    status: buildSubscriptionStatus(subscriptionTier),
  });
};

exports.issueSubscriptionToken = (req, res) => {
  if (!isAuthorizedAdmin(req)) {
    return res.status(403).json({ success: false, message: '접근 권한이 없습니다.' });
  }
  const tier = req.body?.tier?.toString() ?? 'PRO';
  const days = Number(req.body?.days ?? 3650);
  const exp = Number.isFinite(days) ? Date.now() + Math.max(1, days) * 24 * 60 * 60 * 1000 : null;
  const token = issueLicenseToken({ tier, exp });
  if (!token) {
    return res.status(500).json({ success: false, message: 'LICENSE_SECRET이 필요합니다.' });
  }
  return res.status(200).json({ success: true, token, tier: normalizeTier(tier), exp });
};

exports.redeemSubscriptionToken = (req, res) => {
  const token = req.body?.token?.toString() ?? '';
  const verified = verifyLicenseToken(token);
  if (!verified.ok) {
    return res.status(400).json({ success: false, reason: verified.reason });
  }
  subscriptionTier = verified.tier;
  return res.status(200).json({
    success: true,
    status: buildSubscriptionStatus(subscriptionTier),
  });
};

exports.getDeviceStatus = (req, res) => {
  const deviceId = req.params.deviceId;
  const status = getDeviceStatus(deviceId);
  if (!status) return res.status(404).json({ success: false });
  return res.status(200).json({ success: true, status });
};

function buildStHeaders(interactionType, requestId) {
  return {
    schema: 'st-schema',
    version: '1.0',
    interactionType,
    requestId,
  };
}

function parseExternalDeviceId(externalDeviceId) {
  const raw = externalDeviceId?.toString() ?? '';
  const [roomId, suffix] = raw.split('-', 2);
  if (!roomId || !suffix) return null;
  if (suffix === 'ac') return { kind: 'ac', roomId };
  if (suffix === 'plug') return { kind: 'plug', roomId };
  return null;
}

function getAgentIdForExternalDeviceId(externalDeviceId) {
  const parsed = parseExternalDeviceId(externalDeviceId);
  return parsed?.roomId ?? '';
}

function isAgentConnected(req, agentId) {
  const hasAgent = req.app?.locals?.bridge?.hasAgent;
  if (typeof hasAgent !== 'function') return true;
  if (!agentId) return false;
  return hasAgent(agentId) === true;
}

function sendToLocalAgent(req, agentId, message) {
  const sendToAgent = req.app?.locals?.bridge?.sendToAgent;
  if (typeof sendToAgent !== 'function') return true;
  if (!agentId) return false;
  return sendToAgent(agentId, message) === true;
}

function buildStatesForExternalDevice(externalDeviceId, online) {
  const parsed = parseExternalDeviceId(externalDeviceId);
  if (!parsed) return null;

  const room = getRoomById(parsed.roomId);
  if (!room) return null;

  const ts = Date.now();
  const states = [];

  states.push({
    component: 'main',
    capability: 'st.healthCheck',
    attribute: 'healthStatus',
    value: online ? 'online' : 'offline',
    timestamp: ts,
  });

  if (!online) return states;

  if (parsed.kind === 'plug') {
    states.push({
      component: 'main',
      capability: 'st.switch',
      attribute: 'switch',
      value: room.isPowerOn ? 'on' : 'off',
      timestamp: ts,
    });
    return states;
  }

  if (parsed.kind === 'ac') {
    const ac = ensureAc(room);
    states.push({
      component: 'main',
      capability: 'st.switch',
      attribute: 'switch',
      value: ac.power ? 'on' : 'off',
      timestamp: ts,
    });
    states.push({
      component: 'main',
      capability: 'st.temperatureMeasurement',
      attribute: 'temperature',
      value: Number(ac.currentTemp),
      unit: 'C',
      timestamp: ts,
    });
    states.push({
      component: 'main',
      capability: 'st.thermostatCoolingSetpoint',
      attribute: 'coolingSetpoint',
      value: Number(ac.targetTemp),
      unit: 'C',
      timestamp: ts,
    });
    return states;
  }

  return null;
}

function buildBridgeControlMessage(externalDeviceId, cmd, requestId) {
  const capability = cmd?.capability?.toString() ?? '';
  const name = cmd?.command?.toString() ?? '';
  const args = Array.isArray(cmd?.arguments) ? cmd.arguments : [];

  if (capability === 'st.switch') {
    if (name !== 'on' && name !== 'off') return null;
    return {
      type: 'IOT_CONTROL',
      ts: new Date().toISOString(),
      requestId,
      deviceId: externalDeviceId,
      action: 'SET_POWER',
      value: name === 'on',
    };
  }

  if (capability === 'st.thermostatCoolingSetpoint') {
    if (name !== 'setCoolingSetpoint') return null;
    const n = Number(args?.[0]);
    if (!Number.isFinite(n)) return null;
    return {
      type: 'IOT_CONTROL',
      ts: new Date().toISOString(),
      requestId,
      deviceId: externalDeviceId,
      action: 'SET_TEMP',
      value: n,
    };
  }

  return null;
}

async function applyStCommand(externalDeviceId, command) {
  const parsed = parseExternalDeviceId(externalDeviceId);
  if (!parsed) return { ok: false, reason: 'INVALID_DEVICE_ID' };
  const room = getRoomById(parsed.roomId);
  if (!room) return { ok: false, reason: 'DEVICE_NOT_FOUND' };

  const capability = command?.capability?.toString() ?? '';
  const name = command?.command?.toString() ?? '';
  const args = Array.isArray(command?.arguments) ? command.arguments : [];

  if (capability === 'st.switch') {
    const on = name === 'on';
    const off = name === 'off';
    if (!on && !off) return { ok: false, reason: 'UNSUPPORTED_SWITCH_COMMAND' };
    if (parsed.kind === 'ac') {
      ensureAc(room).power = on;
      return { ok: true };
    }
    if (parsed.kind === 'plug') {
      room.isPowerOn = on;
      return { ok: true };
    }
    return { ok: false, reason: 'UNSUPPORTED_DEVICE_KIND' };
  }

  if (capability === 'st.thermostatCoolingSetpoint') {
    if (parsed.kind !== 'ac') return { ok: false, reason: 'UNSUPPORTED_DEVICE_KIND' };
    if (name !== 'setCoolingSetpoint') return { ok: false, reason: 'UNSUPPORTED_SETPOINT_COMMAND' };
    const n = Number(args?.[0]);
    if (!Number.isFinite(n)) return { ok: false, reason: 'INVALID_ARGUMENT' };
    await setAirConTemperatureInternal(parsed.roomId, n, null);
    return { ok: true };
  }

  return { ok: false, reason: 'UNSUPPORTED_CAPABILITY' };
}

exports.smartThingsWebhook = async (req, res) => {
  const requestHeaders = (req.body && typeof req.body === 'object' ? req.body.headers : null) ?? {};
  const requestId = requestHeaders.requestId?.toString() ?? '';
  const interactionType = requestHeaders.interactionType?.toString() ?? '';

  if (interactionType === 'discoveryRequest') {
    const devices = [];
    for (const room of mockDb.rooms) {
      devices.push({
        externalDeviceId: `${room.id}-ac`,
        friendlyName: `ONYX AI 에어컨 (${room.name})`,
        deviceHandlerType: 'c2c-air-conditioner',
        deviceUniqueId: `${room.id}-ac-001`,
        manufacturerInfo: {
          modelName: 'ONYX-AC-V1',
          manufacturerName: 'ONYX AI Host',
        },
        deviceContext: {
          roomName: room.name,
          groups: ['에어비앤비 본점'],
        },
      });

      devices.push({
        externalDeviceId: `${room.id}-plug`,
        friendlyName: `ONYX AI 스마트 플러그 (${room.name})`,
        deviceHandlerType: 'c2c-smart-plug',
        deviceUniqueId: `${room.id}-plug-001`,
        manufacturerInfo: {
          modelName: 'ONYX-Plug-S1',
          manufacturerName: 'ONYX AI Host',
        },
        deviceContext: {
          roomName: room.name,
          groups: ['에어비앤비 본점'],
        },
      });
    }

    return res.status(200).json({
      headers: buildStHeaders('discoveryResponse', requestId),
      requestGrantCallbackAccess: true,
      devices,
    });
  }

  if (interactionType === 'stateRefreshRequest') {
    const requestedDevices = Array.isArray(req.body?.devices) ? req.body.devices : [];
    const deviceState = [];
    for (const entry of requestedDevices) {
      const externalDeviceId = entry?.externalDeviceId?.toString() ?? '';
      const agentId = getAgentIdForExternalDeviceId(externalDeviceId);
      const online = isAgentConnected(req, agentId);
      const states = buildStatesForExternalDevice(externalDeviceId, online);
      if (!states) {
        deviceState.push({
          externalDeviceId,
          deviceError: [{ errorEnum: 'DEVICE-DELETED', detail: 'device not found' }],
        });
        continue;
      }
      deviceState.push({ externalDeviceId, states });
    }

    return res.status(200).json({
      headers: buildStHeaders('stateRefreshResponse', requestId),
      deviceState,
    });
  }

  if (interactionType === 'commandRequest') {
    const requestedDevices = Array.isArray(req.body?.devices) ? req.body.devices : [];
    const deviceState = [];

    for (const device of requestedDevices) {
      const externalDeviceId = device?.externalDeviceId?.toString() ?? '';
      const commands = Array.isArray(device?.commands) ? device.commands : [];

      const agentId = getAgentIdForExternalDeviceId(externalDeviceId);
      if (agentId && !isAgentConnected(req, agentId)) {
        deviceState.push({
          externalDeviceId,
          deviceError: [{ errorEnum: 'DEVICE-OFFLINE', detail: `agent_not_connected:${agentId}` }],
        });
        continue;
      }

      let hadError = false;
      for (const cmd of commands) {
        const control = buildBridgeControlMessage(externalDeviceId, cmd, requestId);
        if (!control) {
          hadError = true;
          break;
        }

        if (agentId) {
          const sent = sendToLocalAgent(req, agentId, control);
          if (!sent) {
            deviceState.push({
              externalDeviceId,
              deviceError: [{ errorEnum: 'DEVICE-OFFLINE', detail: `agent_send_failed:${agentId}` }],
            });
            hadError = true;
            break;
          }
        }

        const result = await applyStCommand(externalDeviceId, cmd);
        if (!result.ok) {
          hadError = true;
          break;
        }
      }

      if (hadError) {
        if (!deviceState.some((d) => d.externalDeviceId === externalDeviceId)) {
          deviceState.push({
            externalDeviceId,
            deviceError: [{ errorEnum: 'CAPABILITY-NOT-SUPPORTED', detail: 'unsupported command' }],
          });
        }
        continue;
      }

      const states = buildStatesForExternalDevice(externalDeviceId, true);
      if (!states) {
        deviceState.push({
          externalDeviceId,
          deviceError: [{ errorEnum: 'DEVICE-DELETED', detail: 'device not found' }],
        });
        continue;
      }
      deviceState.push({ externalDeviceId, states });
    }

    return res.status(200).json({
      headers: buildStHeaders('commandResponse', requestId),
      deviceState,
    });
  }

  if (interactionType === 'integrationDeleted') {
    return res.status(200).json({ headers: buildStHeaders('integrationDeleted', requestId) });
  }

  return res.status(200).json({
    headers: buildStHeaders('interactionResult', requestId),
    originatingInteractionType: interactionType,
    globalError: { errorEnum: 'INVALID-INTERACTION-TYPE', detail: 'unsupported interactionType' },
    deviceState: [],
  });
};

exports.sendDeviceCommand = async (req, res) => {
  const deviceId = req.params.deviceId;
  const command = req.body?.command?.toString() ?? '';
  const payload = req.body?.payload ?? {};

  if (!deviceId || !command) {
    return res.status(400).json({ success: false, message: 'deviceId/command 값이 필요합니다.' });
  }

  if (deviceId === 'gateway-main') {
    if (command === 'SET_ONLINE') {
      deviceState.gatewayOnline = payload?.online === true;
      appendDeviceLog({
        ts: new Date().toISOString(),
        deviceId,
        event: 'SET_ONLINE',
        payload: { online: deviceState.gatewayOnline },
      });
      return res.status(200).json({ success: true, status: getDeviceStatus(deviceId) });
    }
    return res.status(400).json({ success: false, message: '지원하지 않는 명령입니다.' });
  }

  const [kind, roomId] = String(deviceId).split('-', 2);
  const room = getRoomById(roomId);
  if (!room) return res.status(404).json({ success: false });

  if (kind === 'ac') {
    if (command === 'SET_POWER') {
      ensureAc(room).power = payload?.power === true;
      appendDeviceLog({
        ts: new Date().toISOString(),
        deviceId,
        event: 'SET_POWER',
        payload: { power: ensureAc(room).power },
      });
      return res.status(200).json({ success: true, status: getDeviceStatus(deviceId) });
    }

    if (command === 'SET_TARGET_TEMP') {
      const n = Number(payload?.targetTemp);
      if (!Number.isFinite(n)) {
        return res.status(400).json({ success: false, message: 'payload.targetTemp(number) 값이 필요합니다.' });
      }
      const aiMode = payload?.aiMode ? String(payload.aiMode) : null;
      await setAirConTemperatureInternal(roomId, n, aiMode);
      return res.status(200).json({ success: true, status: getDeviceStatus(deviceId) });
    }

    return res.status(400).json({ success: false, message: '지원하지 않는 명령입니다.' });
  }

  if (kind === 'breaker') {
    if (command === 'SET_POWER') {
      room.isPowerOn = payload?.power === true;
      appendDeviceLog({
        ts: new Date().toISOString(),
        deviceId,
        event: 'SET_POWER',
        payload: { power: room.isPowerOn },
      });
      return res.status(200).json({ success: true, status: getDeviceStatus(deviceId) });
    }
    return res.status(400).json({ success: false, message: '지원하지 않는 명령입니다.' });
  }

  if (kind === 'irhub') {
    if (command === 'SEND_IR') {
      const irCommand = payload?.irCommand?.toString() ?? '';
      if (!irCommand) {
        return res.status(400).json({ success: false, message: 'payload.irCommand 값이 필요합니다.' });
      }
      deviceState.irLastCommandByRoomId[roomId] = irCommand;
      appendDeviceLog({
        ts: new Date().toISOString(),
        deviceId,
        event: 'SEND_IR',
        payload: { irCommand },
      });
      return res.status(200).json({ success: true, status: getDeviceStatus(deviceId) });
    }
    return res.status(400).json({ success: false, message: '지원하지 않는 명령입니다.' });
  }

  return res.status(404).json({ success: false });
};

exports.receiveDeviceStatusWebhook = (req, res) => {
  const deviceId = req.body?.deviceId?.toString() ?? '';
  const eventType = req.body?.eventType?.toString() ?? 'STATUS';
  const payload = req.body?.payload ?? {};

  if (!deviceId) {
    return res.status(400).json({ success: false, message: 'deviceId 값이 필요합니다.' });
  }

  appendDeviceEvent({
    ts: new Date().toISOString(),
    deviceId,
    eventType,
    payload,
  });

  const [kind, roomId] = String(deviceId).split('-', 2);
  const room = roomId ? getRoomById(roomId) : null;

  if (deviceId === 'gateway-main' && typeof payload?.online === 'boolean') {
    deviceState.gatewayOnline = payload.online;
  } else if (room && kind === 'ac') {
    const ac = ensureAc(room);
    if (typeof payload?.power === 'boolean') ac.power = payload.power;
    if (Number.isFinite(Number(payload?.currentTemp))) ac.currentTemp = Number(payload.currentTemp);
    if (Number.isFinite(Number(payload?.targetTemp))) ac.targetTemp = Number(payload.targetTemp);
    if (payload?.mode) ac.mode = String(payload.mode);
    if (payload?.aiMode) ac.aiMode = String(payload.aiMode);
  } else if (room && kind === 'breaker') {
    if (typeof payload?.isPowerOn === 'boolean') room.isPowerOn = payload.isPowerOn;
  }

  return res.status(200).json({ success: true });
};

exports.getDeviceLogs = (req, res) => {
  const deviceId = req.params.deviceId;
  const limit = Math.min(200, Math.max(1, Number(req.query?.limit ?? 50)));
  const logs = deviceLogs.filter((l) => l.deviceId === deviceId).slice(-limit);
  return res.status(200).json({ success: true, logs });
};

exports.getRealtimeEnergy = (req, res) => {
  const roomId = req.query?.roomId?.toString() ?? '';
  if (!roomId) {
    return res.status(400).json({ success: false, message: 'roomId 값이 필요합니다.' });
  }
  const status = getDeviceStatus(buildDeviceId('breaker', roomId));
  if (!status) return res.status(404).json({ success: false });
  return res.status(200).json({ success: true, watts: status.watts, roomId });
};

exports.getDeviceLocation = (req, res) => {
  const roomId = req.params.id;
  const room = getRoomById(roomId);
  if (!room) return res.status(404).json({ success: false });
  return res.status(200).json({
    success: true,
    location: {
      roomId,
      timezone: process.env.PROPERTY_TIMEZONE ?? 'Asia/Seoul',
    },
  });
};

exports.listBridgeAgents = (req, res) => {
  const list = req.app?.locals?.bridge?.listConnectedAgents?.() ?? [];
  return res.status(200).json({ success: true, agents: list });
};

exports.sendBridgeCommand = (req, res) => {
  const agentId = req.params.agentId?.toString() ?? '';
  if (!agentId) return res.status(400).json({ success: false, message: 'agentId 값이 필요합니다.' });

  const required = process.env.BRIDGE_TOKEN ?? '';
  const token =
    req.headers['x-bridge-token']?.toString() ??
    (req.headers['authorization']?.toString().startsWith('Bearer ')
      ? req.headers['authorization'].toString().slice('Bearer '.length)
      : '');

  if (required && token !== required) {
    return res.status(403).json({ success: false, message: '접근 권한이 없습니다.' });
  }

  const payload = req.body ?? {};
  const ok = req.app?.locals?.bridge?.sendToAgent?.(agentId, {
    type: 'COMMAND',
    ts: new Date().toISOString(),
    payload,
  });

  if (!ok) return res.status(503).json({ success: false, message: '에이전트가 연결되어 있지 않습니다.' });
  return res.status(200).json({ success: true });
};

exports.toggleDevicePower = (req, res) => {
  const roomId = req.params.id;
  const { isPowerOn } = req.body ?? {};

  if (typeof isPowerOn !== 'boolean') {
    return res.status(400).json({
      success: false,
      message: 'isPowerOn(boolean) 값이 필요합니다.',
    });
  }

  const room = mockDb.rooms.find((r) => r.id === roomId);
  if (!room) {
    return res.status(404).json({ success: false, message: '객실을 찾을 수 없습니다.' });
  }

  room.isPowerOn = isPowerOn;

  if (room.status === 'Vacant' && isPowerOn === false) {
    mockDb.totalSavedAmount += 0.5;
  }

  console.log(`[IoT Command] ${room.name} 전원: ${isPowerOn ? 'ON' : 'OFF'}`);

  return res.status(200).json({
    success: true,
    message: '기기 상태가 변경되었습니다.',
    room,
    newTotalSavedAmount: mockDb.totalSavedAmount,
  });
};

exports.syncCalendarAndAutomate = async (req, res) => {
  const roomId = req.params.id;
  const room = mockDb.rooms.find((r) => r.id === roomId);

  if (!room) {
    return res.status(404).json({ success: false, message: '객실을 찾을 수 없습니다.' });
  }

  try {
    let isTodayBooked = false;

    if (isHttpUrl(room.icalUrl)) {
      const parsed = await ical.async.fromURL(room.icalUrl);
      isTodayBooked = isTodayBookedFromEvents(parsed);
    }

    if (!isTodayBooked && room.status !== 'Vacant') {
      room.status = 'Vacant';
    }

    if (!isTodayBooked && room.status === 'Vacant' && room.isPowerOn) {
      room.isPowerOn = false;
      mockDb.totalSavedAmount += 1.2;
      console.log(`[AI Auto-Action] ${room.name} 빈 객실 감지. 대기전력 자동 차단.`);
    }

    return res.status(200).json({
      success: true,
      message: '캘린더 동기화 및 AI 자동화가 완료되었습니다.',
      room,
      totalSavedAmount: mockDb.totalSavedAmount,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: '캘린더 동기화 실패' });
  }
};

exports.getAirConStatus = (req, res) => {
  const room = mockDb.rooms.find((r) => r.id === req.params.id);
  if (!room) return res.status(404).json({ success: false });
  return res.status(200).json({ success: true, ac: ensureAc(room) });
};

exports.setAirConTemperature = (req, res) => {
  const { id } = req.params;
  const { targetTemp, aiMode } = req.body ?? {};

  const n = Number(targetTemp);
  if (!Number.isFinite(n)) {
    return res.status(400).json({ success: false, message: 'targetTemp(number) 값이 필요합니다.' });
  }

  const room = mockDb.rooms.find((r) => r.id === id);
  if (!room) return res.status(404).json({ success: false });

  ensureAc(room).targetTemp = n;
  if (aiMode) ensureAc(room).aiMode = String(aiMode);

  console.log(`[Mock IoT] ${room.name} 에어컨 온도를 ${n}도로 설정했습니다. (모드: ${aiMode ?? ensureAc(room).aiMode})`);
  return res.status(200).json({ success: true, ac: ensureAc(room) });
};

exports.regulateAllAirCons = async (req, res) => {
  const options = {
    tempNormal: readNumberEnv('TEMP_NORMAL', 24),
    tempPrecool: readNumberEnv('TEMP_PRECOOL', 21),
    tempPeak: readNumberEnv('TEMP_PEAK', 26),
    tempVacant: readNumberEnv('TEMP_VACANT', 28),
    priceHighMultiplier: readNumberEnv('PRICE_THRESHOLD_HIGH_MULTIPLIER', 1.2),
    priceHighAbsolute: readNumberEnv('PRICE_THRESHOLD_HIGH_ABSOLUTE', 150),
  };

  const results = [];
  for (const room of mockDb.rooms) {
    results.push(await regulateAirConTemperature(room.id, options));
  }

  return res.status(200).json({
    success: true,
    options,
    results,
    rooms: mockDb.rooms,
  });
};
