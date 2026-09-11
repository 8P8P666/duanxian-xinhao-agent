/**
 * Netlify Function：/api/symbols
 * 作用：返回当前平台可分析的币种列表（按 24 小时成交额排序）
 * 说明：数据来自知名交易平台的公开行情接口，真实成交额排序，不做人工编造
 */

const { gateSymbols, hlSymbols } = require('./_data.cjs');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'public, max-age=30',
};

// 币种列表变化很慢，缓存 60 秒足够
const CACHE_TTL_MS = 60000;
const cache = new Map();

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const q = event.queryStringParameters || {};
  const platform = String(q.platform || 'gate').toLowerCase() === 'hyperliquid' ? 'hyperliquid' : 'gate';
  const market = String(q.market || 'perp').toLowerCase() === 'spot' ? 'spot' : 'perp';
  const topN = Math.min(Math.max(Number(q.top) || 60, 10), 200);

  const cacheKey = `${platform}|${market}|${topN}`;
  const item = cache.get(cacheKey);
  if (item && Date.now() - item.time < CACHE_TTL_MS) {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ ...item.value, cached: true }),
    };
  }

  try {
    const list =
      platform === 'hyperliquid' ? await hlSymbols(topN) : await gateSymbols(market, topN);

    // 把主流币种固定放到前面，保证用户进入页面能马上看到熟悉的名字
    const pinned = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'HYPE'];
    const order = new Map(pinned.map((b, i) => [b, i]));
    list.sort((a, b) => {
      const oa = order.has(a.base) ? order.get(a.base) : 999;
      const ob = order.has(b.base) ? order.get(b.base) : 999;
      if (oa !== ob) return oa - ob;
      return (b.quoteVolume24h || 0) - (a.quoteVolume24h || 0);
    });

    const payload = {
      ok: true,
      platform,
      market: platform === 'hyperliquid' ? 'perp' : market,
      sourceLabel:
        platform === 'hyperliquid'
          ? '链上永续平台公开行情接口'
          : market === 'perp'
            ? '综合交易平台公开行情接口（USDT 永续合约）'
            : '综合交易平台公开行情接口（现货）',
      count: list.length,
      list,
      fetchedAt: new Date().toISOString(),
      cached: false,
    };
    cache.set(cacheKey, { time: Date.now(), value: payload });
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(payload) };
  } catch (err) {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        ok: false,
        error: err && err.message ? err.message : '币种列表获取失败',
        platform,
        market,
        list: [],
        fetchedAt: new Date().toISOString(),
      }),
    };
  }
};
