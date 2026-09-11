/**
 * Netlify Function：/api/market
 * 作用：把前端的分析请求转发到 Gate / Hyperliquid 公开接口，并统一返回格式
 * 说明：只读取公开行情数据，不涉及下单，不需要任何密钥
 */

const { getMarket, getPlatformComparison } = require('./_data.cjs');

// 简单的内存缓存，减少对上游接口的重复请求（仅在同一台函数实例内有效）
const CACHE_TTL_MS = 6000;
const cache = new Map();

function getCached(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.time > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

function setCached(key, value) {
  cache.set(key, { time: Date.now(), value });
  // 控制缓存体积，避免长期运行占用过多内存
  if (cache.size > 200) {
    const oldest = [...cache.keys()].slice(0, 100);
    oldest.forEach((k) => cache.delete(k));
  }
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
  // 明确告诉浏览器和 Netlify：这是短时效数据
  'Cache-Control': 'public, max-age=6',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const q = event.queryStringParameters || {};
  const platform = String(q.platform || 'gate').toLowerCase() === 'hyperliquid' ? 'hyperliquid' : 'gate';
  const market = String(q.market || 'perp').toLowerCase() === 'spot' ? 'spot' : 'perp';
  const symbol = String(q.symbol || (platform === 'hyperliquid' ? 'BTC' : 'BTC_USDT')).trim();
  const interval = String(q.interval || '15m').trim();
  const limit = Math.min(Math.max(Number(q.limit) || 300, 60), 800);

  const cacheKey = `${platform}|${market}|${symbol}|${interval}|${limit}`;
  const cached = getCached(cacheKey);
  if (cached) {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ ...cached, cached: true }),
    };
  }

  try {
    const data = await getMarket({ platform, market, symbol, interval, limit });

    // 跨平台对照是「增强信息」，失败不影响主结果，所以单独吞掉错误
    let comparison = null;
    try {
      comparison = await getPlatformComparison({ symbol, market });
    } catch (e) {
      comparison = { gate: null, hyperliquid: null, errors: [e.message] };
    }

    const payload = {
      ok: true,
      requestedPlatform: platform,
      requestedMarket: market,
      ...data,
      comparison,
      candleCount: data.candles.length,
      fetchedAt: new Date().toISOString(),
      cached: false,
    };
    setCached(cacheKey, payload);

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(payload) };
  } catch (err) {
    // 接口失败时明确告诉前端真实原因，绝不返回伪造数据
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        ok: false,
        error: err && err.message ? err.message : '行情接口请求失败',
        requestedPlatform: platform,
        requestedMarket: market,
        symbol,
        interval,
        fetchedAt: new Date().toISOString(),
      }),
    };
  }
};
