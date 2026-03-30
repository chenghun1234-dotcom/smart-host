require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const http = require('http');
const mongoose = require('mongoose');
const cron = require('node-cron');
const ical = require('node-ical');
const axios = require('axios');
const { WebSocketServer } = require('ws');

const apiRoutes = require('./routes/apiRoutes');
const roomController = require('./controllers/roomController');
const smartthingsService = require('./services/smartthingsService');

const app = express();
const PORT = Number(process.env.PORT ?? 3000);
let lastMongoErrorMessage = '';

app.use(cors());
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf?.toString?.('utf8') ?? '';
    },
  }),
);
app.use(express.urlencoded({ extended: false }));

app.get('/', (req, res) => {
  res.redirect('https://nextfintechai.com');
});

app.get('/status', (req, res) => {
  const mongoUri = readMongoUri();
  const mongoose = require('mongoose');
  const rawMongoUri = (process.env.MONGO_URI ?? '').toString();
  res.status(200).json({
    server: 'ok',
    mongoUriSet: !!mongoUri,
    mongoUriPrefix: mongoUri ? mongoUri.slice(0, 20) + '...' : 'NOT SET',
    mongoUriSanitized: rawMongoUri !== mongoUri,
    mongoUriHasDbName: hasDatabaseNameInMongoUri(mongoUri),
    mongoReadyState: mongoose.connection.readyState,
    mongoReadyStateLabel: ['disconnected','connected','connecting','disconnecting'][mongoose.connection.readyState] ?? 'unknown',
    hostModelReady: !!getHostModel(),
    lastMongoErrorMessage,
    env: {
      MONGO_URI: !!process.env.MONGO_URI,
      SMARTTHINGS_CLIENT_ID: !!process.env.SMARTTHINGS_CLIENT_ID,
      OAUTH_MOCK_MODE: process.env.OAUTH_MOCK_MODE ?? 'not set',
      RUN_MONGO_AUTOMATION: process.env.RUN_MONGO_AUTOMATION ?? 'not set',
    },
  });
});

function readMongoUri() {
  let value = (process.env.MONGO_URI ?? '').toString().trim();
  if (!value) return '';

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }

  if (value.startsWith('<') && value.endsWith('>')) {
    value = value.slice(1, -1).trim();
  }

  return value;
}

function hasDatabaseNameInMongoUri(uri) {
  const raw = (uri ?? '').toString().trim();
  if (!raw) return false;

  const scheme = raw.startsWith('mongodb+srv://')
    ? 'mongodb+srv://'
    : raw.startsWith('mongodb://')
      ? 'mongodb://'
      : '';
  if (!scheme) return false;

  const noScheme = raw.slice(scheme.length);
  const slashIndex = noScheme.indexOf('/');
  if (slashIndex < 0) return false;

  const afterSlash = noScheme.slice(slashIndex + 1);
  if (!afterSlash) return false;

  const dbName = afterSlash.split('?')[0].trim();
  return dbName.length > 0;
}

function readSmartThingsClientId() {
  return (
    process.env.SMARTTHINGS_CLIENT_ID ??
    process.env.CLIENT_ID ??
    process.env.OAUTH_CLIENT_ID ??
    ''
  )
    .toString()
    .trim();
}

function readSmartThingsClientSecret() {
  return (
    process.env.SMARTTHINGS_CLIENT_SECRET ??
    process.env.CLIENT_SECRET ??
    process.env.OAUTH_CLIENT_SECRET ??
    ''
  )
    .toString()
    .trim();
}

function readSmartThingsRedirectUri() {
  return (
    process.env.SMARTTHINGS_REDIRECT_URI ??
    process.env.REDIRECT_URI ??
    process.env.OAUTH_REDIRECT_URI ??
    ''
  )
    .toString()
    .trim();
}

function readDefaultSmartThingsDeviceId() {
  return (process.env.SMARTTHINGS_DEFAULT_DEVICE_ID ?? '').toString().trim();
}

let hostModel = null;

async function connectMongoIfConfigured() {
  const mongoUri = readMongoUri();
  if (!mongoUri) {
    lastMongoErrorMessage = 'MONGO_URI is empty';
    console.log('[MongoDB] MONGO_URI not set. Skipping MongoDB connection.');
    return null;
  }

  if (!hasDatabaseNameInMongoUri(mongoUri)) {
    console.warn('[MongoDB] MONGO_URI has no database name. Recommended format: ...mongodb.net/onyx?...');
  }

  if (mongoose.connection.readyState === 1) return mongoose.connection;

  await mongoose.connect(mongoUri);
  lastMongoErrorMessage = '';
  console.log('[MongoDB] connected');

  const hostSchema = new mongoose.Schema(
    {
      hostName: { type: String, required: true, index: true },
      smartThingsToken: { type: String, required: true },
      smartThingsRefreshToken: { type: String, default: '' },
      tokenExpiresAt: { type: Date, default: null },
      deviceId: { type: String, default: '' },
      iCalUrl: { type: String, default: '' },
      isActive: { type: Boolean, default: true },
    },
    { timestamps: true },
  );

  hostModel = mongoose.models.Host || mongoose.model('Host', hostSchema);
  return mongoose.connection;
}

function getHostModel() {
  return hostModel;
}

function encodeState(payload) {
  const json = JSON.stringify(payload ?? {});
  return Buffer.from(json, 'utf8').toString('base64url');
}

function decodeState(state) {
  const raw = (state ?? '').toString().trim();
  if (!raw) return {};
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function shouldRunMongoScheduler() {
  const raw = (process.env.RUN_MONGO_AUTOMATION ?? 'true').toString().trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no';
}

async function exchangeCodeForSmartThingsToken(code) {
  const clientId = readSmartThingsClientId();
  const clientSecret = readSmartThingsClientSecret();
  const redirectUri = readSmartThingsRedirectUri();

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('SMARTTHINGS_CLIENT_ID/SMARTTHINGS_CLIENT_SECRET/SMARTTHINGS_REDIRECT_URI are required');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: (code ?? '').toString(),
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });

  const response = await axios.post('https://api.smartthings.com/oauth/token', body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });

  return response.data ?? {};
}

async function sendSmartThingsSwitchCommand({ token, deviceId, command }) {
  if (!token || !deviceId) return false;

  const payload = {
    commands: [
      {
        component: 'main',
        capability: 'switch',
        command,
      },
    ],
  };

  await axios.post(`https://api.smartthings.com/v1/devices/${deviceId}/commands`, payload, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15000,
  });

  return true;
}

function isOccupiedFromIcalEvents(events, now = new Date()) {
  const data = events && typeof events === 'object' ? events : {};

  for (const key of Object.keys(data)) {
    const event = data[key];
    if (!event || event.type !== 'VEVENT') continue;

    const checkIn = event.start instanceof Date ? event.start : null;
    const checkOut = event.end instanceof Date ? event.end : null;
    if (!checkIn || !checkOut) continue;

    if (now >= checkIn && now <= checkOut) return true;
  }

  return false;
}

function handleSmartThingsAuth(req, res) {
  const clientId = readSmartThingsClientId();
  const redirectUri = readSmartThingsRedirectUri();

  if (!clientId || !redirectUri) {
    return res.status(500).send('SMARTTHINGS_CLIENT_ID or SMARTTHINGS_REDIRECT_URI is missing');
  }

  const hostName = (req.query?.hostName ?? 'host').toString();
  const deviceId =
    (req.query?.deviceId ?? '').toString().trim() || readDefaultSmartThingsDeviceId();
  const iCalUrl = (req.query?.iCalUrl ?? '').toString();

  const state = encodeState({ hostName, deviceId, iCalUrl });

  const authUrl = new URL('https://api.smartthings.com/oauth/authorize');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);

  return res.redirect(authUrl.toString());
}

app.get('/auth/smartthings', handleSmartThingsAuth);
app.get('/auth/samsung', handleSmartThingsAuth);

async function handleSmartThingsCallback(req, res) {
  try {
    const code = (req.query?.code ?? '').toString();
    if (!code) {
      const oauthError = (req.query?.error ?? '').toString();
      const oauthErrorDescription = (req.query?.error_description ?? '').toString();
      if (oauthError) {
        return res
          .status(400)
          .send(`OAuth callback error: ${oauthError}${oauthErrorDescription ? ` - ${oauthErrorDescription}` : ''}`);
      }
      return res.status(200).send('OAuth callback endpoint is alive. Wait for SmartThings redirect with ?code=...');
    }

    const Host = getHostModel();
    if (!Host) return res.status(503).send('MongoDB not connected. Set MONGO_URI first.');

    const stateData = decodeState(req.query?.state);
    const hostName = (stateData.hostName ?? '테스트_호스트_1').toString();
    const deviceId =
      (stateData.deviceId ?? '').toString().trim() || readDefaultSmartThingsDeviceId();
    const iCalUrl = (stateData.iCalUrl ?? '').toString();

    const tokenData = await exchangeCodeForSmartThingsToken(code);
    const accessToken = (tokenData.access_token ?? '').toString();
    const refreshToken = (tokenData.refresh_token ?? '').toString();
    const expiresIn = Number(tokenData.expires_in ?? 0);
    const tokenExpiresAt =
      Number.isFinite(expiresIn) && expiresIn > 0
        ? new Date(Date.now() + expiresIn * 1000)
        : null;

    if (!accessToken) return res.status(500).send('failed to get smartthings access token');

    await Host.findOneAndUpdate(
      { hostName },
      {
        hostName,
        smartThingsToken: accessToken,
        smartThingsRefreshToken: refreshToken,
        tokenExpiresAt,
        deviceId,
        iCalUrl,
        isActive: true,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    return res.send('Onyx AI: 성공적으로 삼성 계정이 연동되었습니다! 창을 닫아주세요.');
  } catch (error) {
    console.error('[OAuth Callback] failed:', error?.response?.data ?? error?.message ?? error);
    return res.status(500).send('연동 에러');
  }
}

app.get('/oauth/callback', handleSmartThingsCallback);
app.get('/callback', handleSmartThingsCallback);

app.post('/hosts', async (req, res) => {
  const Host = getHostModel();
  if (!Host) return res.status(503).json({ success: false, message: 'MongoDB not connected' });

  const hostName = (req.body?.hostName ?? '').toString().trim();
  const deviceId = (req.body?.deviceId ?? '').toString().trim();
  const iCalUrl = (req.body?.iCalUrl ?? '').toString().trim();

  if (!hostName) {
    return res.status(400).json({ success: false, message: 'hostName is required' });
  }

  const doc = await Host.findOneAndUpdate(
    { hostName },
    { hostName, deviceId, iCalUrl, isActive: true },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return res.status(200).json({
    success: true,
    host: {
      id: doc._id,
      hostName: doc.hostName,
      deviceId: doc.deviceId,
      iCalUrl: doc.iCalUrl,
      isActive: doc.isActive,
    },
  });
});

app.get('/hosts', async (req, res) => {
  const Host = getHostModel();
  if (!Host) return res.status(503).json({ success: false, message: 'MongoDB not connected' });

  const hosts = await Host.find({}).sort({ updatedAt: -1 }).lean();
  return res.status(200).json({
    success: true,
    count: hosts.length,
    hosts: hosts.map((h) => ({
      id: h._id,
      hostName: h.hostName,
      deviceId: h.deviceId,
      iCalUrl: h.iCalUrl,
      hasToken: !!h.smartThingsToken,
      isActive: h.isActive !== false,
      updatedAt: h.updatedAt,
    })),
  });
});

async function runMongoAutomationScheduler() {
  const Host = getHostModel();
  if (!Host) return;

  console.log('🔍 전국 숙소 체크아웃 감시 스케줄러 가동 중...');

  const hosts = await Host.find({ isActive: { $ne: false } }).lean();
  const now = new Date();

  for (const host of hosts) {
    const hostName = (host.hostName ?? '').toString();
    const token = (host.smartThingsToken ?? '').toString();
    const deviceId = (host.deviceId ?? '').toString();
    const iCalUrl = (host.iCalUrl ?? '').toString();

    if (!token || !deviceId || !iCalUrl) continue;

    try {
      const events = await ical.async.fromURL(iCalUrl);
      const isOccupied = isOccupiedFromIcalEvents(events, now);
      const command = isOccupied ? 'on' : 'off';

      await sendSmartThingsSwitchCommand({ token, deviceId, command });
      console.log(`[${hostName}] 에어컨 상태 변경 완료: ${command.toUpperCase()}`);
    } catch (error) {
      console.error(`[${hostName}] 제어 실패:`, error?.response?.data ?? error?.message ?? error);
    }
  }
}

function isMockOauthEnabled() {
  const raw = (process.env.OAUTH_MOCK_MODE ?? 'true').toString().trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no';
}

function readMockAgentId() {
  return (process.env.MOCK_AGENT_ID ?? 'r1').toString().trim() || 'r1';
}

function readOauthClientId() {
  return (process.env.OAUTH_CLIENT_ID ?? '').toString();
}

function readOauthClientSecret() {
  return (process.env.OAUTH_CLIENT_SECRET ?? '').toString();
}

function readOauthRedirectUris() {
  const raw = (process.env.OAUTH_REDIRECT_URIS ?? '').toString();
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function readOauthIssuer() {
  const raw = (process.env.OAUTH_ISSUER ?? '').toString().trim();
  if (raw) return raw.replace(/\/+$/, '');
  return '';
}

function randomToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function readBasicAuth(req) {
  const auth = req.headers?.authorization?.toString() ?? '';
  if (!auth.toLowerCase().startsWith('basic ')) return null;
  const encoded = auth.slice('basic '.length).trim();
  let decoded = '';
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return null;
  return { clientId: decoded.slice(0, idx), clientSecret: decoded.slice(idx + 1) };
}

function isAllowedRedirectUri(redirectUri) {
  const allowed = readOauthRedirectUris();
  if (allowed.length === 0) return true;
  return allowed.includes(redirectUri);
}

// 호스트별 SmartThings access token 저장소
// 실제 운영에서는 데이터베이스 사용 권장
const hostTokenStore = new Map();

function storeHostToken(hostId, accessToken, refreshToken) {
  hostTokenStore.set(hostId, {
    accessToken,
    refreshToken,
    storedAt: new Date().toISOString(),
  });
}

function getHostToken(hostId) {
  const entry = hostTokenStore.get(hostId);
  return entry?.accessToken ?? null;
}

function matchClient(clientId, clientSecret) {
  const expectedId = readOauthClientId();
  const expectedSecret = readOauthClientSecret();
  if (!expectedId || !expectedSecret) return true;
  return clientId === expectedId && clientSecret === expectedSecret;
}

const oauthAuthCodes = new Map();
const oauthRefreshTokens = new Map();
const oauthAccessTokens = new Map();

function buildAuthorizePage(params) {
  const esc = (v) =>
    String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\"/g, '&quot;')
      .replace(/'/g, '&#39;');

  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ONYX SmartThings 연결</title>
  </head>
  <body style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding: 20px;">
    <h2 style="margin: 0 0 12px 0;">SmartThings 연결</h2>
    <div style="color: #444; margin-bottom: 16px;">
      이 화면은 SmartThings OAuth 테스트용 최소 승인 페이지입니다.
    </div>
    <div style="background:#f6f6f6;padding:12px;border-radius:10px;margin-bottom:16px;">
      <div><b>client_id</b>: ${esc(params.client_id)}</div>
      <div><b>redirect_uri</b>: ${esc(params.redirect_uri)}</div>
      <div><b>scope</b>: ${esc(params.scope)}</div>
    </div>
    <form method="post" action="/oauth/authorize/confirm">
      <input type="hidden" name="response_type" value="${esc(params.response_type)}" />
      <input type="hidden" name="client_id" value="${esc(params.client_id)}" />
      <input type="hidden" name="redirect_uri" value="${esc(params.redirect_uri)}" />
      <input type="hidden" name="state" value="${esc(params.state)}" />
      <input type="hidden" name="scope" value="${esc(params.scope)}" />
      <button type="submit" style="padding:12px 16px;border-radius:10px;border:0;background:#111;color:#fff;font-weight:600;">
        연결 승인
      </button>
    </form>
  </body>
</html>`;
}

app.get('/oauth/authorize', (req, res) => {
  const responseType = req.query?.response_type?.toString() ?? '';
  const clientId = req.query?.client_id?.toString() ?? '';
  const redirectUri = req.query?.redirect_uri?.toString() ?? '';
  const state = req.query?.state?.toString() ?? '';
  const scope = req.query?.scope?.toString() ?? '';

  if (responseType !== 'code') return res.status(400).send('unsupported_response_type');
  if (!clientId || !redirectUri) return res.status(400).send('missing_client_or_redirect');
  if (!isAllowedRedirectUri(redirectUri)) return res.status(400).send('invalid_redirect_uri');

  if (isMockOauthEnabled()) {
    const code = 'dummy_auth_code_1234';
    const url = new URL(redirectUri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    console.log('[OAuth] mock authorize success -> redirect');
    return res.redirect(302, url.toString());
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(
    buildAuthorizePage({
      response_type: responseType,
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      scope,
    }),
  );
});

app.get('/oauth/login', (req, res) => {
  const redirectUri = req.query?.redirect_uri?.toString() ?? '';
  const state = req.query?.state?.toString() ?? '';

  if (!redirectUri) return res.status(400).send('missing_redirect_uri');
  if (!isAllowedRedirectUri(redirectUri)) return res.status(400).send('invalid_redirect_uri');

  if (isMockOauthEnabled()) {
    const successUrl = new URL(redirectUri);
    successUrl.searchParams.set('code', 'dummy_auth_code_1234');
    if (state) successUrl.searchParams.set('state', state);
    console.log('[OAuth] login mock success -> redirect to SmartThings');
    return res.redirect(302, successUrl.toString());
  }

  const code = randomToken();
  const now = Date.now();
  const ttlMs = Math.max(30, Number(process.env.OAUTH_CODE_TTL_SEC ?? 300)) * 1000;
  oauthAuthCodes.set(code, { clientId: 'onyx-login', redirectUri, createdAt: now, exp: now + ttlMs });

  const successUrl = new URL(redirectUri);
  successUrl.searchParams.set('code', code);
  if (state) successUrl.searchParams.set('state', state);
  return res.redirect(302, successUrl.toString());
});

app.post('/oauth/authorize/confirm', (req, res) => {
  const responseType = req.body?.response_type?.toString() ?? '';
  const clientId = req.body?.client_id?.toString() ?? '';
  const redirectUri = req.body?.redirect_uri?.toString() ?? '';
  const state = req.body?.state?.toString() ?? '';

  if (responseType !== 'code') return res.status(400).send('unsupported_response_type');
  if (!clientId || !redirectUri) return res.status(400).send('missing_client_or_redirect');
  if (!isAllowedRedirectUri(redirectUri)) return res.status(400).send('invalid_redirect_uri');

  const code = randomToken();
  const now = Date.now();
  const ttlMs = Math.max(30, Number(process.env.OAUTH_CODE_TTL_SEC ?? 300)) * 1000;
  oauthAuthCodes.set(code, { clientId, redirectUri, createdAt: now, exp: now + ttlMs });

  const url = new URL(redirectUri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  return res.redirect(302, url.toString());
});

app.post('/oauth/token', (req, res) => {
  if (isMockOauthEnabled()) {
    console.log('[OAuth] mock token issued');
    const mockToken = {
      access_token: 'dummy_access_token_onyx_999',
      token_type: 'bearer',
      expires_in: 360000,
      refresh_token: 'dummy_refresh_token_onyx_888',
    };
    // Mock 모드에서도 호스트ID 저장
    const hostId = req.body?.state ?? 'default-host';
    storeHostToken(hostId, mockToken.access_token, mockToken.refresh_token);
    return res.status(200).json(mockToken);
  }

  const basic = readBasicAuth(req);
  const clientId = (basic?.clientId ?? req.body?.client_id ?? '').toString();
  const clientSecret = (basic?.clientSecret ?? req.body?.client_secret ?? '').toString();

  if (!matchClient(clientId, clientSecret)) {
    return res.status(401).json({ error: 'invalid_client' });
  }

  const grantType = req.body?.grant_type?.toString() ?? '';
  const issuer = readOauthIssuer();
  const expiresInSec = Math.max(60, Number(process.env.OAUTH_ACCESS_TOKEN_TTL_SEC ?? 3600));

  if (grantType === 'authorization_code') {
    const code = req.body?.code?.toString() ?? '';
    const redirectUri = req.body?.redirect_uri?.toString() ?? '';
    const entry = oauthAuthCodes.get(code);
    if (!entry) return res.status(400).json({ error: 'invalid_grant' });
    if (entry.exp <= Date.now()) {
      oauthAuthCodes.delete(code);
      return res.status(400).json({ error: 'invalid_grant' });
    }
    if (entry.clientId !== clientId) return res.status(400).json({ error: 'invalid_grant' });
    if (redirectUri && entry.redirectUri !== redirectUri) return res.status(400).json({ error: 'invalid_grant' });

    oauthAuthCodes.delete(code);

    const accessToken = randomToken();
    const refreshToken = randomToken();
    const exp = Date.now() + expiresInSec * 1000;
    oauthAccessTokens.set(accessToken, { clientId, exp });
    oauthRefreshTokens.set(refreshToken, { clientId });

    // 호스트 토큰 저장
    const hostId = clientId || 'default-host';
    storeHostToken(hostId, accessToken, refreshToken);

    return res.status(200).json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresInSec,
      refresh_token: refreshToken,
      issuer: issuer || undefined,
    });
  }

  if (grantType === 'refresh_token') {
    const refreshToken = req.body?.refresh_token?.toString() ?? '';
    const entry = oauthRefreshTokens.get(refreshToken);
    if (!entry) return res.status(400).json({ error: 'invalid_grant' });
    if (entry.clientId !== clientId) return res.status(400).json({ error: 'invalid_grant' });

    const accessToken = randomToken();
    const exp = Date.now() + expiresInSec * 1000;
    oauthAccessTokens.set(accessToken, { clientId, exp });

    return res.status(200).json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresInSec,
      refresh_token: refreshToken,
      issuer: issuer || undefined,
    });
  }

  return res.status(400).json({ error: 'unsupported_grant_type' });
});

app.get('/st/webhook', (req, res) => {
  res.status(200).json({ ok: true, method: 'POST' });
});

app.post('/st/webhook', async (req, res) => {
  const lifecycle = (req.body?.lifecycle ?? '').toString().trim().toUpperCase();

  if (lifecycle === 'PING') {
    const challenge = (req.body?.pingData?.challenge ?? '').toString();
    return res.status(200).json({ pingData: { challenge } });
  }

  if (lifecycle === 'CONFIRMATION') {
    const explicitTargetUrl =
      (process.env.SMARTAPP_TARGET_URL ?? process.env.WEBHOOK_TARGET_URL ?? '')
        .toString()
        .trim();
    const forwardedProto =
      (req.headers['x-forwarded-proto'] ?? req.protocol ?? 'https')
        .toString()
        .split(',')[0]
        .trim();
    const forwardedHost =
      (req.headers['x-forwarded-host'] ?? req.get('host') ?? '')
        .toString()
        .split(',')[0]
        .trim();
    const inferredTargetUrl = `${forwardedProto}://${forwardedHost}/st/webhook`;
    const targetUrl = explicitTargetUrl || inferredTargetUrl;

    const confirmationUrl =
      (req.body?.confirmationData?.confirmationUrl ?? '')
        .toString()
        .trim();

    if (confirmationUrl) {
      try {
        await axios.get(confirmationUrl, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
          params: { targetUrl },
        });
      } catch (error) {
        console.error(
          '[SmartApp CONFIRMATION] confirmationUrl call failed:',
          error?.response?.data ?? error?.message ?? error,
        );
      }
    }

    return res.status(200).json({ targetUrl });
  }

  const requestHeaders =
    (req.body && typeof req.body === 'object' ? req.body.headers : null) ?? {};
  const interactionType = requestHeaders.interactionType?.toString() ?? '';

  function extractMockCommands(body) {
    const directCommands = Array.isArray(body?.payload?.commands) ? body.payload.commands : [];
    if (directCommands.length > 0) {
      return {
        commands: directCommands,
        externalDeviceId: body?.payload?.externalDeviceId?.toString?.() ?? 'onyx-plug-01',
      };
    }

    const payloadDevices = Array.isArray(body?.payload?.devices) ? body.payload.devices : [];
    for (const d of payloadDevices) {
      const cmds = Array.isArray(d?.commands) ? d.commands : [];
      if (cmds.length > 0) {
        return {
          commands: cmds,
          externalDeviceId: d?.externalDeviceId?.toString?.() ?? 'onyx-plug-01',
        };
      }
    }

    const topDevices = Array.isArray(body?.devices) ? body.devices : [];
    for (const d of topDevices) {
      const cmds = Array.isArray(d?.commands) ? d.commands : [];
      if (cmds.length > 0) {
        return {
          commands: cmds,
          externalDeviceId: d?.externalDeviceId?.toString?.() ?? 'onyx-plug-01',
        };
      }
    }

    return { commands: [], externalDeviceId: 'onyx-plug-01' };
  }

  if (isMockOauthEnabled() && interactionType) {
    console.log(`[SmartThings webhook/mock] interactionType=${interactionType}`);

    if (interactionType === 'discoveryRequest') {
      // Mock 모드에서는 테스트 기기 반환
      const mockDevices = smartthingsService.getMockDevices();
      const endpoints = mockDevices.map((d) => ({
        endpointId: d.deviceId || 'mock-device-001',
        friendlyName: d.name || d.label || 'Onyx Smart Device',
        manufacturerName: 'Onyx AI',
        modelName: 'SmartHost-001',
        displayCategories: ['SmartPlug'],
        cookie: {},
      }));

      return res.status(200).json({
        headers: { ...requestHeaders, interactionType: 'discoveryResponse' },
        payload: {
          endpoints,
        },
      });
    }

    if (interactionType === 'commandRequest') {
      const { commands, externalDeviceId } = extractMockCommands(req.body);
      if (commands.length === 0) {
        return res.status(400).json({
          error: 'no_commands',
          detail: 'commandRequest payload.commands or devices[].commands is required',
        });
      }

      let targetState = false;

      for (const cmd of commands) {
        const name = cmd?.command?.toString?.() ?? '';
        if (name === 'on') targetState = true;
        if (name === 'off') targetState = false;
      }

      // Mock 모드에서는 로컬 에이전트로 제어
      if (isMockOauthEnabled()) {
        const agentId = readMockAgentId();
        const sent = req.app?.locals?.bridge?.sendToAgent?.(agentId, {
          type: 'IOT_CONTROL',
          ts: new Date().toISOString(),
          requestId: requestHeaders.requestId?.toString?.() ?? '',
          deviceId: externalDeviceId,
          action: 'SET_POWER',
          value: targetState,
        });

        if (!sent) {
          return res.status(503).json({
            error: 'agent_not_connected',
            agentId,
          });
        }

        return res.status(200).json({
          headers: { ...requestHeaders, interactionType: 'commandResponse' },
          payload: {
            deviceState: [
              {
                externalDeviceId,
                states: [
                  {
                    component: 'main',
                    capability: 'switch',
                    attribute: 'switch',
                    value: targetState ? 'on' : 'off',
                  },
                ],
              },
            ],
          },
        });
      }

      // 실제 모드: SmartThings API를 통해 기기 제어
      // 호스트의 토큰을 externalDeviceId와 연관된 호스트 ID로 조회
      // (이 예제에서는 첫 번째 호스트의 토큰 사용)
      const hostId = 'default-host'; // 실제로는 deviceId에서 호스트 ID 매핑 필요
      const token = getHostToken(hostId);

      if (!token) {
        return res.status(401).json({
          error: 'host_unauthorized',
          message: 'host token not found',
        });
      }

      try {
        await smartthingsService.executeDeviceCommand(token, externalDeviceId, targetState);
        return res.status(200).json({
          headers: { ...requestHeaders, interactionType: 'commandResponse' },
          payload: {
            deviceState: [
              {
                externalDeviceId,
                states: [
                  {
                    component: 'main',
                    capability: 'switch',
                    attribute: 'switch',
                    value: targetState ? 'on' : 'off',
                  },
                ],
              },
            ],
          },
        });
      } catch (err) {
        console.error('[commandRequest] SmartThings API error:', err.message);
        return res.status(503).json({
          error: 'smartthings_api_error',
          message: err.message,
        });
      }
    }

    return res.status(200).json({});
  }

  return roomController.smartThingsWebhook(req, res);
});

// 호스트의 SmartThings 기기 목록 조회
app.get('/api/devices', async (req, res) => {
  const hostId = req.query?.hostId?.toString() ?? 'default-host';
  const token = getHostToken(hostId);

  if (!token) {
    return res.status(401).json({
      error: 'unauthorized',
      message: 'host token not found. Please login first.',
    });
  }

  try {
    let devices;
    
    // Mock 모드에서는 테스트 기기 반환
    if (isMockOauthEnabled()) {
      devices = smartthingsService.getMockDevices();
    } else {
      // 실제 SmartThings API 호출
      devices = await smartthingsService.listDevices(token);
    }

    return res.status(200).json({
      success: true,
      count: devices.length,
      devices: devices.map((d) => ({
        deviceId: d.deviceId || d.id,
        name: d.name || d.label || 'Unknown',
        label: d.label || d.name || 'Unknown',
        type: d.type || d.deviceTypeName || 'Unknown',
        status: d.status || 'UNKNOWN',
        components: d.components || [],
      })),
    });
  } catch (err) {
    console.error('[/api/devices] error:', err.message);
    return res.status(500).json({
      error: 'failed_to_fetch_devices',
      message: err.message,
    });
  }
});

app.get('/bridge/agents', (req, res) => {
  const list = req.app?.locals?.bridge?.listConnectedAgents?.() ?? [];
  return res.status(200).json({
    count: Array.isArray(list) ? list.length : 0,
    agents: Array.isArray(list) ? list : [],
  });
});

app.use('/api/v1', apiRoutes);

const server = http.createServer(app);

const agents = new Map();

function readBridgeToken() {
  return process.env.BRIDGE_TOKEN ?? '';
}

function isAuthorizedToken(token) {
  const required = readBridgeToken();
  if (!required) return true;
  return token === required;
}

function listConnectedAgents() {
  const result = [];
  for (const [agentId, entry] of agents.entries()) {
    result.push({
      agentId,
      connectedAt: entry.connectedAt,
      lastSeenAt: entry.lastSeenAt,
    });
  }
  return result;
}

function sendToAgent(agentId, message) {
  const entry = agents.get(agentId);
  if (!entry || entry.ws.readyState !== entry.ws.OPEN) return false;
  entry.ws.send(JSON.stringify(message));
  entry.lastSeenAt = new Date().toISOString();
  return true;
}

function hasAgent(agentId) {
  const entry = agents.get(agentId);
  if (!entry) return false;
  return entry.ws.readyState === entry.ws.OPEN;
}

function broadcastToAgents(message) {
  let sent = 0;
  for (const agentId of agents.keys()) {
    if (sendToAgent(agentId, message)) sent += 1;
  }
  return sent;
}

app.locals.bridge = {
  listConnectedAgents,
  sendToAgent,
  hasAgent,
  broadcastToAgents,
};

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const agentId = url.searchParams.get('agentId') ?? '';
  const token = url.searchParams.get('token') ?? '';

  if (!agentId) {
    ws.close(1008, 'agentId_required');
    return;
  }

  if (!isAuthorizedToken(token)) {
    ws.close(1008, 'unauthorized');
    return;
  }

  if (agents.has(agentId)) {
    try {
      agents.get(agentId)?.ws.close(1012, 'replaced');
    } catch {}
  }

  const now = new Date().toISOString();
  agents.set(agentId, { ws, connectedAt: now, lastSeenAt: now });
  console.log(`[Bridge] agent connected: ${agentId}`);

  ws.on('message', (raw) => {
    const text = raw?.toString?.() ?? '';
    const entry = agents.get(agentId);
    if (entry) entry.lastSeenAt = new Date().toISOString();

    let msg = null;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    if (msg?.type === 'PING') {
      ws.send(JSON.stringify({ type: 'PONG', ts: new Date().toISOString() }));
    }
  });

  ws.on('close', () => {
    const current = agents.get(agentId);
    if (current?.ws === ws) agents.delete(agentId);
    console.log(`[Bridge] agent disconnected: ${agentId}`);
  });
});

async function initializeMongoAndAutomation() {
  try {
    await connectMongoIfConfigured();
  } catch (error) {
    lastMongoErrorMessage = (error?.message ?? error ?? '').toString();
    console.error('[MongoDB] connection failed:', error?.message ?? error);
  }

  if (!shouldRunMongoScheduler()) {
    console.log('[Scheduler] RUN_MONGO_AUTOMATION disabled');
    return;
  }

  try {
    await runMongoAutomationScheduler();
    console.log('[Scheduler] initial sync completed');
  } catch (error) {
    console.error('[Scheduler] initial sync failed:', error?.message ?? error);
  }

  cron.schedule('*/10 * * * *', async () => {
    try {
      await runMongoAutomationScheduler();
    } catch (error) {
      console.error('[Scheduler] run failed:', error?.message ?? error);
    }
  });

  console.log('[Scheduler] MongoDB + SmartThings automation enabled (*/10 min)');
}

server.listen(PORT, () => {
  console.log(
    `Onxy AI Host 백엔드 서버가 http://localhost:${PORT} 에서 실행 중입니다.`,
  );
  initializeMongoAndAutomation();
});
