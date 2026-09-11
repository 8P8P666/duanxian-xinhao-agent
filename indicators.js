/**
 * 技术指标计算引擎
 * 作用：在浏览器里根据K线数据计算 MACD、RSI、KDJ、BOLL 四个指标
 * 说明：全部为标准公式实现，计算结果只来自真实K线，不含任何预设或模拟数值
 */

/* ============================================================
 * 基础工具
 * ============================================================ */

/** 指数移动平均 EMA（Exponential Moving Average，指数移动平均线） */
function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || !Number.isFinite(v)) continue;
    prev = prev === null ? v : v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** 简单移动平均 MA（Simple Moving Average，简单移动平均线） */
function sma(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    let ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      const v = values[j];
      if (v === null || !Number.isFinite(v)) {
        ok = false;
        break;
      }
      sum += v;
    }
    if (ok) out[i] = sum / period;
  }
  return out;
}

/** 总体标准差（用于布林带上下轨） */
function stdev(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const win = values.slice(i - period + 1, i + 1);
    if (win.some((v) => v === null || !Number.isFinite(v))) continue;
    const mean = win.reduce((a, b) => a + b, 0) / period;
    const variance = win.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    out[i] = Math.sqrt(variance);
  }
  return out;
}

/* ============================================================
 * MACD（Moving Average Convergence Divergence，指数平滑异同移动平均线）
 * 参数：快线 12、慢线 26、信号线 9
 * ============================================================ */
function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const dif = closes.map((_, i) =>
    emaFast[i] !== null && emaSlow[i] !== null ? emaFast[i] - emaSlow[i] : null,
  );
  // DEA 是对 DIF 再做一次 EMA，需要跳过前面的空值
  const validStart = dif.findIndex((v) => v !== null);
  const difValid = dif.slice(validStart);
  const deaValid = ema(difValid, signal);
  const dea = new Array(closes.length).fill(null);
  deaValid.forEach((v, i) => {
    dea[validStart + i] = v;
  });
  const hist = closes.map((_, i) =>
    dif[i] !== null && dea[i] !== null ? (dif[i] - dea[i]) * 2 : null,
  );
  return { dif, dea, hist };
}

/* ============================================================
 * RSI（Relative Strength Index，相对强弱指标）
 * 参数：14，采用 Wilder 平滑，是行业通用口径
 * ============================================================ */
function calcRSI(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/* ============================================================
 * KDJ（随机指标）
 * 参数：N=9, M1=3, M2=3
 * ============================================================ */
function calcKDJ(highs, lows, closes, n = 9, m1 = 3, m2 = 3) {
  const K = new Array(closes.length).fill(null);
  const D = new Array(closes.length).fill(null);
  const J = new Array(closes.length).fill(null);
  let prevK = 50;
  let prevD = 50;

  for (let i = 0; i < closes.length; i++) {
    if (i < n - 1) continue;
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      if (highs[j] > hh) hh = highs[j];
      if (lows[j] < ll) ll = lows[j];
    }
    // RSV：未成熟随机值，表示收盘价在近期区间中的相对位置
    const rsv = hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100;
    prevK = ((m1 - 1) * prevK + rsv) / m1;
    prevD = ((m2 - 1) * prevD + prevK) / m2;
    K[i] = prevK;
    D[i] = prevD;
    J[i] = 3 * prevK - 2 * prevD;
  }
  return { K, D, J };
}

/* ============================================================
 * BOLL（Bollinger Bands，布林带）
 * 参数：20 周期，2 倍标准差
 * ============================================================ */
function calcBOLL(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const sd = stdev(closes, period);
  const upper = closes.map((_, i) =>
    mid[i] !== null && sd[i] !== null ? mid[i] + mult * sd[i] : null,
  );
  const lower = closes.map((_, i) =>
    mid[i] !== null && sd[i] !== null ? mid[i] - mult * sd[i] : null,
  );
  // 带宽：衡量波动幅度，带宽收窄常代表方向待选择
  const bandwidth = closes.map((_, i) =>
    mid[i] && upper[i] !== null && lower[i] !== null ? ((upper[i] - lower[i]) / mid[i]) * 100 : null,
  );
  return { mid, upper, lower, bandwidth };
}

/* ============================================================
 * 汇总计算
 * ============================================================ */

/**
 * 传入K线数组，返回所有指标序列
 * @param {Array} candles [{t,o,h,l,c,v}, ...]，按时间升序
 */
function calcAll(candles) {
  const closes = candles.map((c) => c.c);
  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);
  const volumes = candles.map((c) => c.v);

  const macd = calcMACD(closes);
  const rsi = calcRSI(closes);
  const kdj = calcKDJ(highs, lows, closes);
  const boll = calcBOLL(closes);

  return {
    // 原始K线也要往下传，过滤规则需要用到每根K线的开高低收
    candles,
    closes,
    highs,
    lows,
    volumes,
    macd,
    rsi,
    kdj,
    boll,
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    volMa20: sma(volumes, 20),
  };
}

window.Indicators = { calcAll, ema, sma, calcMACD, calcRSI, calcKDJ, calcBOLL };
