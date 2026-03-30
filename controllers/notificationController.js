const tokenStore = new Map();
const db = require('../db');

let messagingClient = null;

function readServiceAccountJsonText() {
  const b64 = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 ?? '').toString().trim();
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON ?? '').toString().trim();
  if (raw) return raw;
  if (!b64) return '';
  try {
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch (_) {
    return '';
  }
}

function getMessagingClient() {
  if (messagingClient) return messagingClient;

  const jsonText = readServiceAccountJsonText();
  if (!jsonText) return null;

  let serviceAccount = null;
  try {
    serviceAccount = JSON.parse(jsonText);
  } catch (_) {
    return null;
  }

  const { initializeApp, cert, getApps } = require('firebase-admin/app');
  const { getMessaging } = require('firebase-admin/messaging');

  if (getApps().length === 0) {
    initializeApp({ credential: cert(serviceAccount) });
  }

  messagingClient = getMessaging();
  return messagingClient;
}

function getLocalHour(timeZone, now = new Date()) {
  const tz = (timeZone ?? '').toString().trim();
  if (!tz) return null;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const hourPart = parts.find((p) => p.type === 'hour')?.value ?? '';
  const hour = Number.parseInt(hourPart, 10);
  return Number.isFinite(hour) ? hour : null;
}

function isAllowedPushTime(timeZone) {
  const hour = getLocalHour(timeZone);
  if (hour == null) return true;
  return hour >= 9 && hour < 21;
}

function buildPeakAlert(region, savedAmount) {
  const r = (region ?? '').toString().trim().toUpperCase();
  const amount = Number(savedAmount ?? 0);
  if (r === 'UK' || r === 'GB' || r === 'UK_LONDON') {
    return {
      title: '⚡ Peak Time Saved!',
      body: `AI reduced AC power. Estimated saving: £${amount.toFixed(2)}`,
    };
  }
  if (r === 'US' || r === 'TX' || r === 'US_TX') {
    return {
      title: '⚡ Peak Time Saved!',
      body: `AI reduced AC power. Estimated saving: $${amount.toFixed(2)}`,
    };
  }
  return {
    title: '⚡ 피크 타임 방어 성공!',
    body: `AI가 에어컨 전력을 제어했습니다. 예상 절감액: ₩${Math.round(amount).toString()}`,
  };
}

function isUuidText(text) {
  const s = (text ?? '').toString().trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

async function upsertUserToken({ userIdOrEmail, token, timeZone }) {
  if (!db.isEnabled()) return { ok: false, reason: 'DB_NOT_ENABLED' };
  const idOrEmail = (userIdOrEmail ?? '').toString().trim();
  if (!idOrEmail || !token) return { ok: false, reason: 'INVALID_INPUT' };

  if (idOrEmail.includes('@')) {
    await db.query(
      `INSERT INTO users (email, fcm_token, created_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (email)
       DO UPDATE SET fcm_token = EXCLUDED.fcm_token`,
      [idOrEmail, token],
    );
    return { ok: true, key: 'email', value: idOrEmail };
  }

  if (isUuidText(idOrEmail)) {
    const updated = await db.query(
      `UPDATE users SET fcm_token = $2 WHERE id = $1`,
      [idOrEmail, token],
    );
    if ((updated.rowCount ?? 0) > 0) return { ok: true, key: 'id', value: idOrEmail };
    return { ok: false, reason: 'USER_NOT_FOUND' };
  }

  return { ok: false, reason: 'UNSUPPORTED_USER_ID' };
}

async function resolveTokenByUserIdOrEmail(userIdOrEmail) {
  const key = (userIdOrEmail ?? '').toString().trim();
  if (!key) return '';
  const cached = tokenStore.get(key);
  if (cached?.token) return cached.token;

  if (!db.isEnabled()) return '';

  if (key.includes('@')) {
    const result = await db.query(`SELECT fcm_token FROM users WHERE email = $1 LIMIT 1`, [key]);
    return (result.rows?.[0]?.fcm_token ?? '').toString();
  }

  if (isUuidText(key)) {
    const result = await db.query(`SELECT fcm_token FROM users WHERE id = $1 LIMIT 1`, [key]);
    return (result.rows?.[0]?.fcm_token ?? '').toString();
  }

  return '';
}

async function sendToToken({ token, title, body }) {
  const messaging = getMessagingClient();
  if (!messaging) return { ok: false, reason: 'FCM_NOT_CONFIGURED' };

  try {
    const messageId = await messaging.send({
      token,
      notification: { title, body },
    });
    return { ok: true, messageId };
  } catch (error) {
    return { ok: false, reason: 'FCM_SEND_FAILED', error };
  }
}

exports.sendAutomationAlertToUser = async ({
  userId,
  roomName,
  timeZone,
  force = false,
}) => {
  const key = (userId ?? '').toString().trim();
  if (!key) return { ok: false, reason: 'MISSING_USER_ID' };

  const token = await resolveTokenByUserIdOrEmail(key);
  if (!token) return { ok: false, reason: 'NO_TOKEN' };

  const tz = (timeZone ?? '').toString().trim();
  if (!force && tz && !isAllowedPushTime(tz)) {
    return { ok: true, suppressed: true, reason: 'QUIET_HOURS', timeZone: tz };
  }

  const rn = (roomName ?? '').toString().trim();
  const title = '✅ 체크아웃 자동 차단 완료';
  const body = rn
    ? `${rn} 청소 종료로 판단되어 전원을 차단했습니다.`
    : '청소 종료로 판단되어 전원을 차단했습니다.';

  const result = await sendToToken({ token, title, body });
  if (!result.ok) return { ok: false, reason: result.reason ?? 'FCM_SEND_FAILED' };
  return { ok: true };
};

exports.registerDevice = async (req, res) => {
  const userId = (req.body?.userId ?? '').toString().trim();
  const email = (req.body?.email ?? '').toString().trim();
  const token = (req.body?.token ?? '').toString().trim();
  const timeZone = (req.body?.timeZone ?? '').toString().trim();

  const key = email || userId;
  if (!key || !token) {
    return res.status(400).json({ success: false, message: 'userId(or email), token 값이 필요합니다.' });
  }

  tokenStore.set(key, {
    token,
    timeZone,
    updatedAt: new Date().toISOString(),
  });

  try {
    const stored = await upsertUserToken({ userIdOrEmail: key, token, timeZone });
    if (stored.ok) {
      return res.status(200).json({ success: true, stored: true, storedKey: stored.key });
    }
  } catch (_) {}

  return res.status(200).json({ success: true, stored: false });
};

exports.sendPeakTimeAlert = async (req, res) => {
  const userId = (req.body?.userId ?? '').toString().trim();
  const email = (req.body?.email ?? '').toString().trim();
  const region = (req.body?.region ?? '').toString().trim();
  const savedAmount = req.body?.savedAmount ?? 0;
  const force = Boolean(req.body?.force ?? false);

  const key = email || userId;
  if (!key) return res.status(400).json({ success: false, message: 'userId(or email) 값이 필요합니다.' });

  const token = await resolveTokenByUserIdOrEmail(key);
  if (!token) return res.status(404).json({ success: false, message: '등록된 디바이스 토큰이 없습니다.' });
  const device = tokenStore.get(key) ?? {};

  const effectiveTimeZone =
    (req.body?.timeZone ?? '').toString().trim() || device.timeZone || process.env.PROPERTY_TIMEZONE || '';

  if (!force && effectiveTimeZone && !isAllowedPushTime(effectiveTimeZone)) {
    return res.status(202).json({
      success: true,
      suppressed: true,
      reason: 'QUIET_HOURS',
      timeZone: effectiveTimeZone,
    });
  }

  const { title, body } = buildPeakAlert(region, savedAmount);
  const result = await sendToToken({ token, title, body });

  if (!result.ok) {
    const message =
      result.reason === 'FCM_NOT_CONFIGURED'
        ? 'FCM 설정이 되어 있지 않습니다.'
        : 'FCM 전송에 실패했습니다.';
    return res.status(500).json({ success: false, message });
  }

  return res.status(200).json({ success: true });
};

exports.sendCustomNotification = async (req, res) => {
  const token = (req.body?.token ?? '').toString().trim();
  const title = (req.body?.title ?? '').toString();
  const body = (req.body?.body ?? '').toString();
  const timeZone = (req.body?.timeZone ?? '').toString().trim();
  const force = Boolean(req.body?.force ?? false);

  if (!token || !title || !body) {
    return res.status(400).json({ success: false, message: 'token, title, body 값이 필요합니다.' });
  }

  if (!force && timeZone && !isAllowedPushTime(timeZone)) {
    return res.status(202).json({
      success: true,
      suppressed: true,
      reason: 'QUIET_HOURS',
      timeZone,
    });
  }

  const result = await sendToToken({ token, title, body });
  if (!result.ok) {
    const message =
      result.reason === 'FCM_NOT_CONFIGURED'
        ? 'FCM 설정이 되어 있지 않습니다.'
        : 'FCM 전송에 실패했습니다.';
    return res.status(500).json({ success: false, message });
  }

  return res.status(200).json({ success: true });
};
