const axios = require('axios');

function parseFirstItemFromKpxResponse(data) {
  const item =
    data?.response?.body?.items?.item?.[0] ??
    data?.response?.body?.items?.item ??
    null;
  if (!item) return null;
  return item;
}

function parseSmpValue(rawItem) {
  const candidate = rawItem?.smp ?? rawItem?.SMP ?? rawItem?.price ?? null;
  const num = Number(candidate);
  return Number.isFinite(num) ? num : null;
}

let cachedKepcoData = {
  timestamp: null,
  currentPriceKwh: 0,
  status: 'NORMAL',
  source: 'init',
};

let inFlightFetch = null;

async function fetchAndCacheKepcoData() {
  if (inFlightFetch) return inFlightFetch;

  inFlightFetch = (async () => {
  const apiKey = process.env.KEPCO_API_KEY ?? '';
  const apiUrl =
    process.env.KEPCO_API_URL ??
    'https://openapi.kpx.or.kr/openapi/smp1hToday/getSmp1hToday';

  try {
    if (!apiKey) {
      cachedKepcoData = {
        timestamp: new Date().toISOString(),
        currentPriceKwh: 123.4,
        status: 'NORMAL',
        source: 'mock',
      };
      console.log(
        `[KEPCO Cache] 업데이트 완료: ${cachedKepcoData.currentPriceKwh}원/kWh (${cachedKepcoData.status})`,
      );
      return;
    }

    console.log('[KEPCO Cache] 한전(전력거래소) API에서 최신 데이터를 가져옵니다...');
    let response;
    let lastError;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        response = await axios.get(apiUrl, {
          params: {
            serviceKey: apiKey,
            numOfRows: 1,
            pageNo: 1,
            _type: 'json',
          },
          timeout: 20000,
        });
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 750));
        }
      }
    }

    if (!response) {
      throw lastError ?? new Error('한전 API 호출 실패');
    }

    const rawItem = parseFirstItemFromKpxResponse(response.data);
    const smp = rawItem ? parseSmpValue(rawItem) : null;
    if (smp == null) throw new Error('전력 단가 응답을 해석하지 못했습니다.');

    cachedKepcoData = {
      timestamp: new Date().toISOString(),
      currentPriceKwh: smp,
      status: smp > 150 ? 'PEAK' : 'NORMAL',
      source: 'kpx',
    };

    console.log(
      `[KEPCO Cache] 업데이트 완료: ${cachedKepcoData.currentPriceKwh}원/kWh (${cachedKepcoData.status})`,
    );
  } catch (error) {
    const message =
      typeof error?.message === 'string' ? error.message : 'Unknown error';
    console.error('[KEPCO Cache Error] 한전 API 호출 실패:', message);

    if (!cachedKepcoData.timestamp) {
      cachedKepcoData = {
        timestamp: new Date().toISOString(),
        currentPriceKwh: 0,
        status: 'NORMAL',
        source: 'fallback',
      };
    }
  }
  })();

  try {
    await inFlightFetch;
  } finally {
    inFlightFetch = null;
  }
}

fetchAndCacheKepcoData();

exports.getCachedPowerPrice = (req, res) => {
  if (!cachedKepcoData.timestamp) {
    fetchAndCacheKepcoData();
    return res.status(200).json({
      success: true,
      data: {
        timestamp: null,
        currentPriceKwh: 0,
        status: 'NORMAL',
        source: 'warming',
      },
    });
  }

  return res.status(200).json({ success: true, data: cachedKepcoData });
};

exports.forceRefreshPrice = async (req, res) => {
  const cronSecret = process.env.CRON_SECRET ?? '';
  const authHeader = req.headers['authorization'];

  if (!cronSecret) {
    return res.status(500).json({
      success: false,
      message: '서버에 CRON_SECRET이 설정되지 않았습니다.',
    });
  }

  if (authHeader !== `Bearer ${cronSecret}`) {
    console.warn(
      '[Security] 승인되지 않은 스케줄러 갱신 요청이 차단되었습니다.',
    );
    return res.status(403).json({ success: false, message: '접근 권한이 없습니다.' });
  }

  console.log('[GitHub Action] 스케줄러 요청 수신. 한전 데이터를 갱신합니다.');
  await fetchAndCacheKepcoData();
  return res.status(200).json({
    success: true,
    message: '한전 데이터 캐시가 성공적으로 갱신되었습니다.',
  });
};
