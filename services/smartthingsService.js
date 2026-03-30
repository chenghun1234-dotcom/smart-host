/**
 * SmartThings API 서비스
 * - 호스트의 OAuth 토큰으로 SmartThings API 호출
 * - 기기 목록 조회
 * - 기기 제어 명령 실행
 */

const https = require('https');
const http = require('http');

const SMARTTHINGS_API_BASE = 'https://api.smartthings.com/v1';

/**
 * HTTP/HTTPS 요청 유틸
 */
function makeRequest(method, url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const requestOptions = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Onyx-AI/1.0',
        ...options.headers,
      },
    };

    if (options.body) {
      const bodyStr = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      requestOptions.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = client.request(url, requestOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : null;
          resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: data });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body: null, raw: data });
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (options.body) {
      const bodyStr = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      req.write(bodyStr);
    }

    req.end();
  });
}

/**
 * 호스트의 SmartThings 기기 목록 조회
 * @param {string} accessToken - 호스트의 OAuth access token
 * @returns {Promise<Array>} 기기 목록
 */
async function listDevices(accessToken) {
  if (!accessToken) {
    throw new Error('accessToken is required');
  }

  try {
    const response = await makeRequest('GET', `${SMARTTHINGS_API_BASE}/devices`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (response.status !== 200) {
      console.error('[SmartThings] listDevices error:', response.status, response.raw);
      throw new Error(`SmartThings API error: ${response.status}`);
    }

    const devices = response.body?.items ?? [];
    return devices;
  } catch (err) {
    console.error('[SmartThings] listDevices failed:', err.message);
    throw err;
  }
}

/**
 * 특정 기기의 상태 조회
 * @param {string} accessToken - 호스트의 OAuth access token
 * @param {string} deviceId - SmartThings 기기 ID
 * @returns {Promise<Object>} 기기 상태
 */
async function getDeviceStatus(accessToken, deviceId) {
  if (!accessToken || !deviceId) {
    throw new Error('accessToken and deviceId are required');
  }

  try {
    const response = await makeRequest('GET', `${SMARTTHINGS_API_BASE}/devices/${deviceId}/status`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (response.status !== 200) {
      console.error('[SmartThings] getDeviceStatus error:', response.status, response.raw);
      throw new Error(`SmartThings API error: ${response.status}`);
    }

    return response.body;
  } catch (err) {
    console.error('[SmartThings] getDeviceStatus failed:', err.message);
    throw err;
  }
}

/**
 * 기기에 제어 명령 실행 (on/off)
 * @param {string} accessToken - 호스트의 OAuth access token
 * @param {string} deviceId - SmartThings 기기 ID
 * @param {boolean} powerOn - true면 on, false면 off
 * @returns {Promise<Object>} 응답
 */
async function executeDeviceCommand(accessToken, deviceId, powerOn) {
  if (!accessToken || !deviceId) {
    throw new Error('accessToken and deviceId are required');
  }

  const command = powerOn ? 'on' : 'off';

  try {
    const payload = {
      commands: [
        {
          component: 'main',
          capability: 'switch',
          command: command,
          arguments: [],
        },
      ],
    };

    const response = await makeRequest('POST', `${SMARTTHINGS_API_BASE}/devices/${deviceId}/commands`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: payload,
    });

    if (response.status !== 200) {
      console.error('[SmartThings] executeDeviceCommand error:', response.status, response.raw);
      throw new Error(`SmartThings API error: ${response.status}`);
    }

    return response.body;
  } catch (err) {
    console.error('[SmartThings] executeDeviceCommand failed:', err.message);
    throw err;
  }
}

/**
 * Mock 모드에서 사용할 테스트 기기 목록 반환
 */
function getMockDevices() {
  return [
    {
      deviceId: 'mock-device-001',
      name: 'Onyx 에어컨 컨트롤러',
      label: 'Onyx Smart Plug',
      type: 'DEVICE',
      status: 'ONLINE',
      deviceTypeName: 'SmartPlug',
      deviceTypeId: 'smartplug',
      components: [
        {
          id: 'main',
          label: 'Main Component',
          capabilities: [
            { id: 'switch' },
            { id: 'powerMeter' },
            { id: 'energyMeter' },
          ],
        },
      ],
    },
  ];
}

module.exports = {
  SMARTTHINGS_API_BASE,
  listDevices,
  getDeviceStatus,
  executeDeviceCommand,
  getMockDevices,
};
