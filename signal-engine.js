/**
 * 共振判定与假信号过滤引擎
 * 作用：
 *   1. 把 MACD、RSI、KDJ、BOLL 四个指标的方向做投票，得到共振强度
 *   2. 对投票结果做二次过滤，识别容易失效的单一指标信号
 *   3. 输出四档评级：强做多 / 谨慎做多 / 震荡 / 强做空
 *
 * 说明：这里全部是程序化技术信号计算，只用于市场结构观测，不构成任何交易指令
 */

/* ============================================================
 * 评级定义（四档）
 * 注意：按中国习惯，做多用红色、做空用绿色
 * ============================================================ */
const RATINGS = {
  STRONG_LONG: {
    key: 'strong_long',
    label: '强做多',
    tone: 'bull-strong',
    color: '#d92b2b',
    desc: '多个指标方向一致向上，且通过了量能与趋势确认',
  },
  CAUTIOUS_LONG: {
    key: 'cautious_long',
    label: '谨慎做多',
    tone: 'bull-weak',
    color: '#e8752a',
    desc: '偏多指标占多数，但仍有确认条件未完全满足',
  },
  NEUTRAL: {
    key: 'neutral',
    label: '震荡',
    tone: 'neutral',
    color: '#8a7a20',
    desc: '多空指标数量接近，或信号被过滤规则降级',
  },
  STRONG_SHORT: {
    key: 'strong_short',
    label: '强做空',
    tone: 'bear-strong',
    color: '#12864a',
    desc: '多个指标方向一致向下，且通过了量能与趋势确认',
  },
};

/* 指标权重：权重越高，对综合结论影响越大
 * MACD 与 KDJ 对方向拐点更敏感，因此权重略高 */
const WEIGHTS = { macd: 1.2, kdj: 1.0, rsi: 0.9, boll: 1.0 };
const WEIGHT_TOTAL = WEIGHTS.macd + WEIGHTS.kdj + WEIGHTS.rsi + WEIGHTS.boll;

/** 数值安全取值 */
function safe(v) {
  return v === null || v === undefined || !Number.isFinite(v) ? null : v;
}

/** 取某个指标在指定位置的取值 */
function get(series, i) {
  if (!series) return null;
  return safe(series[i]);
}

/* ============================================================
 * 单个指标的方向判定
 * ============================================================ */

/** MACD 方向：DIF 在 DEA 上方为偏多 */
function judgeMACD(ctx, i) {
  const dif = get(ctx.macd.dif, i);
  const dea = get(ctx.macd.dea, i);
  const prevDif = get(ctx.macd.dif, i - 1);
  const prevDea = get(ctx.macd.dea, i - 1);
  const hist = get(ctx.macd.hist, i);
  const prevHist = get(ctx.macd.hist, i - 1);

  if (dif === null || dea === null) {
    return { key: 'macd', name: 'MACD', vote: 0, state: '数据不足', ok: false };
  }

  let vote = dif > dea ? 1 : dif < dea ? -1 : 0;
  let state = vote > 0 ? 'DIF 位于 DEA 上方' : vote < 0 ? 'DIF 位于 DEA 下方' : '两线粘合';

  // 交叉判定：只有真正穿越才算金叉 / 死叉
  let cross = null;
  if (prevDif !== null && prevDea !== null) {
    if (prevDif <= prevDea && dif > dea) {
      cross = 'golden';
      state = '刚刚形成金叉';
    } else if (prevDif >= prevDea && dif < dea) {
      cross = 'dead';
      state = '刚刚形成死叉';
    }
  }

  // 柱状图是否在放大，代表当前动能强弱
  let momentum = 'flat';
  if (hist !== null && prevHist !== null) {
    if (Math.abs(hist) > Math.abs(prevHist)) momentum = hist > 0 ? 'expanding-up' : 'expanding-down';
    else momentum = 'shrinking';
  }

  return { key: 'macd', name: 'MACD', vote, state, cross, momentum, dif, dea, hist, ok: true };
}

/** RSI 方向：55 以上偏多，45 以下偏空，中间视为中性 */
function judgeRSI(ctx, i) {
  const rsi = get(ctx.rsi, i);
  const prevRsi = get(ctx.rsi, i - 1);
  if (rsi === null) {
    return { key: 'rsi', name: 'RSI', vote: 0, state: '数据不足', ok: false };
  }

  let vote = 0;
  let state = '处于中性区间';
  if (rsi >= 55) {
    vote = 1;
    state = '买方力量占优';
  } else if (rsi <= 45) {
    vote = -1;
    state = '卖方力量占优';
  }

  let zone = 'normal';
  if (rsi >= 70) {
    zone = 'overbought';
    state = '进入超买区域';
  } else if (rsi <= 30) {
    zone = 'oversold';
    state = '进入超卖区域';
  }

  let slope = 'flat';
  if (prevRsi !== null) {
    if (rsi - prevRsi > 0.5) slope = 'up';
    else if (prevRsi - rsi > 0.5) slope = 'down';
  }

  return { key: 'rsi', name: 'RSI', vote, state, zone, slope, value: rsi, ok: true };
}

/** KDJ 方向：K 在 D 上方为偏多 */
function judgeKDJ(ctx, i) {
  const k = get(ctx.kdj.K, i);
  const d = get(ctx.kdj.D, i);
  const j = get(ctx.kdj.J, i);
  const prevK = get(ctx.kdj.K, i - 1);
  const prevD = get(ctx.kdj.D, i - 1);
  if (k === null || d === null) {
    return { key: 'kdj', name: 'KDJ', vote: 0, state: '数据不足', ok: false };
  }

  const vote = k > d ? 1 : k < d ? -1 : 0;
  let state = vote > 0 ? 'K 线在 D 线上方' : vote < 0 ? 'K 线在 D 线下方' : '两线粘合';
  let cross = null;
  if (prevK !== null && prevD !== null) {
    if (prevK <= prevD && k > d) {
      cross = 'golden';
      state = '刚刚形成金叉';
    } else if (prevK >= prevD && k < d) {
      cross = 'dead';
      state = '刚刚形成死叉';
    }
  }

  let zone = 'normal';
  if (j !== null && j > 100) zone = 'overbought';
  if (j !== null && j < 0) zone = 'oversold';

  return { key: 'kdj', name: 'KDJ', vote, state, cross, zone, k, d, j, ok: true };
}

/** BOLL 方向：收盘价在中轨上方偏多 */
function judgeBOLL(ctx, i) {
  const close = get(ctx.closes, i);
  const mid = get(ctx.boll.mid, i);
  const upper = get(ctx.boll.upper, i);
  const lower = get(ctx.boll.lower, i);
  const bandwidth = get(ctx.boll.bandwidth, i);
  if (close === null || mid === null) {
    return { key: 'boll', name: 'BOLL', vote: 0, state: '数据不足', ok: false };
  }

  const vote = close > mid ? 1 : close < mid ? -1 : 0;
  let state = vote > 0 ? '价格运行在中轨上方' : vote < 0 ? '价格运行在中轨下方' : '价格贴在中轨';

  // %B：价格在布林通道中的相对位置，0 为下轨，1 为上轨
  let percentB = null;
  if (upper !== null && lower !== null && upper !== lower) {
    percentB = (close - lower) / (upper - lower);
  }

  return {
    key: 'boll',
    name: 'BOLL',
    vote,
    state,
    mid,
    upper,
    lower,
    bandwidth,
    percentB,
    ok: true,
  };
}

/* ============================================================
 * 假信号过滤规则
 * 每条规则返回：是否触发、说明文字、对综合评分的影响（负分代表降级）
 * ============================================================ */

function runFilters(ctx, i, judges, direction, price, volIndex) {
  const filters = [];
  const bullVotes = judges.filter((j) => j.vote > 0).length;
  const bearVotes = judges.filter((j) => j.vote < 0).length;
  const directional = bullVotes + bearVotes;
  // 判断当前这根K线是否还在形成中；形成中的K线成交量不完整，不能用来做量能比较
  const usingClosedCandle = volIndex !== i;

  /* 规则一：孤立信号
   * 只有 1 个指标给出方向，其余全部中性 —— 这就是典型的单一指标信号 */
  let penaltyIsolated = 0;
  if (directional <= 1) {
    penaltyIsolated = -22;
    filters.push({
      id: 'isolated',
      name: '孤立信号检查',
      status: 'trigger',
      detail: `四个指标中只有 ${directional} 个给出明确方向，其余处于中性。这属于单一指标信号，历史上容易失效，已强制降级。`,
      penalty: penaltyIsolated,
    });
  } else {
    filters.push({
      id: 'isolated',
      name: '孤立信号检查',
      status: 'pass',
      detail: `四个指标中有 ${directional} 个给出明确方向，已脱离单一指标信号的范围。`,
      penalty: 0,
    });
  }

  /* 规则二：量能确认
   * 成交量低于 20 根均量的 80%，说明价格变化缺少资金参与
   * 注意：只使用已经收线的K线做比较，正在形成中的K线成交量不完整，用它比较会误判为缩量 */
  let penaltyVolume = 0;
  const vol = get(ctx.volumes, volIndex);
  const volMa = get(ctx.volMa20, volIndex);
  const volPrefix = usingClosedCandle ? '上一根已收线K线的成交量' : '当前成交量';
  let volumeRatio = null;
  if (vol !== null && volMa !== null && volMa > 0) {
    volumeRatio = vol / volMa;
    if (volumeRatio < 0.8) {
      penaltyVolume = -14;
      filters.push({
        id: 'volume',
        name: '量能确认',
        status: 'trigger',
        detail: `${volPrefix}只有 20 根均量的 ${(volumeRatio * 100).toFixed(0)}%，价格变化缺少资金配合，信号可信度下降。`,
        penalty: penaltyVolume,
      });
    } else {
      filters.push({
        id: 'volume',
        name: '量能确认',
        status: volumeRatio >= 1.2 ? 'pass' : 'ok',
        detail:
          volumeRatio >= 1.2
            ? `${volPrefix}为 20 根均量的 ${(volumeRatio * 100).toFixed(0)}%，属于放量状态，对方向形成确认。`
            : `${volPrefix}为 20 根均量的 ${(volumeRatio * 100).toFixed(0)}%，处于正常水平。`,
        penalty: 0,
      });
    }
  } else {
    filters.push({
      id: 'volume',
      name: '量能确认',
      status: 'ok',
      detail: '成交量数据不足，本项未参与评分。',
      penalty: 0,
    });
  }

  /* 规则三：趋势一致性
   * 用 EMA20 与 EMA50 的相对位置代表中期趋势，逆着中期趋势的短线信号要降级 */
  let penaltyTrend = 0;
  const ema20 = get(ctx.ema20, i);
  const ema50 = get(ctx.ema50, i);
  if (ema20 !== null && ema50 !== null && direction !== 0) {
    const midTrendUp = ema20 > ema50;
    if (direction > 0 && !midTrendUp) {
      penaltyTrend = -16;
      filters.push({
        id: 'trend',
        name: '趋势一致性',
        status: 'trigger',
        detail: '偏多信号与中期趋势相反（EMA20 仍在 EMA50 下方），属于逆势反弹，已降级。',
        penalty: penaltyTrend,
      });
    } else if (direction < 0 && midTrendUp) {
      penaltyTrend = -16;
      filters.push({
        id: 'trend',
        name: '趋势一致性',
        status: 'trigger',
        detail: '偏空信号与中期趋势相反（EMA20 仍在 EMA50 上方），属于逆势回落，已降级。',
        penalty: penaltyTrend,
      });
    } else {
      filters.push({
        id: 'trend',
        name: '趋势一致性',
        status: 'pass',
        detail: `信号方向与中期趋势一致（EMA20 ${midTrendUp ? '高于' : '低于'} EMA50），趋势层已确认。`,
        penalty: 0,
      });
    }
  } else {
    filters.push({
      id: 'trend',
      name: '趋势一致性',
      status: 'ok',
      detail: '趋势数据不足或方向中性，本项未参与评分。',
      penalty: 0,
    });
  }

  /* 规则四：极端值风险
   * 追涨杀跌是假信号的高发区，在极端区域出现的方向信号要降级 */
  let penaltyExtreme = 0;
  const rsi = judges.find((j) => j.key === 'rsi');
  const boll = judges.find((j) => j.key === 'boll');
  if (direction > 0) {
    const rsiV = rsi ? rsi.value : null;
    const pb = boll ? boll.percentB : null;
    if ((rsiV !== null && rsiV >= 75) || (pb !== null && pb >= 1)) {
      penaltyExtreme = -20;
      filters.push({
        id: 'extreme',
        name: '极端值风险',
        status: 'trigger',
        detail: `偏多信号出现在高位区间（RSI ${rsiV !== null ? rsiV.toFixed(1) : '—'}，布林位置 ${pb !== null ? (pb * 100).toFixed(0) + '%' : '—'}），存在追高风险，已降级。`,
        penalty: penaltyExtreme,
      });
    } else {
      filters.push({
        id: 'extreme',
        name: '极端值风险',
        status: 'pass',
        detail: '偏多信号未出现在明显超买区域，未被此项降级。',
        penalty: 0,
      });
    }
  } else if (direction < 0) {
    const rsiV = rsi ? rsi.value : null;
    const pb = boll ? boll.percentB : null;
    if ((rsiV !== null && rsiV <= 25) || (pb !== null && pb <= 0)) {
      penaltyExtreme = -20;
      filters.push({
        id: 'extreme',
        name: '极端值风险',
        status: 'trigger',
        detail: `偏空信号出现在低位区间（RSI ${rsiV !== null ? rsiV.toFixed(1) : '—'}，布林位置 ${pb !== null ? (pb * 100).toFixed(0) + '%' : '—'}），存在杀跌风险，已降级。`,
        penalty: penaltyExtreme,
      });
    } else {
      filters.push({
        id: 'extreme',
        name: '极端值风险',
        status: 'pass',
        detail: '偏空信号未出现在明显超卖区域，未被此项降级。',
        penalty: 0,
      });
    }
  } else {
    filters.push({
      id: 'extreme',
      name: '极端值风险',
      status: 'ok',
      detail: '当前方向为中性，本项未参与评分。',
      penalty: 0,
    });
  }

  /* 规则五：布林带收窄
   * 通道收窄代表波动压缩，方向往往还没选择，此时的方向信号可信度低 */
  let penaltySqueeze = 0;
  const bandwidth = boll ? boll.bandwidth : null;
  if (bandwidth !== null) {
    // 取近 60 根带宽做对比，判断当前是否处于低位
    const from = Math.max(0, i - 59);
    const window = [];
    for (let x = from; x <= i; x++) {
      const bw = get(ctx.boll.bandwidth, x);
      if (bw !== null) window.push(bw);
    }
    window.sort((a, b) => a - b);
    const threshold = window.length >= 20 ? window[Math.floor(window.length * 0.3)] : null;
    if (threshold !== null && bandwidth <= threshold) {
      penaltySqueeze = -12;
      filters.push({
        id: 'squeeze',
        name: '通道收窄检查',
        status: 'trigger',
        detail: `当前布林带带宽 ${bandwidth.toFixed(2)}%，处于近 60 根的偏低水平，波动被压缩，方向尚未选择，已降级。`,
        penalty: penaltySqueeze,
      });
    } else {
      filters.push({
        id: 'squeeze',
        name: '通道收窄检查',
        status: 'pass',
        detail: `当前布林带带宽 ${bandwidth.toFixed(2)}%，波动幅度正常，未被此项降级。`,
        penalty: 0,
      });
    }
  } else {
    filters.push({
      id: 'squeeze',
      name: '通道收窄检查',
      status: 'ok',
      detail: '布林带数据不足，本项未参与评分。',
      penalty: 0,
    });
  }

  /* 规则六：最新K线方向确认
   * 方向信号需要最新一根K线的收盘方向配合；如果这根K线还在形成中，结论会随价格变化而变化 */
  let penaltyCandle = 0;
  const last = ctx.candles[i];
  const prev = ctx.candles[i - 1];
  if (last && prev && direction !== 0) {
    const up = last.c >= prev.c;
    const aligned = (direction > 0 && up) || (direction < 0 && !up);
    const formingNote = usingClosedCandle
      ? '（最新一根K线可能仍在形成中，方向会随价格变化）'
      : '';
    if (!aligned) {
      penaltyCandle = -8;
      filters.push({
        id: 'candle',
        name: 'K线方向确认',
        status: 'trigger',
        detail: `最新K线方向与信号方向不一致（当前收${up ? '涨' : '跌'}）${formingNote}，信号尚未被K线确认，已轻微降级。`,
        penalty: penaltyCandle,
      });
    } else {
      filters.push({
        id: 'candle',
        name: 'K线方向确认',
        status: 'pass',
        detail: `最新K线的收盘方向与信号方向一致${formingNote}。`,
        penalty: 0,
      });
    }
  } else {
    filters.push({
      id: 'candle',
      name: 'K线方向确认',
      status: 'ok',
      detail: 'K线数据不足，本项未参与评分。',
      penalty: 0,
    });
  }

  const totalPenalty =
    penaltyIsolated + penaltyVolume + penaltyTrend + penaltyExtreme + penaltySqueeze + penaltyCandle;

  return { filters, totalPenalty, bullVotes, bearVotes, directional, volumeRatio };
}

/* ============================================================
 * 综合判定
 * ============================================================ */

/** 把评分映射到四档评级 */
function scoreToRating(score) {
  if (score >= 55) return RATINGS.STRONG_LONG;
  if (score >= 25) return RATINGS.CAUTIOUS_LONG;
  if (score > -25) return RATINGS.NEUTRAL;
  return RATINGS.STRONG_SHORT;
}

/**
 * 计算指定K线位置的完整分析结果
 * @param {object} ctx Indicators.calcAll 的返回值
 * @param {number} i 要计算的位置索引
 * @param {boolean} withFilters 是否执行假信号过滤（历史回看时可关闭以节省计算）
 */
function evaluateAt(ctx, i, withFilters = true) {
  const judges = [judgeMACD(ctx, i), judgeRSI(ctx, i), judgeKDJ(ctx, i), judgeBOLL(ctx, i)];

  // 加权基础分
  let raw = 0;
  judges.forEach((j) => {
    if (j.ok) raw += WEIGHTS[j.key] * j.vote;
  });
  const baseScore = (raw / WEIGHT_TOTAL) * 100;

  const direction = baseScore > 12 ? 1 : baseScore < -12 ? -1 : 0;
  const price = get(ctx.closes, i);

  /* 判断最后一根K线是否还在形成中
   * 依据：最后一根K线的开盘时间加上一个周期，如果还没到当前时间，说明它没走完 */
  const n = ctx.candles.length;
  const step = n > 1 ? ctx.candles[n - 1].t - ctx.candles[n - 2].t : 0;
  const lastForming = step > 0 && ctx.candles[n - 1].t + step > Date.now();
  // 量能比较时避开未收线的K线
  const volIndex = i === n - 1 && lastForming ? Math.max(0, i - 1) : i;

  const filtered = withFilters
    ? runFilters(ctx, i, judges, direction, price, volIndex)
    : { filters: [], totalPenalty: 0, bullVotes: judges.filter((j) => j.vote > 0).length, bearVotes: judges.filter((j) => j.vote < 0).length, directional: judges.filter((j) => j.vote !== 0).length, volumeRatio: null };

  /* 过滤只做降级，不做加分
   * 关键约束：扣分只能「削弱」信号强度，不能加强，也不能把方向反转
   * 因此先用绝对值表示强度，扣分后强度只会变小，最后再把方向加回去 */
  const baseMagnitude = Math.abs(baseScore);
  const filteredMagnitude = Math.max(0, baseMagnitude + filtered.totalPenalty);
  const finalScore = baseScore >= 0 ? filteredMagnitude : -filteredMagnitude;

  // 信号被完全过滤掉的标志：原本有方向，但强度被降到 0
  const fullyFiltered = baseMagnitude >= 12 && filteredMagnitude === 0;

  const rating = scoreToRating(finalScore);

  /* 共振强度：与最终方向一致的指标数量
   * 处于震荡档时没有明确方向，此时展示占多数的那一方，并标注未形成有效共振 */
  let agreeSide = 'none';
  let agreeCount = 0;
  if (finalScore > 0) {
    agreeSide = 'bull';
    agreeCount = filtered.bullVotes;
  } else if (finalScore < 0) {
    agreeSide = 'bear';
    agreeCount = filtered.bearVotes;
  } else {
    agreeCount = Math.max(filtered.bullVotes, filtered.bearVotes);
  }

  return {
    index: i,
    time: ctx.candles[i] ? ctx.candles[i].t : null,
    price,
    judges,
    baseScore,
    finalScore,
    rating,
    agreeCount,
    agreeSide,
    fullyFiltered,
    bullVotes: filtered.bullVotes,
    bearVotes: filtered.bearVotes,
    filters: filtered.filters,
    totalPenalty: filtered.totalPenalty,
    volumeRatio: filtered.volumeRatio,
    lastForming,
    // 量能比较实际使用的K线索引，方便前端说明
    volumeIndex: volIndex,
  };
}

/**
 * 主入口：对整段K线做分析
 * 返回最新一根K线的完整结论 + 最近若干根K线的评级历史
 */
function analyze(ctx, historyLength = 48) {
  const lastIndex = ctx.candles.length - 1;
  const current = evaluateAt(ctx, lastIndex, true);

  // 评级历史：只算分数，不跑过滤，避免重复计算拖慢页面
  const history = [];
  const start = Math.max(0, lastIndex - historyLength + 1);
  for (let i = start; i <= lastIndex; i++) {
    const r = evaluateAt(ctx, i, false);
    history.push({ t: ctx.candles[i].t, score: r.finalScore, rating: r.rating.key, label: r.rating.label });
  }

  return { current, history, ratings: RATINGS };
}

window.SignalEngine = { analyze, evaluateAt, RATINGS, WEIGHTS };
