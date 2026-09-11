/**
 * 浏览器直连数据模块
 *
 * 作用：当页面上没有部署云端接口代理（例如把 static 目录直接拖到 Netlify Drop、
 * 或直接放在静态空间）时，由浏览器直接访问 Gate 与 Hyperliquid 的公开行情接口。
 *
 * 与 netlify/functions/_data.cjs 的关系：
 *   两者计算口径完全一致，只是运行位置不同（一个在服务器、一个在浏览器）。
 *   ⚠️ 如果修改了其中一个的取数逻辑或换算口径，必须同步修改另一个，否则两条路径的结果会不一致。
 *
 * 说明：只读取公开行情数据，不需要密钥，不涉及下单，不保存任何私钥。
 */

(function () {
  'use strict';

  const TIMEOUT_MS = 12000; // 单个请求最长等待时间，避免页面一直转圈

  /**
   * 把交易所返回的英文错误码翻译成中文提示。
   * 交易所的报错是英文的，直接显示给用户会看不懂，所以统一在这里转换。
   */
  function describeUpstreamError(status, text) {
    const raw = String(text || '');
    const known = {
      CONTRACT_NOT_FOUND: '该合约在交易所不存在（可能是币种名写错，或该币种没有永续合约）',
      CURRENCY_PAIR_NOT_FOUND: '该交易对在交易所不存在（可能是币种名写错，或该币种没有现货）',
      INVALID_CURRENCY_PAIR: '交易对名称格式不正确，正确格式类似 BTC_USDT',
      INVALID_PARAM_VALUE: '请求参数不符合交易所要求（可能是周期不被支持）',
      TOO_MANY_REQUESTS: '请求过于频繁，被交易所限流，请稍后重试',
      FORBIDDEN: '交易所拒绝了这次请求（可能被限流或该地区不可访问）',
    };
    const hit = Object.keys(known).find((k) => raw.includes(k));
    if (hit) return known[hit];
    // 404 通常是币种或交易对不存在
    if (status === 404) return '交易所找不到这个币种或交易对';
    if (status === 429) return '请求过于频繁，被交易所限流，请稍后重试';
    if (status >= 500) return '交易所服务临时异常，请稍后重试';
    return `交易所接口返回了错误（状态码 ${status}）：${raw.slice(0, 120)}`;
  }

  /** 带超时的 fetch，返回 JSON；失败时抛出可读的中文错误 */
  async function fetchJson(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(describeUpstreamError(res.status, text));
      }
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new Error('交易所返回的内容无法解析，可能是接口临时调整');
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('交易所接口响应超时（超过 12 秒）');
      }
      // 浏览器层面的网络失败（断网、被拦截、跨域被拒）
      if (err.name === 'TypeError' || String(err.message || '').includes('Failed to fetch')) {
        throw new Error('网络无法连接交易所接口，请检查网络后重试');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 把数字安全转成 Number，失败返回 null，避免出现 NaN 污染前端 */
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /* ============================================================
   * 周期定义：与云端模块保持一致
   * ============================================================ */

  const INTERVALS = {
    '1m': { ms: 60 * 1000, label: '1分钟' },
    '5m': { ms: 5 * 60 * 1000, label: '5分钟' },
    '15m': { ms: 15 * 60 * 1000, label: '15分钟' },
    '30m': { ms: 30 * 60 * 1000, label: '30分钟' },
    '1h': { ms: 60 * 60 * 1000, label: '1小时' },
    '4h': { ms: 4 * 60 * 60 * 1000, label: '4小时' },
    '1d': { ms: 24 * 60 * 60 * 1000, label: '1天' },
  };

  function normalizeInterval(raw) {
    const key = String(raw || '15m').trim();
    return INTERVALS[key] ? key : '15m';
  }

  /* ============================================================
   * Hyperliquid 部分（备用与增强数据源）
   * ============================================================ */

  const HL_BASE = 'https://api.hyperliquid.xyz/info';

  async function hlPost(body) {
    return fetchJson(HL_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** Hyperliquid 全市场永续合约行情快照 */
  async function hlAssetContexts() {
    const data = await hlPost({ type: 'metaAndAssetCtxs' });
    if (!Array.isArray(data) || data.length < 2) {
      throw new Error('链上永续平台返回结构异常');
    }
    const universe = (data[0] && data[0].universe) || [];
    const ctxs = data[1] || [];
    const map = new Map();
    universe.forEach((u, i) => {
      const ctx = ctxs[i] || {};
      const markPx = num(ctx.markPx);
      const openInterest = num(ctx.openInterest);
      const fundingHourly = num(ctx.funding);
      map.set(u.name, {
        name: u.name,
        delisted: !!u.isDelisted,
        maxLeverage: num(u.maxLeverage),
        markPrice: markPx,
        oraclePrice: num(ctx.oraclePx),
        midPrice: num(ctx.midPx),
        prevDayPx: num(ctx.prevDayPx),
        dayBaseVolume: num(ctx.dayBaseVlm),
        dayNotionalVolume: num(ctx.dayNtlVlm),
        openInterestCoins: openInterest,
        // 持仓量换算成美元名义价值，方便与其他平台对比
        openInterestUsd:
          openInterest !== null && markPx !== null ? openInterest * markPx : null,
        premium: num(ctx.premium),
        // 每小时资金费率换算成年化：× 24 小时 × 365 天
        fundingHourly,
        fundingAnnualized: fundingHourly === null ? null : fundingHourly * 24 * 365,
      });
    });
    return map;
  }

  /** Hyperliquid K线：需要传开始时间，取最近 limit 根 */
  async function hlCandles(coin, interval, limit) {
    const now = Date.now();
    const step = INTERVALS[interval].ms;
    // 多取一些窗口，避免因停盘或数据缺失导致根数不足
    const startTime = now - step * (limit + 20);
    const rows = await hlPost({
      type: 'candleSnapshot',
      req: { coin, interval, startTime, endTime: now },
    });
    if (!Array.isArray(rows)) {
      throw new Error('链上永续平台K线返回结构异常，请确认该币种是否存在永续合约');
    }
    return rows
      .map((r) => ({
        t: num(r.t),
        o: num(r.o),
        h: num(r.h),
        l: num(r.l),
        c: num(r.c),
        v: num(r.v),
      }))
      .filter((c) => c.t !== null && c.c !== null)
      .sort((a, b) => a.t - b.t)
      .slice(-limit);
  }

  /* ============================================================
   * Gate 部分（主数据源）
   * ============================================================ */

  const GATE_BASE = 'https://api.gateio.ws/api/v4';

  /** Gate 现货K线：返回数组套数组，字段顺序固定 */
  async function gateSpotCandles(pair, interval, limit) {
    const url = `${GATE_BASE}/spot/candlesticks?currency_pair=${encodeURIComponent(pair)}&interval=${interval}&limit=${limit}`;
    const rows = await fetchJson(url);
    if (!Array.isArray(rows)) {
      throw new Error('综合交易平台现货K线返回结构异常，请确认交易对是否存在');
    }
    // 字段顺序：[时间戳(秒), 计价成交额, 收盘, 最高, 最低, 开盘, 基础成交量, 是否收线]
    return rows
      .map((r) => ({
        t: num(r[0]) !== null ? num(r[0]) * 1000 : null,
        c: num(r[2]),
        h: num(r[3]),
        l: num(r[4]),
        o: num(r[5]),
        v: num(r[6]),
      }))
      .filter((c) => c.t !== null && c.c !== null)
      .sort((a, b) => a.t - b.t)
      .slice(-limit);
  }

  /** Gate 永续合约K线：返回对象数组 */
  async function gateFuturesCandles(contract, interval, limit) {
    const url = `${GATE_BASE}/futures/usdt/candlesticks?contract=${encodeURIComponent(contract)}&interval=${interval}&limit=${limit}`;
    const rows = await fetchJson(url);
    if (!Array.isArray(rows)) {
      throw new Error('综合交易平台永续K线返回结构异常，请确认合约是否存在');
    }
    return rows
      .map((r) => ({
        t: num(r.t) !== null ? num(r.t) * 1000 : null,
        o: num(r.o),
        h: num(r.h),
        l: num(r.l),
        c: num(r.c),
        v: num(r.v),
      }))
      .filter((c) => c.t !== null && c.c !== null)
      .sort((a, b) => a.t - b.t)
      .slice(-limit);
  }

  /** Gate 现货行情摘要 */
  async function gateSpotTicker(pair) {
    const url = `${GATE_BASE}/spot/tickers?currency_pair=${encodeURIComponent(pair)}`;
    const rows = await fetchJson(url);
    const t = Array.isArray(rows) ? rows[0] : null;
    if (!t) throw new Error('综合交易平台现货行情返回为空，请确认交易对是否存在');
    return {
      last: num(t.last),
      changePercent24h: num(t.change_percentage),
      high24h: num(t.high_24h),
      low24h: num(t.low_24h),
      baseVolume24h: num(t.base_volume),
      quoteVolume24h: num(t.quote_volume),
      bestBid: num(t.highest_bid),
      bestAsk: num(t.lowest_ask),
      markPrice: null,
      indexPrice: null,
      openInterestUsd: null,
      fundingAnnualized: null,
      fundingRaw: null,
      fundingIntervalLabel: null,
    };
  }

  /** Gate 永续行情摘要；持仓量与资金费率需要额外换算口径 */
  async function gateFuturesTicker(contract) {
    const url = `${GATE_BASE}/futures/usdt/tickers?contract=${encodeURIComponent(contract)}`;
    const rows = await fetchJson(url);
    const t = Array.isArray(rows) ? rows[0] : null;
    if (!t) throw new Error('综合交易平台永续行情返回为空，请确认合约是否存在');
    const markPrice = num(t.mark_price);
    // Gate 永续持仓量以「张」为单位，需要乘合约乘数再乘标记价换成美元
    const totalSize = num(t.total_size);
    const multiplier = num(t.quanto_multiplier);
    let openInterestUsd = null;
    if (totalSize !== null && multiplier !== null && markPrice !== null) {
      openInterestUsd = totalSize * multiplier * markPrice;
    }
    // Gate USDT 永续的资金费率按 8 小时结算；换算年化需 × 3 次/天 × 365 天
    const fundingRaw = num(t.funding_rate);
    return {
      last: num(t.last),
      changePercent24h: num(t.change_percentage),
      high24h: num(t.high_24h),
      low24h: num(t.low_24h),
      baseVolume24h: num(t.volume_24h_base),
      quoteVolume24h: num(t.volume_24h_quote),
      bestBid: num(t.highest_bid),
      bestAsk: num(t.lowest_ask),
      markPrice,
      indexPrice: num(t.index_price),
      openInterestUsd,
      fundingRaw,
      fundingIntervalLabel: '8小时',
      fundingAnnualized: fundingRaw === null ? null : fundingRaw * 3 * 365,
    };
  }

  /** Gate 可交易币种列表，按 24 小时成交额排序取前 N 个 */
  async function gateSymbols(market, topN) {
    if (market === 'perp') {
      const rows = await fetchJson(`${GATE_BASE}/futures/usdt/tickers`);
      return rows
        .filter((r) => String(r.contract || '').endsWith('_USDT'))
        .map((r) => ({
          symbol: r.contract,
          display: String(r.contract || '').replace('_USDT', '/USDT'),
          base: String(r.contract || '').replace('_USDT', ''),
          quoteVolume24h: num(r.volume_24h_quote),
          changePercent24h: num(r.change_percentage),
          last: num(r.last),
        }))
        .filter((s) => s.symbol && s.quoteVolume24h !== null)
        .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
        .slice(0, topN);
    }
    const rows = await fetchJson(`${GATE_BASE}/spot/tickers`);
    return rows
      .filter((r) => String(r.currency_pair || '').endsWith('_USDT'))
      .map((r) => ({
        symbol: r.currency_pair,
        display: String(r.currency_pair || '').replace('_USDT', '/USDT'),
        base: String(r.currency_pair || '').replace('_USDT', ''),
        quoteVolume24h: num(r.quote_volume),
        changePercent24h: num(r.change_percentage),
        last: num(r.last),
      }))
      .filter((s) => s.symbol && s.quoteVolume24h !== null)
      .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
      .slice(0, topN);
  }

  /** Hyperliquid 可交易币种列表，排除已下架市场 */
  async function hlSymbols(topN) {
    const map = await hlAssetContexts();
    const list = [];
    map.forEach((v) => {
      if (v.delisted) return;
      // 只保留普通币种名，跳过 xyz: 之类的 builder 市场命名
      if (v.name.includes(':')) return;
      list.push({
        symbol: v.name,
        display: `${v.name}/USDT`,
        base: v.name,
        quoteVolume24h: v.dayNotionalVolume,
        changePercent24h:
          v.prevDayPx && v.markPrice ? ((v.markPrice - v.prevDayPx) / v.prevDayPx) * 100 : null,
        last: v.markPrice,
      });
    });
    return list
      .filter((s) => s.quoteVolume24h !== null)
      .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
      .slice(0, topN);
  }

  /* ============================================================
   * 对外统一入口（输出结构与云端接口完全一致）
   * ============================================================ */

  /** 取单个平台的行情与K线 */
  async function getMarket({ platform, market, symbol, interval, limit = 300 }) {
    const iv = normalizeInterval(interval);

    if (platform === 'hyperliquid') {
      // Hyperliquid 只有永续合约，没有现货
      const contexts = await hlAssetContexts();
      const ctx = contexts.get(symbol);
      if (!ctx) {
        throw new Error(`链上永续平台找不到币种 ${symbol} 的永续合约`);
      }
      const candles = await hlCandles(symbol, iv, limit);
      if (candles.length < 30) {
        throw new Error(`链上永续平台返回的K线数量不足（只有 ${candles.length} 根），无法计算指标`);
      }
      const changePercent =
        ctx.prevDayPx && ctx.markPrice
          ? ((ctx.markPrice - ctx.prevDayPx) / ctx.prevDayPx) * 100
          : null;
      return {
        platform: 'hyperliquid',
        market: 'perp',
        symbol,
        display: `${symbol}/USDT`,
        interval: iv,
        intervalLabel: INTERVALS[iv].label,
        sourceLabel: '链上永续平台公开行情接口',
        ticker: {
          last: ctx.midPrice !== null ? ctx.midPrice : ctx.markPrice,
          changePercent24h: changePercent,
          high24h: null,
          low24h: null,
          baseVolume24h: ctx.dayBaseVolume,
          quoteVolume24h: ctx.dayNotionalVolume,
          bestBid: null,
          bestAsk: null,
          markPrice: ctx.markPrice,
          indexPrice: ctx.oraclePrice,
          openInterestUsd: ctx.openInterestUsd,
          fundingRaw: ctx.fundingHourly,
          fundingIntervalLabel: '1小时',
          fundingAnnualized: ctx.fundingAnnualized,
          maxLeverage: ctx.maxLeverage,
        },
        candles,
      };
    }

    // 默认走 Gate
    const isPerp = market !== 'spot';
    const pair = String(symbol || 'BTC_USDT').toUpperCase();
    const ticker = isPerp ? await gateFuturesTicker(pair) : await gateSpotTicker(pair);
    const candles = isPerp
      ? await gateFuturesCandles(pair, iv, limit)
      : await gateSpotCandles(pair, iv, limit);
    if (candles.length < 30) {
      throw new Error(`综合交易平台返回的K线数量不足（只有 ${candles.length} 根），无法计算指标`);
    }
    return {
      platform: 'gate',
      market: isPerp ? 'perp' : 'spot',
      symbol: pair,
      display: pair.replace('_USDT', '/USDT'),
      interval: iv,
      intervalLabel: INTERVALS[iv].label,
      sourceLabel: isPerp
        ? '综合交易平台公开行情接口（USDT 永续合约）'
        : '综合交易平台公开行情接口（现货）',
      ticker: { ...ticker, maxLeverage: null },
      candles,
    };
  }

  /** 把另一个平台的同一币种价格取出来，用于跨平台对照（真实数据，不做任何推算） */
  async function getCrossReference({ symbol, market }) {
    const base = String(symbol || 'BTC_USDT')
      .toUpperCase()
      .replace('_USDT', '');
    try {
      const contexts = await hlAssetContexts();
      const ctx = contexts.get(base);
      if (!ctx || ctx.delisted) return null;
      return {
        platform: 'hyperliquid',
        symbol: base,
        price: ctx.midPrice !== null ? ctx.midPrice : ctx.markPrice,
        markPrice: ctx.markPrice,
        oraclePrice: ctx.oraclePrice,
        openInterestUsd: ctx.openInterestUsd,
        fundingRaw: ctx.fundingHourly,
        fundingIntervalLabel: '1小时',
        fundingAnnualized: ctx.fundingAnnualized,
        dayNotionalVolume: ctx.dayNotionalVolume,
      };
    } catch (e) {
      // 增强数据源失败不影响主流程，前端会显示「暂不可用」
      return null;
    }
  }

  /** 同时取 Gate 与 Hyperliquid 的价格，做真实的跨平台对照 */
  async function getPlatformComparison({ symbol, market }) {
    const base = String(symbol || 'BTC_USDT')
      .toUpperCase()
      .replace('_USDT', '');
    const result = { gate: null, hyperliquid: null, errors: [] };

    // Gate 侧
    try {
      const isPerp = market !== 'spot';
      const pair = `${base}_USDT`;
      const t = isPerp ? await gateFuturesTicker(pair) : await gateSpotTicker(pair);
      result.gate = {
        platform: 'gate',
        symbol: pair,
        market: isPerp ? 'perp' : 'spot',
        price: t.last,
        markPrice: t.markPrice,
        openInterestUsd: t.openInterestUsd,
        fundingRaw: t.fundingRaw,
        fundingIntervalLabel: t.fundingIntervalLabel,
        fundingAnnualized: t.fundingAnnualized,
        quoteVolume24h: t.quoteVolume24h,
        changePercent24h: t.changePercent24h,
      };
    } catch (e) {
      result.errors.push(`综合交易平台：${e.message}`);
    }

    // Hyperliquid 侧
    try {
      const h = await getCrossReference({ symbol, market });
      if (h) result.hyperliquid = h;
      else result.errors.push('链上永续平台：该币种没有对应永续市场');
    } catch (e) {
      result.errors.push(`链上永续平台：${e.message}`);
    }

    // 价差：以 Gate 价格为基准计算百分比，两个价格都存在时才计算
    if (result.gate && result.hyperliquid && result.gate.price && result.hyperliquid.price) {
      const a = result.gate.price;
      const b = result.hyperliquid.price;
      result.spreadAbs = b - a;
      result.spreadPercent = ((b - a) / a) * 100;
    }
    return result;
  }

  /** 行情接口封装，输出结构与 /api/market 一致 */
  async function fetchMarketEnvelope({ platform, market, symbol, interval, limit }) {
    const p = platform === 'hyperliquid' ? 'hyperliquid' : 'gate';
    const m = String(market || 'perp').toLowerCase() === 'spot' ? 'spot' : 'perp';
    const sym = String(symbol || (p === 'hyperliquid' ? 'BTC' : 'BTC_USDT')).trim();
    const iv = String(interval || '15m').trim();
    const lim = Math.min(Math.max(Number(limit) || 300, 60), 800);

    try {
      const data = await getMarket({
        platform: p,
        market: m,
        symbol: sym,
        interval: iv,
        limit: lim,
      });

      // 跨平台对照是「增强信息」，失败不影响主结果，所以单独吞掉错误
      let comparison = null;
      try {
        comparison = await getPlatformComparison({ symbol: sym, market: m });
      } catch (e) {
        comparison = { gate: null, hyperliquid: null, errors: [e.message] };
      }

      return {
        ok: true,
        requestedPlatform: p,
        requestedMarket: m,
        ...data,
        comparison,
        candleCount: data.candles.length,
        fetchedAt: new Date().toISOString(),
        cached: false,
        // 标明这条数据是浏览器直连取得，方便页面区分数据路径
        via: 'direct',
      };
    } catch (err) {
      // 接口失败时明确告诉前端真实原因，绝不返回伪造数据
      return {
        ok: false,
        error: err && err.message ? err.message : '行情接口请求失败',
        requestedPlatform: p,
        requestedMarket: m,
        symbol: sym,
        interval: iv,
        fetchedAt: new Date().toISOString(),
        via: 'direct',
      };
    }
  }

  /** 币种列表封装，输出结构与 /api/symbols 一致 */
  async function fetchSymbolsEnvelope({ platform, market, top }) {
    const p = platform === 'hyperliquid' ? 'hyperliquid' : 'gate';
    const m = String(market || 'perp').toLowerCase() === 'spot' ? 'spot' : 'perp';
    const topN = Math.min(Math.max(Number(top) || 60, 10), 200);

    try {
      const list = p === 'hyperliquid' ? await hlSymbols(topN) : await gateSymbols(m, topN);

      // 把主流币种固定放到前面，保证用户进入页面能马上看到熟悉的名字
      const pinned = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'HYPE'];
      const order = new Map(pinned.map((b, i) => [b, i]));
      list.sort((a, b) => {
        const oa = order.has(a.base) ? order.get(a.base) : 999;
        const ob = order.has(b.base) ? order.get(b.base) : 999;
        if (oa !== ob) return oa - ob;
        return (b.quoteVolume24h || 0) - (a.quoteVolume24h || 0);
      });

      return {
        ok: true,
        platform: p,
        market: p === 'hyperliquid' ? 'perp' : m,
        sourceLabel:
          p === 'hyperliquid'
            ? '链上永续平台公开行情接口'
            : m === 'perp'
              ? '综合交易平台公开行情接口（USDT 永续合约）'
              : '综合交易平台公开行情接口（现货）',
        count: list.length,
        list,
        fetchedAt: new Date().toISOString(),
        cached: false,
        via: 'direct',
      };
    } catch (err) {
      return {
        ok: false,
        error: err && err.message ? err.message : '币种列表获取失败',
        platform: p,
        market: m,
        list: [],
        fetchedAt: new Date().toISOString(),
        via: 'direct',
      };
    }
  }

  window.DataDirect = { fetchMarketEnvelope, fetchSymbolsEnvelope };
})();
