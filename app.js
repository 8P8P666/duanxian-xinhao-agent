/**
 * 页面主逻辑
 * 流程：读取用户选择 -> 请求真实行情接口 -> 计算四指标 -> 共振判定 -> 假信号过滤 -> 渲染页面
 * 原则：只展示接口真实返回的数据；接口失败时明确提示，绝不使用演示数据顶替
 */

(function () {
  'use strict';

  /* ============================================================
   * 全局状态
   * ============================================================ */
  const state = {
    platform: 'gate',
    market: 'perp',
    symbol: 'BTC_USDT',
    interval: '15m',
    limit: 300,
    loading: false,
    data: null,
    analysis: null,
    chart: null,
    ctx: null,
    chartFrom: 0,
  };

  /* 界面上对外显示的平台名称：只描述平台类型，不出现具体平台品牌名 */
  const PLATFORM_NAME = { gate: '综合交易平台', hyperliquid: '链上永续平台' };

  const $ = (id) => document.getElementById(id);

  /* ============================================================
   * 数字格式化
   * ============================================================ */
  function fmtPrice(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    const abs = Math.abs(v);
    if (abs >= 10000) return v.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
    if (abs >= 100) return v.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
    if (abs >= 1) return v.toFixed(4);
    if (abs >= 0.01) return v.toFixed(5);
    return v.toPrecision(4);
  }

  /** 大数字换算成万 / 亿，方便中文阅读 */
  function fmtCompact(v, unit) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    const abs = Math.abs(v);
    let out;
    if (abs >= 1e8) out = (v / 1e8).toFixed(2) + ' 亿';
    else if (abs >= 1e4) out = (v / 1e4).toFixed(2) + ' 万';
    else out = v.toFixed(2);
    return unit ? out + ' ' + unit : out;
  }

  function fmtSignedPercent(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  }

  function fmtPercent(v, digits = 2) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    return v.toFixed(digits) + '%';
  }

  /** 指标数值格式化：小币种的价格差异很小，固定小数位会全部显示成 0，所以按量级自适应 */
  function fmtInd(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    const abs = Math.abs(v);
    if (abs === 0) return '0';
    if (abs >= 100) return v.toFixed(2);
    if (abs >= 1) return v.toFixed(3);
    if (abs >= 0.01) return v.toFixed(4);
    return v.toPrecision(4);
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  /* ============================================================
   * 状态栏与提示
   * ============================================================ */
  function setStatus(type, text) {
    const dot = $('statusDot');
    dot.className = 'status-dot' + (type ? ' is-' + type : '');
    $('statusText').textContent = text;
  }

  /**
   * 显示错误提示
   * @param {string} title 错误标题，必须如实反映是哪一环节出的问题
   * @param {string} msg   具体原因
   */
  function showError(title, msg) {
    $('errorTitle').textContent = title || '出现错误';
    $('errorText').textContent = msg || '';
    $('errorBox').hidden = false;
  }

  function clearError() {
    $('errorBox').hidden = true;
  }

  /* ============================================================
   * 控件初始化
   * ============================================================ */

  /** 通用分段按钮控制 */
  function bindSegment(containerId, onChange) {
    const box = $(containerId);
    box.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn || btn.disabled) return;
      box.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      onChange(btn.dataset.value);
    });
  }

  /** 切换平台时，市场类型需要做限制：链上平台只有永续合约 */
  function applyMarketAvailability() {
    const seg = $('segMarket');
    const isHL = state.platform === 'hyperliquid';
    seg.querySelectorAll('.seg-btn').forEach((b) => {
      if (b.dataset.value === 'spot') {
        b.disabled = isHL;
      }
    });
    if (isHL && state.market === 'spot') {
      state.market = 'perp';
      seg.querySelector('[data-value="perp"]').classList.add('is-active');
      seg.querySelector('[data-value="spot"]').classList.remove('is-active');
    }
    $('marketNote').textContent = isHL
      ? '链上永续平台只提供永续合约，现货选项已停用'
      : state.market === 'perp'
        ? '永续合约包含资金费率与持仓量数据'
        : '现货不提供资金费率与持仓量数据';
  }

  /** 加载币种列表 */
  async function loadSymbols() {
    const select = $('symbolSelect');
    select.innerHTML = '<option value="">正在加载币种…</option>';
    try {
      const data = await window.ApiClient.fetchSymbols({
        platform: state.platform,
        market: state.market,
        top: 60,
      });
      const list = data.list || [];
      if (!list.length) throw new Error('接口没有返回任何可交易币种');

      select.innerHTML = '';
      list.forEach((item) => {
        const opt = document.createElement('option');
        opt.value = item.symbol;
        const vol = item.quoteVolume24h !== null ? fmtCompact(item.quoteVolume24h) : '—';
        opt.textContent = `${item.display}　24h成交额 ${vol}`;
        select.appendChild(opt);
      });

      // 保持当前选择；如果当前币种不在新列表里，则回退到列表第一个
      const exists = list.some((i) => i.symbol === state.symbol);
      if (!exists) state.symbol = list[0].symbol;
      select.value = state.symbol;
      $('consoleHint').textContent = `已加载 ${list.length} 个币种（按 24 小时成交额排序）`;
    } catch (err) {
      select.innerHTML = '<option value="">币种加载失败</option>';
      showError('币种列表获取失败', err.message || '未能取到可分析的币种列表');
      throw err;
    }
  }

  /* ============================================================
   * 数据获取与计算
   * ============================================================ */
  async function runAnalysis() {
    if (state.loading) return;
    state.loading = true;
    clearError();
    setStatus('loading', '正在获取行情数据');
    $('btnAnalyze').disabled = true;
    $('btnAnalyze').textContent = '分析中…';

    /* ---------- 阶段一：取数据 ----------
     * 取数失败时才隐藏结果区，提示也必须如实反映是「取数失败」 */
    let data;
    try {
      data = await window.ApiClient.fetchMarket({
        platform: state.platform,
        market: state.market,
        symbol: state.symbol,
        interval: state.interval,
        limit: state.limit,
      });
      state.data = data;
    } catch (err) {
      setStatus('error', '数据获取失败');
      showError('数据获取失败', err.message || '未知错误');
      $('resultArea').hidden = true;
      state.loading = false;
      $('btnAnalyze').disabled = false;
      $('btnAnalyze').textContent = '开始分析';
      return;
    }

    /* ---------- 阶段二：计算与渲染 ----------
     * 数据已经拿到了，这里即使出错也不能说成「数据获取失败」，
     * 否则会把用户引向排查网络的错误方向。 */
    try {
      // 计算指标与共振结论
      const ctx = window.Indicators.calcAll(data.candles);
      const analysis = window.SignalEngine.analyze(ctx, 48);
      state.analysis = analysis;

      renderAll(data, ctx, analysis);

      setStatus('live', `${PLATFORM_NAME[data.platform]} 数据正常`);
      $('timeChip').textContent = '数据时间：' + fmtDateTime(data.fetchedAt);
      $('candleChip').textContent =
        `K线：${data.candleCount} 根 · ${data.intervalLabel} · ` +
        (analysis.current.lastForming ? '当前K线仍在形成中' : '当前K线已收线');
      $('sourceChip').textContent =
        '数据源：' +
        data.sourceLabel +
        // 如实标明数据是通过哪条通道取得的，方便区分线上部署方式
        (data.via === 'direct' ? ' · 浏览器直连' : ' · 云端接口代理');
      $('consoleHint').textContent = '分析完成，可切换币种或周期重新分析';
    } catch (err) {
      setStatus('error', '分析结果渲染失败');
      showError(
        '分析结果渲染失败',
        '行情数据已经成功获取（' +
          data.sourceLabel +
          '，共 ' +
          data.candleCount +
          ' 根K线），但页面在计算或绘图时出错：' +
          (err.message || '未知错误'),
      );
      // 数据本身是真的，所以不隐藏结果区，能显示多少就显示多少
    } finally {
      state.loading = false;
      $('btnAnalyze').disabled = false;
      $('btnAnalyze').textContent = '开始分析';
    }
  }

  /* ============================================================
   * 渲染：行情摘要
   * ============================================================ */
  function renderQuotes(data, ctx, analysis) {
    const t = data.ticker;
    const cur = analysis.current;
    const boll = cur.judges.find((j) => j.key === 'boll');
    const pctB = boll && boll.percentB !== null ? boll.percentB * 100 : null;

    const changeCls =
      t.changePercent24h === null ? '' : t.changePercent24h >= 0 ? 'is-up' : 'is-down';

    const cards = [
      {
        label: `最新价（${data.display}）`,
        value: fmtPrice(t.last),
        cls: changeCls,
        sub: `${data.intervalLabel}周期 · ${PLATFORM_NAME[data.platform]}`,
      },
      {
        label: '24 小时涨跌',
        value: fmtSignedPercent(t.changePercent24h),
        cls: changeCls,
        sub: '相对 24 小时前价格',
      },
      {
        label: '24 小时成交额',
        value: fmtCompact(t.quoteVolume24h, 'USDT'),
        cls: '',
        sub: '计价币口径成交额',
      },
      {
        label: '资金费率（年化）',
        value: t.fundingAnnualized === null ? '—' : fmtSignedPercent(t.fundingAnnualized),
        cls: t.fundingAnnualized === null ? '' : t.fundingAnnualized >= 0 ? 'is-up' : 'is-down',
        sub: t.fundingIntervalLabel
          ? `原始结算周期 ${t.fundingIntervalLabel}，已换算年化`
          : '现货市场不提供资金费率',
      },
      {
        label: '持仓量（名义价值）',
        value: t.openInterestUsd === null ? '—' : fmtCompact(t.openInterestUsd, 'USDT'),
        cls: '',
        sub: t.openInterestUsd === null ? '现货市场不提供持仓量' : '未平仓合约名义规模',
      },
      {
        label: '标记价 / 指数价',
        value: fmtPrice(t.markPrice),
        cls: '',
        sub: '指数价 ' + fmtPrice(t.indexPrice),
      },
      {
        label: '布林通道位置',
        value: pctB === null ? '—' : pctB.toFixed(0) + '%',
        cls: '',
        sub: '0% 为下轨，100% 为上轨',
      },
      {
        label: '共振评价',
        value: cur.rating.label,
        cls:
          cur.rating.key === 'strong_long' || cur.rating.key === 'cautious_long'
            ? 'is-up'
            : cur.rating.key === 'strong_short'
              ? 'is-down'
              : '',
        sub: `${cur.agreeCount} 个指标方向一致`,
      },
    ];

    $('quoteGrid').innerHTML = cards
      .map(
        (c) => `<div class="quote-card ${c.cls ? c.cls.replace('is-', 'is-') : ''}">
        <span class="quote-label">${c.label}</span>
        <span class="quote-value ${c.cls}">${c.value}</span>
        <span class="quote-sub">${c.sub}</span>
      </div>`,
      )
      .join('');
  }

  /* ============================================================
   * 渲染：共振结论
   * ============================================================ */
  function renderVerdict(data, analysis) {
    const cur = analysis.current;
    const rating = cur.rating;

    $('verdictSymbol').textContent =
      `${data.display} · ${data.market === 'perp' ? '永续合约' : '现货'} · ${data.intervalLabel} · ${PLATFORM_NAME[data.platform]}`;

    const badge = $('verdictBadge');
    badge.className = 'verdict-badge tone-' + rating.tone;
    $('verdictLabel').textContent = rating.label;
    $('verdictLabel').style.color = rating.color;
    $('verdictSub').textContent = rating.desc;

    // 评分条：以中线为 0，向右偏多，向左偏空
    const score = cur.finalScore;
    const half = Math.min(Math.abs(score) / 100, 1) * 50;
    const fill = $('scoreFill');
    fill.style.width = half + '%';
    fill.style.left = score >= 0 ? '50%' : 50 - half + '%';
    fill.style.background = score > 0 ? 'var(--bull)' : score < 0 ? 'var(--bear)' : 'var(--y500)';

    $('scoreValue').textContent =
      (score >= 0 ? '+' : '') + score.toFixed(1) + '（未过滤前 ' + (cur.baseScore >= 0 ? '+' : '') + cur.baseScore.toFixed(1) + '）';

    $('resonanceValue').textContent =
      cur.agreeSide === 'none'
        ? `${cur.agreeCount} / 4（未形成有效共振）`
        : `${cur.agreeCount} / 4 个指标方向一致`;

    $('voteValue').textContent = `偏多 ${cur.bullVotes} · 偏空 ${cur.bearVotes} · 中性 ${4 - cur.bullVotes - cur.bearVotes}`;

    $('penaltyValue').textContent =
      cur.totalPenalty === 0 ? '未被降级' : cur.totalPenalty.toFixed(0) + ' 分（已降级）';

    $('volumeValue').textContent =
      cur.volumeRatio === null
        ? '无成交量数据'
        : cur.volumeRatio >= 1.2
          ? `放量（均量 ${(cur.volumeRatio * 100).toFixed(0)}%）`
          : cur.volumeRatio < 0.8
            ? `缩量（均量 ${(cur.volumeRatio * 100).toFixed(0)}%）`
            : `正常（均量 ${(cur.volumeRatio * 100).toFixed(0)}%）`;

    // 结论文案
    const triggered = cur.filters.filter((f) => f.status === 'trigger');
    let note;
    if (cur.fullyFiltered) {
      note =
        `指标投票原本指向「${scoreToLabel(cur.baseScore)}」，但 ${triggered.length} 项过滤规则被触发（` +
        triggered.map((f) => f.name.replace('检查', '')).join('、') +
        `），合计扣减 ${Math.abs(cur.totalPenalty)} 分，信号强度被完全削掉，因此结论回到「震荡」，建议等待新的确认。`;
    } else if (triggered.length === 0) {
      note = `四个指标中有 ${cur.agreeCount} 个方向一致，且通过了全部 ${cur.filters.length} 项假信号过滤规则，因此给出「${rating.label}」。`;
    } else {
      note =
        `指标投票原本指向「${scoreToLabel(cur.baseScore)}」，但有 ${triggered.length} 项过滤规则被触发：` +
        triggered.map((f) => f.name.replace('检查', '') + '（' + f.penalty + ' 分）').join('、') +
        `，合计降级 ${Math.abs(cur.totalPenalty)} 分，强度由 ${Math.abs(cur.baseScore).toFixed(0)} 降到 ${Math.abs(cur.finalScore).toFixed(0)}，最终结论为「${rating.label}」。`;
    }
    $('verdictNote').textContent = note;

    $('filterSummary').textContent = `通过 ${cur.filters.length - triggered.length} · 触发 ${triggered.length}`;
  }

  /** 由分数反推文字，用于解释降级过程 */
  function scoreToLabel(score) {
    if (score >= 55) return '强做多';
    if (score >= 25) return '谨慎做多';
    if (score > -25) return '震荡';
    return '强做空';
  }

  /* ============================================================
   * 渲染：过滤规则列表
   * ============================================================ */
  function renderFilters(analysis) {
    const cur = analysis.current;
    const markText = { trigger: '!', pass: '✓', ok: '·' };
    $('filterList').innerHTML = cur.filters
      .map(
        (f) => `<li class="filter-item status-${f.status}">
        <span class="filter-mark">${markText[f.status] || '·'}</span>
        <span class="filter-name">
          ${f.name}
          ${f.penalty < 0 ? `<span class="filter-penalty">${f.penalty} 分</span>` : ''}
        </span>
        <span class="filter-detail">${f.detail}</span>
      </li>`,
      )
      .join('');
  }

  /* ============================================================
   * 渲染：四指标卡片
   * ============================================================ */
  function renderIndicators(analysis) {
    const cur = analysis.current;

    const meta = {
      macd: { full: 'Moving Average Convergence Divergence', cn: '指数平滑异同移动平均线' },
      rsi: { full: 'Relative Strength Index', cn: '相对强弱指标' },
      kdj: { full: 'Stochastic Oscillator', cn: '随机指标' },
      boll: { full: 'Bollinger Bands', cn: '布林带' },
    };

    const html = cur.judges
      .map((j) => {
        const cls = j.vote > 0 ? 'vote-up' : j.vote < 0 ? 'vote-down' : 'vote-flat';
        const voteText = j.vote > 0 ? '偏多' : j.vote < 0 ? '偏空' : '中性';

        const metrics = [];
        const tags = [];

        if (j.key === 'macd') {
          metrics.push(['DIF', fmtInd(j.dif)]);
          metrics.push(['DEA', fmtInd(j.dea)]);
          metrics.push(['柱状值', fmtInd(j.hist)]);
          if (j.cross === 'golden') tags.push(['金叉', 'tag-cross-golden']);
          if (j.cross === 'dead') tags.push(['死叉', 'tag-cross-dead']);
          if (j.momentum === 'expanding-up') tags.push(['动能放大（多头）', '']);
          if (j.momentum === 'expanding-down') tags.push(['动能放大（空头）', '']);
          if (j.momentum === 'shrinking') tags.push(['动能收敛', '']);
        }
        if (j.key === 'rsi') {
          metrics.push(['RSI(14)', j.value === null ? '—' : j.value.toFixed(2)]);
          metrics.push([
            '区域',
            j.zone === 'overbought' ? '超买' : j.zone === 'oversold' ? '超卖' : '正常',
          ]);
          metrics.push(['方向', j.slope === 'up' ? '上行' : j.slope === 'down' ? '下行' : '走平']);
          if (j.zone === 'overbought') tags.push(['超买区', 'tag-extreme']);
          if (j.zone === 'oversold') tags.push(['超卖区', 'tag-extreme']);
        }
        if (j.key === 'kdj') {
          metrics.push(['K', fmtInd(j.k)]);
          metrics.push(['D', fmtInd(j.d)]);
          metrics.push(['J', fmtInd(j.j)]);
          if (j.cross === 'golden') tags.push(['金叉', 'tag-cross-golden']);
          if (j.cross === 'dead') tags.push(['死叉', 'tag-cross-dead']);
          if (j.zone === 'overbought') tags.push(['高位', 'tag-extreme']);
          if (j.zone === 'oversold') tags.push(['低位', 'tag-extreme']);
        }
        if (j.key === 'boll') {
          metrics.push(['上轨', fmtPrice(j.upper)]);
          metrics.push(['中轨', fmtPrice(j.mid)]);
          metrics.push(['下轨', fmtPrice(j.lower)]);
          metrics.push(['带宽', j.bandwidth === null ? '—' : j.bandwidth.toFixed(2) + '%']);
          if (j.percentB !== null)
            metrics.push(['位置', (j.percentB * 100).toFixed(0) + '%']);
        }

        return `<article class="ind-card ${cls}">
        <div class="ind-head">
          <span class="ind-name">${j.name}<small>${meta[j.key].full}<br>${meta[j.key].cn}</small></span>
          <span class="ind-vote">${voteText}</span>
        </div>
        <p class="ind-state">${j.state}</p>
        <div class="ind-metrics">
          ${metrics.map((m) => `<span class="ind-metric">${m[0]} ${m[1]}</span>`).join('')}
        </div>
        ${tags.length ? `<div class="ind-tags">${tags.map((t) => `<span class="ind-tag ${t[1]}">${t[0]}</span>`).join('')}</div>` : ''}
      </article>`;
      })
      .join('');

    $('indicatorGrid').innerHTML = html;
  }

  /* ============================================================
   * 渲染：K线图
   * ============================================================ */
  function renderChart(data, ctx, analysis) {
    // 图表数据每次都要更新，悬浮提示要从最新的 state 里取，避免显示上一次的旧数值
    state.ctx = ctx;

    if (!state.chart) {
      state.chart = window.KlineChart.createChart($('klineCanvas'), {
        interval: data.interval,
        onHover: (idx, x, y, candle) => {
          const tip = $('chartTip');
          if (idx < 0 || !candle || !state.ctx) {
            tip.hidden = true;
            return;
          }
          // idx 是裁剪后数组的下标，需要加上偏移量才能对应到完整指标序列
          const realIndex = state.chartFrom + idx;
          const boll = state.ctx.boll;
          const d = new Date(candle.t);
          const p = (n) => String(n).padStart(2, '0');
          const up = candle.c >= candle.o;
          tip.innerHTML =
            `<div><b>${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}</b></div>` +
            `<div>开盘 ${fmtPrice(candle.o)}　收盘 <b style="color:${up ? '#ff8a8a' : '#6ede9b'}">${fmtPrice(candle.c)}</b></div>` +
            `<div>最高 ${fmtPrice(candle.h)}　最低 ${fmtPrice(candle.l)}</div>` +
            `<div>成交量 ${fmtCompact(candle.v)}</div>` +
            `<div>布林 上 ${fmtPrice(boll.upper[realIndex])} / 中 ${fmtPrice(boll.mid[realIndex])} / 下 ${fmtPrice(boll.lower[realIndex])}</div>`;
          tip.hidden = false;
          // 提示框跟随鼠标，并避免超出容器右边界
          const wrap = tip.parentElement;
          const wrapW = wrap.clientWidth;
          const tipW = tip.offsetWidth;
          let left = x + 16;
          if (left + tipW > wrapW) left = Math.max(4, x - tipW - 16);
          tip.style.left = left + 'px';
          tip.style.top = Math.max(6, y - 70) + 'px';
        },
      });

      // 拿不到画布时给出明确说明，页面其余分析结果不受影响
      if (state.chart && state.chart.available === false) {
        $('chartHint').textContent = state.chart.reason;
        $('klineCanvas').hidden = true;
      }
    }
    // 只展示最后 160 根，保证K线实体足够清晰
    const showCount = Math.min(160, data.candles.length);
    const from = data.candles.length - showCount;
    state.chartFrom = from;
    const candles = data.candles.slice(from);
    const boll = {
      upper: ctx.boll.upper.slice(from),
      mid: ctx.boll.mid.slice(from),
      lower: ctx.boll.lower.slice(from),
    };
    state.chart.setData(candles, boll);
    // 画布不可用时保留上面的说明文字，不要被这句覆盖掉
    if (state.chart.available !== false) {
      $('chartHint').textContent = `显示最近 ${showCount} 根K线 · 红涨绿跌 · 虚线为布林上下轨`;
    }
  }

  /* ============================================================
   * 渲染：评级历史
   * ============================================================ */
  function renderHistory(analysis) {
    const colorOf = (key) =>
      key === 'strong_long'
        ? '#d92b2b'
        : key === 'cautious_long'
          ? '#e8752a'
          : key === 'strong_short'
            ? '#12864a'
            : '#c9b93f';

    const h = analysis.history;
    $('historyStrip').innerHTML = h
      .map((item) => {
        const d = new Date(item.t);
        const p = (n) => String(n).padStart(2, '0');
        const time = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
        return `<div class="history-cell" style="background:${colorOf(item.rating)}" title="${time}　${item.label}　评分 ${item.score.toFixed(1)}"></div>`;
      })
      .join('');

    // 统计各评级出现次数，看方向是否稳定
    const counts = { strong_long: 0, cautious_long: 0, neutral: 0, strong_short: 0 };
    h.forEach((i) => {
      counts[i.rating] = (counts[i.rating] || 0) + 1;
    });
    $('historyHint').textContent =
      `近 ${h.length} 根K线：强做多 ${counts.strong_long} · 谨慎做多 ${counts.cautious_long} · 震荡 ${counts.neutral} · 强做空 ${counts.strong_short}`;
  }

  /* ============================================================
   * 渲染：跨平台对照
   * ============================================================ */
  function renderCross(data) {
    const c = data.comparison;
    const grid = $('crossGrid');
    const note = $('crossNote');

    if (!c || (!c.gate && !c.hyperliquid)) {
      grid.innerHTML = '<div class="cross-card-item"><span class="cross-platform">跨平台数据暂不可用</span><span class="cross-price">—</span></div>';
      note.textContent = '跨平台对照为增强信息，本次未取到数据，不影响上面的主分析结果。';
      return;
    }

    const cards = [];
    if (c.gate) {
      cards.push(`<div class="cross-card-item">
        <span class="cross-platform"><i class="dot"></i>综合交易平台（主数据源 · ${c.gate.market === 'perp' ? '永续合约' : '现货'}）</span>
        <span class="cross-price">${fmtPrice(c.gate.price)}</span>
        <span class="cross-row"><span>标记价</span><span>${fmtPrice(c.gate.markPrice)}</span></span>
        <span class="cross-row"><span>24h成交额</span><span>${fmtCompact(c.gate.quoteVolume24h, 'USDT')}</span></span>
        <span class="cross-row"><span>持仓量</span><span>${fmtCompact(c.gate.openInterestUsd, 'USDT')}</span></span>
        <span class="cross-row"><span>资金费率(年化)</span><span>${c.gate.fundingAnnualized === null ? '—' : fmtSignedPercent(c.gate.fundingAnnualized)}</span></span>
        <span class="cross-row"><span>原始结算周期</span><span>${c.gate.fundingIntervalLabel || '—'}</span></span>
      </div>`);
    }
    if (c.hyperliquid) {
      cards.push(`<div class="cross-card-item">
        <span class="cross-platform"><i class="dot" style="background:#f7931a"></i>链上永续平台（备用数据源）</span>
        <span class="cross-price">${fmtPrice(c.hyperliquid.price)}</span>
        <span class="cross-row"><span>标记价</span><span>${fmtPrice(c.hyperliquid.markPrice)}</span></span>
        <span class="cross-row"><span>预言机价</span><span>${fmtPrice(c.hyperliquid.oraclePrice)}</span></span>
        <span class="cross-row"><span>持仓量</span><span>${fmtCompact(c.hyperliquid.openInterestUsd, 'USDT')}</span></span>
        <span class="cross-row"><span>资金费率(年化)</span><span>${c.hyperliquid.fundingAnnualized === null ? '—' : fmtSignedPercent(c.hyperliquid.fundingAnnualized)}</span></span>
        <span class="cross-row"><span>原始结算周期</span><span>${c.hyperliquid.fundingIntervalLabel}</span></span>
      </div>`);
    }

    if (c.spreadPercent !== undefined && c.spreadPercent !== null) {
      const s = c.spreadPercent;
      cards.push(`<div class="cross-card-item" style="background:var(--y150)">
        <span class="cross-platform"><i class="dot" style="background:#241c02"></i>两平台价差</span>
        <span class="cross-price" style="color:${s > 0 ? 'var(--bull)' : 'var(--bear)'}">${(s >= 0 ? '+' : '') + s.toFixed(3)}%</span>
        <span class="cross-row"><span>绝对价差</span><span>${(c.spreadAbs >= 0 ? '+' : '') + fmtPrice(c.spreadAbs)}</span></span>
        <span class="cross-row"><span>计算基准</span><span>以综合交易平台价格为 100%</span></span>
        <span class="cross-row"><span>价差含义</span><span>${Math.abs(s) < 0.05 ? '两平台基本持平' : Math.abs(s) < 0.3 ? '存在小幅差异' : '差异较明显'}</span></span>
      </div>`);
    }

    grid.innerHTML = cards.join('');

    let text =
      '上方价格与持仓量为两个平台在同一时刻抓取的公开行情，价差由程序实时计算，未做任何人工调整。' +
      '资金费率因结算周期不同（综合交易平台 8 小时、链上永续平台 1 小时），已统一换算为年化后再展示，原始周期标注在各卡片内。';
    if (c.errors && c.errors.length) {
      text += '本次部分数据未取到：' + c.errors.join('；') + '。';
    }
    note.textContent = text;
  }

  /* ============================================================
   * 总渲染
   * ============================================================ */
  function renderAll(data, ctx, analysis) {
    $('resultArea').hidden = false;
    renderQuotes(data, ctx, analysis);
    renderVerdict(data, analysis);
    renderFilters(analysis);
    renderIndicators(analysis);
    renderChart(data, ctx, analysis);
    renderHistory(analysis);
    renderCross(data);
  }

  /* ============================================================
   * 事件绑定与启动
   * ============================================================ */
  function bindEvents() {
    bindSegment('segPlatform', async (v) => {
      state.platform = v;
      state.symbol = v === 'hyperliquid' ? 'BTC' : 'BTC_USDT';
      applyMarketAvailability();
      try {
        await loadSymbols();
        await runAnalysis();
      } catch (e) {
        /* 错误已在内部提示 */
      }
    });

    bindSegment('segMarket', async (v) => {
      state.market = v;
      state.symbol = state.platform === 'hyperliquid' ? 'BTC' : 'BTC_USDT';
      applyMarketAvailability();
      try {
        await loadSymbols();
        await runAnalysis();
      } catch (e) {
        /* 错误已在内部提示 */
      }
    });

    bindSegment('segInterval', async (v) => {
      state.interval = v;
      await runAnalysis();
    });

    $('symbolSelect').addEventListener('change', async (e) => {
      state.symbol = e.target.value;
      await runAnalysis();
    });

    $('btnAnalyze').addEventListener('click', runAnalysis);

    // 页面宽度变化时重绘图表，保证刻度正常
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (state.chart) state.chart.redraw();
      }, 160);
    });
  }

  async function init() {
    bindEvents();
    applyMarketAvailability();
    try {
      await loadSymbols();
    } catch (e) {
      return;
    }
    await runAnalysis();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
