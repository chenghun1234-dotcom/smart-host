const axios = require('axios');

function buildMockHourlyPrices(options) {
  const base = Number(options?.base ?? 110);
  const swing = Number(options?.swing ?? 55);
  const peakHour = Number.isFinite(Number(options?.peakHour)) ? Number(options.peakHour) : 14;
  const prices = Array.from({ length: 24 }, (_, idx) => {
    const wave = Math.sin(((idx - peakHour) / 24) * Math.PI * 2);
    return Math.round((base + swing * Math.max(0, wave)) * 10) / 10;
  });
  const max = Math.max(...prices);
  const maxHour = prices.indexOf(max);
  const avg = prices.reduce((acc, v) => acc + v, 0) / prices.length;
  return {
    tomorrowPrices: prices,
    peakHour: maxHour,
    peakPrice: max,
    averagePrice: avg,
    status: max >= 150 ? 'PEAK' : 'NORMAL',
  };
}

function getTomorrowDateYmd() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const yyyy = String(tomorrow.getFullYear());
  const mm = String(tomorrow.getMonth() + 1).padStart(2, '0');
  const dd = String(tomorrow.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

function ymdToIsoDate(ymd) {
  const s = (ymd ?? '').toString();
  if (s.length !== 8) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function normalizeItemsFromKpxResponse(data) {
  const item = data?.response?.body?.items?.item ?? null;
  if (!item) return [];
  return Array.isArray(item) ? item : [item];
}

function parseHour(rawItem) {
  const candidate =
    rawItem?.smpHour ??
    rawItem?.SMPHOUR ??
    rawItem?.hour ??
    rawItem?.Hour ??
    null;
  const n = Number(candidate);
  if (!Number.isFinite(n)) return null;
  if (n >= 1 && n <= 24) return n - 1;
  if (n >= 0 && n <= 23) return n;
  return null;
}

function parsePrice(rawItem) {
  const candidate = rawItem?.smp ?? rawItem?.SMP ?? rawItem?.price ?? null;
  const n = Number(candidate);
  return Number.isFinite(n) ? n : null;
}

let cachedKepcoData = {
  timestamp: null,
  tomorrowDate: null,
  tomorrowPrices: [],
  peakHour: null,
  peakPrice: 0,
  averagePrice: 0,
  status: 'NORMAL',
  source: 'init',
};

function emptyMarketSnapshot() {
  return {
    timestamp: null,
    tomorrowDate: null,
    tomorrowPrices: [],
    peakHour: null,
    peakPrice: 0,
    averagePrice: 0,
    status: 'NORMAL',
    source: 'init',
  };
}

let globalPriceCache = {
  KR: cachedKepcoData,
  UK_LONDON: emptyMarketSnapshot(),
  US_TX: emptyMarketSnapshot(),
};

let inFlightFetch = null;

function normalizeMarket(raw) {
  const s = (raw ?? '').toString().trim().toUpperCase();
  if (!s) return 'KR';

  if (s === 'UK' || s === 'GB' || s === 'UK_LONDON') return 'UK_LONDON';
  if (s === 'US' || s === 'TX' || s === 'US_TX') return 'US_TX';
  return 'KR';
}

function assertCronAuth(req, res) {
  const cronSecret = process.env.CRON_SECRET ?? '';
  const authHeader = req.headers['authorization'];

  if (!cronSecret) {
    res.status(500).json({
      success: false,
      message: '서버에 CRON_SECRET이 설정되지 않았습니다.',
    });
    return false;
  }

  if (authHeader !== `Bearer ${cronSecret}`) {
    console.warn('[Security] 승인되지 않은 스케줄러 갱신 요청이 차단되었습니다.');
    res.status(403).json({ success: false, message: '접근 권한이 없습니다.' });
    return false;
  }

  return true;
}

function setGlobalMarketCache(market, data) {
  globalPriceCache[market] = data;
  if (market === 'KR') cachedKepcoData = data;
}

async function fetchAndCacheKepcoData() {
  if (inFlightFetch) return inFlightFetch;

  inFlightFetch = (async () => {
    const apiKey = process.env.KEPCO_API_KEY ?? '';
    const tomorrowDate = getTomorrowDateYmd();
    const apiUrl =
      process.env.KEPCO_TOMORROW_API_URL ??
      process.env.KEPCO_API_URL ??
      'https://openapi.kpx.or.kr/openapi/smp1hYesterday/getSmp1hYesterday';

    try {
      if (!apiKey) {
        const mock = buildMockHourlyPrices({ base: 110, swing: 55, peakHour: 14 });
        const next = {
          timestamp: new Date().toISOString(),
          tomorrowDate,
          tomorrowPrices: mock.tomorrowPrices,
          peakHour: mock.peakHour,
          peakPrice: mock.peakPrice,
          averagePrice: mock.averagePrice,
          status: mock.status,
          source: 'mock',
        };
        setGlobalMarketCache('KR', next);
        return;
      }

      console.log(
        `[KEPCO Cache] ${tomorrowDate} 내일 전력 요금 데이터를 분석합니다...`,
      );
      let response;
      let lastError;

      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          response = await axios.get(apiUrl, {
            params: {
              serviceKey: apiKey,
              tradeDay: tomorrowDate,
              numOfRows: 100,
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

      const items = normalizeItemsFromKpxResponse(response.data);
      const prices = new Array(24).fill(0);
      let maxPrice = 0;
      let maxHour = null;
      let sumPrice = 0;
      let observed = 0;

      for (const item of items) {
        const hour = parseHour(item);
        const price = parsePrice(item);
        if (hour == null || price == null) continue;
        if (hour < 0 || hour > 23) continue;
        prices[hour] = price;
        sumPrice += price;
        observed += 1;
        if (price > maxPrice) {
          maxPrice = price;
          maxHour = hour;
        }
      }

      const averagePrice =
        observed > 0 ? sumPrice / 24 : cachedKepcoData.averagePrice ?? 0;

      const next = {
        timestamp: new Date().toISOString(),
        tomorrowDate,
        tomorrowPrices: prices,
        peakHour: maxHour,
        peakPrice: maxPrice,
        averagePrice,
        status: maxPrice >= 150 ? 'PEAK' : 'NORMAL',
        source: 'kpx',
      };
      setGlobalMarketCache('KR', next);

      console.log(
        `[KEPCO Cache] 분석 완료: 피크 ${maxHour ?? '-'}시 (${maxPrice}원/kWh)`,
      );
    } catch (error) {
      const message =
        typeof error?.message === 'string' ? error.message : 'Unknown error';
      console.error('[KEPCO Cache Error] 내일 요금 분석 실패:', message);

      if (!cachedKepcoData.timestamp) {
        const next = {
          timestamp: new Date().toISOString(),
          tomorrowDate,
          tomorrowPrices: new Array(24).fill(0),
          peakHour: null,
          peakPrice: 0,
          averagePrice: 0,
          status: 'NORMAL',
          source: 'fallback',
        };
        setGlobalMarketCache('KR', next);
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

function toZonedParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const parts = dtf.formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  const hour = Number(get('hour'));
  return {
    year: Number.isFinite(year) ? year : null,
    month: Number.isFinite(month) ? month : null,
    day: Number.isFinite(day) ? day : null,
    hour: Number.isFinite(hour) ? hour : null,
  };
}

function ymdFromParts(parts) {
  if (!parts?.year || !parts?.month || !parts?.day) return null;
  const yyyy = String(parts.year);
  const mm = String(parts.month).padStart(2, '0');
  const dd = String(parts.day).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

function getTomorrowDateYmdInTz(timeZone) {
  const nowParts = toZonedParts(new Date(), timeZone);
  if (!nowParts.year || !nowParts.month || !nowParts.day) return getTomorrowDateYmd();

  const noonUtcTomorrow = new Date(
    Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + 1, 12, 0, 0),
  );
  return ymdFromParts(toZonedParts(noonUtcTomorrow, timeZone)) ?? getTomorrowDateYmd();
}

async function fetchAndCacheUkOctopusData() {
  const market = 'UK_LONDON';
  const timeZone = 'Europe/London';
  const tomorrowDate = getTomorrowDateYmdInTz(timeZone);
  const productCode = (process.env.OCTOPUS_PRODUCT_CODE ?? 'AGILE-23-12-06')
    .toString()
    .trim()
    .toUpperCase();
  const regionCode = (process.env.OCTOPUS_REGION_CODE ?? 'C')
    .toString()
    .trim()
    .toUpperCase();
  const tariffCode = `E-1R-${productCode}-${regionCode}`;
  const apiUrl = `https://api.octopus.energy/v1/products/${productCode}/electricity-tariffs/${tariffCode}/standard-unit-rates/`;

  try {
    const response = await axios.get(apiUrl, {
      params: { page_size: 500 },
      timeout: 20000,
    });
    const results = Array.isArray(response.data?.results) ? response.data.results : [];
    if (results.length === 0) throw new Error('invalid_octopus_payload');

    const sums = new Array(24).fill(0);
    const counts = new Array(24).fill(0);
    for (const slot of results) {
      const pricePence = Number(slot?.value_inc_vat);
      const from = slot?.valid_from ? new Date(slot.valid_from) : null;
      if (!Number.isFinite(pricePence) || !from || Number.isNaN(from.getTime())) continue;

      const parts = toZonedParts(from, timeZone);
      const ymd = ymdFromParts(parts);
      if (ymd !== tomorrowDate) continue;
      if (parts.hour == null || parts.hour < 0 || parts.hour > 23) continue;

      sums[parts.hour] += pricePence;
      counts[parts.hour] += 1;
    }

    const hourlyPrices = sums.map((sum, idx) => {
      const c = counts[idx];
      if (!c) return 0;
      return Math.round((sum / c) * 10) / 10;
    });

    const peakPrice = Math.max(...hourlyPrices);
    const peakHour = hourlyPrices.indexOf(peakPrice);
    const averagePrice =
      hourlyPrices.reduce((acc, v) => acc + v, 0) / hourlyPrices.length;
    const status = peakPrice > 0 && peakPrice >= averagePrice * 1.35 ? 'PEAK' : 'NORMAL';

    setGlobalMarketCache(market, {
      timestamp: new Date().toISOString(),
      tomorrowDate,
      tomorrowPrices: hourlyPrices,
      peakHour,
      peakPrice,
      averagePrice,
      status,
      source: 'octopus_public',
    });
  } catch (error) {
    const prev = globalPriceCache[market];
    if (prev?.timestamp) return;
    const mock = buildMockHourlyPrices({ base: 95, swing: 45, peakHour: 18 });
    setGlobalMarketCache(market, {
      timestamp: new Date().toISOString(),
      tomorrowDate,
      tomorrowPrices: mock.tomorrowPrices,
      peakHour: mock.peakHour,
      peakPrice: mock.peakPrice,
      averagePrice: mock.averagePrice,
      status: mock.status,
      source: 'fallback',
    });
  }
}

async function fetchAndCacheUsTxEiaData() {
  const market = 'US_TX';
  const tomorrowDate = getTomorrowDateYmd();
  const timeZone = 'America/Chicago';
  const tomorrowDateTx = getTomorrowDateYmdInTz(timeZone);
  const apiUrl = (
    process.env.EIA_TOMORROW_API_URL ??
    'https://api.eia.gov/v2/electricity/rto/day-ahead-price/data/'
  )
    .toString()
    .trim();
  const apiKey = (process.env.EIA_API_KEY ?? '').toString().trim();
  const respondent = (process.env.EIA_RESPONDENT ?? 'ERCO')
    .toString()
    .trim()
    .toUpperCase();

  try {
    if (!apiUrl || !apiKey) {
      const mock = buildMockHourlyPrices({ base: 80, swing: 65, peakHour: 16 });
      setGlobalMarketCache(market, {
        timestamp: new Date().toISOString(),
        tomorrowDate: tomorrowDateTx,
        tomorrowPrices: mock.tomorrowPrices,
        peakHour: mock.peakHour,
        peakPrice: mock.peakPrice,
        averagePrice: mock.averagePrice,
        status: mock.status,
        source: 'mock',
      });
      return;
    }

    const response = await axios.get(apiUrl, {
      params: {
        api_key: apiKey,
        frequency: 'hourly',
        'data[0]': 'price',
        [`facets[respondent][]`]: respondent,
        'sort[0][column]': 'period',
        'sort[0][direction]': 'desc',
        length: 500,
        offset: 0,
      },
      timeout: 20000,
    });
    const rows = Array.isArray(response.data?.response?.data)
      ? response.data.response.data
      : null;
    if (!rows || rows.length === 0) throw new Error('invalid_eia_payload');

    const prices = new Array(24).fill(0);
    const targetIsoDate = ymdToIsoDate(tomorrowDateTx);
    if (!targetIsoDate) throw new Error('invalid_tomorrow_date');

    for (const row of rows) {
      const period = (row?.period ?? '').toString();
      if (!period.startsWith(targetIsoDate)) continue;

      const match = period.match(/T(\d{1,2})/);
      if (!match) continue;
      const hour = Number(match[1]);
      if (!Number.isFinite(hour) || hour < 0 || hour > 23) continue;

      const priceMwh = Number(row?.price);
      if (!Number.isFinite(priceMwh)) continue;

      const pricePerKwhUsd = priceMwh / 1000;
      prices[hour] = pricePerKwhUsd;
    }
    const peakPrice = Math.max(...prices);
    const peakHour = prices.indexOf(peakPrice);
    const averagePrice = prices.reduce((acc, v) => acc + v, 0) / prices.length;

    setGlobalMarketCache(market, {
      timestamp: new Date().toISOString(),
      tomorrowDate: tomorrowDateTx,
      tomorrowPrices: prices,
      peakHour,
      peakPrice,
      averagePrice,
      status: peakPrice > 0 && peakPrice >= averagePrice * 1.35 ? 'PEAK' : 'NORMAL',
      source: 'eia_rto',
    });
  } catch (error) {
    const prev = globalPriceCache[market];
    if (prev?.timestamp) return;
    const mock = buildMockHourlyPrices({ base: 80, swing: 65, peakHour: 16 });
    setGlobalMarketCache(market, {
      timestamp: new Date().toISOString(),
      tomorrowDate: tomorrowDateTx ?? tomorrowDate,
      tomorrowPrices: mock.tomorrowPrices,
      peakHour: mock.peakHour,
      peakPrice: mock.peakPrice,
      averagePrice: mock.averagePrice,
      status: mock.status,
      source: 'fallback',
    });
  }
}

exports.getCachedPowerPrice = (req, res) => {
  if (!cachedKepcoData.timestamp) {
    fetchAndCacheKepcoData();
    return res.status(200).json({
      success: true,
      data: {
        timestamp: null,
        tomorrowDate: null,
        tomorrowPrices: [],
        peakHour: null,
        peakPrice: 0,
        averagePrice: 0,
        status: 'NORMAL',
        source: 'warming',
      },
    });
  }

  return res.status(200).json({ success: true, data: cachedKepcoData });
};

exports.forceRefreshPrice = async (req, res) => {
  if (!assertCronAuth(req, res)) return;

  console.log('[GitHub Action] 스케줄러 요청 수신. 한전 데이터를 갱신합니다.');
  await fetchAndCacheKepcoData();
  return res.status(200).json({
    success: true,
    message: '한전 데이터 캐시가 성공적으로 갱신되었습니다.',
  });
};

exports.listGlobalMarkets = (req, res) => {
  return res.status(200).json({
    success: true,
    markets: Object.keys(globalPriceCache).sort(),
  });
};

exports.getGlobalPowerPrice = async (req, res) => {
  const market = normalizeMarket(req.query?.market);

  if (market === 'KR') {
    if (!cachedKepcoData.timestamp) await fetchAndCacheKepcoData();
  } else if (market === 'UK_LONDON') {
    if (!globalPriceCache.UK_LONDON?.timestamp) await fetchAndCacheUkOctopusData();
  } else if (market === 'US_TX') {
    if (!globalPriceCache.US_TX?.timestamp) await fetchAndCacheUsTxEiaData();
  }

  const data = globalPriceCache[market];
  if (!data) {
    return res.status(404).json({ success: false, message: '지원하지 않는 market 입니다.' });
  }
  return res.status(200).json({ success: true, market, data });
};

exports.forceRefreshGlobalPrices = async (req, res) => {
  if (!assertCronAuth(req, res)) return;

  await Promise.allSettled([
    fetchAndCacheKepcoData(),
    fetchAndCacheUkOctopusData(),
    fetchAndCacheUsTxEiaData(),
  ]);

  return res.status(200).json({
    success: true,
    markets: Object.keys(globalPriceCache).sort(),
    message: '글로벌 전기요금 캐시가 갱신되었습니다.',
  });
};

exports.getKepcoCacheSnapshot = () => {
  return cachedKepcoData;
};

exports.syncKr = async (req, res) => {
  if (!assertCronAuth(req, res)) return;
  await fetchAndCacheKepcoData();
  return res.status(200).json({ success: true, market: 'KR' });
};

exports.syncUk = async (req, res) => {
  if (!assertCronAuth(req, res)) return;
  await fetchAndCacheUkOctopusData();
  return res.status(200).json({ success: true, market: 'UK_LONDON' });
};

exports.syncUs = async (req, res) => {
  if (!assertCronAuth(req, res)) return;
  await fetchAndCacheUsTxEiaData();
  return res.status(200).json({ success: true, market: 'US_TX' });
};
