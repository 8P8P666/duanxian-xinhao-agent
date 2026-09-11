/**
 * 轻量K线图表（纯 Canvas 绘制）
 * 说明：不依赖任何外部图表库，避免线上 CDN 加载失败导致页面空白
 * 内容：价格K线 + 布林带三轨 + 成交量柱 + 鼠标十字定位
 * 颜色：按中国习惯，上涨为红色，下跌为绿色
 */

(function () {
  const UP_COLOR = '#d92b2b';
  const DOWN_COLOR = '#12864a';
  const GRID_COLOR = 'rgba(90, 70, 10, 0.14)';
  const AXIS_TEXT = '#6b5a12';
  const BOLL_MID = '#7a5c0a';
  const BOLL_BAND = 'rgba(150, 110, 10, 0.75)';

  function createChart(canvas, options = {}) {
    const ctx2d = canvas.getContext && canvas.getContext('2d');

    // 极少数环境拿不到 2D 绘图上下文（浏览器禁用了画布、或环境不支持）。
    // 这种情况下返回一个什么都不做的空图表，让页面其余部分照常工作，
    // 而不是抛错导致整个分析结果都无法显示。
    if (!ctx2d) {
      return {
        available: false,
        reason: '当前浏览环境不支持画布绘图，K线图无法显示，其余分析结果不受影响。',
        setData() {},
        redraw() {},
      };
    }

    let state = { candles: [], boll: null, hoverIndex: -1, layout: null };

    /* 计算绘图区域，把画布分成价格区和成交量区 */
    function computeLayout(w, h) {
      const padLeft = 8;
      const padRight = 66; // 右侧留给价格刻度
      const padTop = 14;
      const padBottom = 22; // 底部留给时间刻度
      const gap = 14;
      const volumeH = Math.max(48, Math.round((h - padTop - padBottom - gap) * 0.22));
      const priceTop = padTop;
      const priceBottom = h - padBottom - volumeH - gap;
      return {
        padLeft,
        padRight,
        padTop,
        padBottom,
        priceTop,
        priceBottom,
        volumeTop: priceBottom + gap,
        volumeBottom: h - padBottom,
        plotLeft: padLeft,
        plotRight: w - padRight,
      };
    }

    /* 价格取整到合适的显示精度，避免出现一长串小数 */
    function fmtPrice(v) {
      if (v === null || !Number.isFinite(v)) return '—';
      const abs = Math.abs(v);
      if (abs >= 10000) return v.toFixed(0);
      if (abs >= 100) return v.toFixed(2);
      if (abs >= 1) return v.toFixed(3);
      if (abs >= 0.01) return v.toFixed(5);
      return v.toPrecision(4);
    }

    function fmtTime(ts, interval) {
      const d = new Date(ts);
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const mi = String(d.getMinutes()).padStart(2, '0');
      if (interval && interval.endsWith('d')) return `${mm}-${dd}`;
      return `${mm}-${dd} ${hh}:${mi}`;
    }

    function render() {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(rect.width, 240);
      const h = Math.max(rect.height, 200);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx2d.clearRect(0, 0, w, h);

      const candles = state.candles;
      if (!candles || candles.length < 2) {
        ctx2d.fillStyle = AXIS_TEXT;
        ctx2d.font = '13px system-ui, sans-serif';
        ctx2d.textAlign = 'center';
        ctx2d.fillText('暂无K线数据', w / 2, h / 2);
        return;
      }

      const L = computeLayout(w, h);
      state.layout = L;

      const plotW = L.plotRight - L.plotLeft;
      const priceH = L.priceBottom - L.priceTop;
      const volH = L.volumeBottom - L.volumeTop;

      /* 纵轴范围：把布林上下轨一起纳入，保证曲线不出框 */
      let hi = -Infinity;
      let lo = Infinity;
      candles.forEach((c) => {
        if (c.h > hi) hi = c.h;
        if (c.l < lo) lo = c.l;
      });
      const boll = state.boll;
      if (boll) {
        candles.forEach((_, i) => {
          const u = boll.upper[i];
          const l = boll.lower[i];
          if (Number.isFinite(u) && u > hi) hi = u;
          if (Number.isFinite(l) && l < lo) lo = l;
        });
      }
      const pad = (hi - lo) * 0.06 || hi * 0.01 || 1;
      hi += pad;
      lo -= pad;
      const span = hi - lo || 1;

      let volMax = 0;
      candles.forEach((c) => {
        if (Number.isFinite(c.v) && c.v > volMax) volMax = c.v;
      });
      if (volMax <= 0) volMax = 1;

      const stepX = plotW / candles.length;
      const bodyW = Math.max(1.2, Math.min(stepX * 0.66, 11));
      const xOf = (i) => L.plotLeft + stepX * (i + 0.5);
      const yPrice = (v) => L.priceBottom - ((v - lo) / span) * priceH;
      const yVol = (v) => L.volumeBottom - (v / volMax) * volH;

      /* 横向网格与价格刻度 */
      ctx2d.font = '11px system-ui, sans-serif';
      ctx2d.textAlign = 'left';
      ctx2d.textBaseline = 'middle';
      const gridCount = 5;
      for (let g = 0; g <= gridCount; g++) {
        const y = L.priceTop + (priceH / gridCount) * g;
        ctx2d.strokeStyle = GRID_COLOR;
        ctx2d.lineWidth = 0.5;
        ctx2d.beginPath();
        ctx2d.moveTo(L.plotLeft, y);
        ctx2d.lineTo(L.plotRight, y);
        ctx2d.stroke();
        const value = hi - (span / gridCount) * g;
        ctx2d.fillStyle = AXIS_TEXT;
        ctx2d.fillText(fmtPrice(value), L.plotRight + 6, y);
      }

      /* 时间刻度：均匀取 5 个位置 */
      ctx2d.textAlign = 'center';
      ctx2d.textBaseline = 'top';
      const ticks = 5;
      for (let t = 0; t <= ticks; t++) {
        const idx = Math.min(candles.length - 1, Math.round(((candles.length - 1) / ticks) * t));
        const x = xOf(idx);
        ctx2d.strokeStyle = GRID_COLOR;
        ctx2d.beginPath();
        ctx2d.moveTo(x, L.priceTop);
        ctx2d.lineTo(x, L.volumeBottom);
        ctx2d.stroke();
        ctx2d.fillStyle = AXIS_TEXT;
        ctx2d.fillText(fmtTime(candles[idx].t, options.interval), x, L.volumeBottom + 5);
      }

      /* 布林带：先画上下轨之间的淡色填充，再画三条轨道线 */
      if (boll) {
        const bandPoints = [];
        candles.forEach((_, i) => {
          if (Number.isFinite(boll.upper[i]) && Number.isFinite(boll.lower[i])) {
            bandPoints.push(i);
          }
        });
        if (bandPoints.length > 1) {
          ctx2d.beginPath();
          bandPoints.forEach((i, n) => {
            const x = xOf(i);
            const y = yPrice(boll.upper[i]);
            if (n === 0) ctx2d.moveTo(x, y);
            else ctx2d.lineTo(x, y);
          });
          for (let n = bandPoints.length - 1; n >= 0; n--) {
            const i = bandPoints[n];
            ctx2d.lineTo(xOf(i), yPrice(boll.lower[i]));
          }
          ctx2d.closePath();
          ctx2d.fillStyle = 'rgba(216, 178, 46, 0.16)';
          ctx2d.fill();

          const drawLine = (series, color, width, dash) => {
            ctx2d.beginPath();
            let started = false;
            candles.forEach((_, i) => {
              const v = series[i];
              if (!Number.isFinite(v)) return;
              const x = xOf(i);
              const y = yPrice(v);
              if (!started) {
                ctx2d.moveTo(x, y);
                started = true;
              } else {
                ctx2d.lineTo(x, y);
              }
            });
            ctx2d.strokeStyle = color;
            ctx2d.lineWidth = width;
            if (dash) ctx2d.setLineDash(dash);
            ctx2d.stroke();
            ctx2d.setLineDash([]);
          };
          drawLine(boll.upper, BOLL_BAND, 1, [4, 3]);
          drawLine(boll.lower, BOLL_BAND, 1, [4, 3]);
          drawLine(boll.mid, BOLL_MID, 1.4, null);
        }
      }

      /* K线本体 */
      let lastX = null;
      let lastY = null;
      candles.forEach((c, i) => {
        const x = xOf(i);
        const up = c.c >= c.o;
        const color = up ? UP_COLOR : DOWN_COLOR;

        // 上下影线
        ctx2d.strokeStyle = color;
        ctx2d.lineWidth = 1;
        ctx2d.beginPath();
        ctx2d.moveTo(x, yPrice(c.h));
        ctx2d.lineTo(x, yPrice(c.l));
        ctx2d.stroke();

        // 实体
        const yo = yPrice(c.o);
        const yc = yPrice(c.c);
        const top = Math.min(yo, yc);
        const bh = Math.max(Math.abs(yc - yo), 1);
        if (up) {
          ctx2d.fillStyle = 'rgba(217, 43, 43, 0.92)';
          ctx2d.fillRect(x - bodyW / 2, top, bodyW, bh);
        } else {
          ctx2d.fillStyle = 'rgba(18, 134, 74, 0.92)';
          ctx2d.fillRect(x - bodyW / 2, top, bodyW, bh);
        }
        lastX = x;
        lastY = yc;
      });

      /* 最新价虚线 */
      if (lastY !== null) {
        ctx2d.strokeStyle = 'rgba(60, 45, 5, 0.5)';
        ctx2d.lineWidth = 0.8;
        ctx2d.setLineDash([5, 4]);
        ctx2d.beginPath();
        ctx2d.moveTo(L.plotLeft, lastY);
        ctx2d.lineTo(L.plotRight, lastY);
        ctx2d.stroke();
        ctx2d.setLineDash([]);

        // 右侧价格标签
        const label = fmtPrice(candles[candles.length - 1].c);
        ctx2d.font = '11px system-ui, sans-serif';
        const tw = ctx2d.measureText(label).width + 10;
        ctx2d.fillStyle = '#3a2c05';
        ctx2d.beginPath();
        ctx2d.roundRect
          ? ctx2d.roundRect(L.plotRight + 2, lastY - 9, tw, 18, 4)
          : ctx2d.rect(L.plotRight + 2, lastY - 9, tw, 18);
        ctx2d.fill();
        ctx2d.fillStyle = '#fdf6dc';
        ctx2d.textAlign = 'left';
        ctx2d.textBaseline = 'middle';
        ctx2d.fillText(label, L.plotRight + 7, lastY);
      }

      /* 成交量柱 */
      candles.forEach((c, i) => {
        const x = xOf(i);
        const up = c.c >= c.o;
        const v = Number.isFinite(c.v) ? c.v : 0;
        const y = yVol(v);
        ctx2d.fillStyle = up ? 'rgba(217, 43, 43, 0.45)' : 'rgba(18, 134, 74, 0.45)';
        ctx2d.fillRect(x - bodyW / 2, y, bodyW, L.volumeBottom - y);
      });
      ctx2d.strokeStyle = GRID_COLOR;
      ctx2d.lineWidth = 0.5;
      ctx2d.beginPath();
      ctx2d.moveTo(L.plotLeft, L.volumeBottom);
      ctx2d.lineTo(L.plotRight, L.volumeBottom);
      ctx2d.stroke();

      /* 十字定位 */
      const hi2 = state.hoverIndex;
      if (hi2 >= 0 && hi2 < candles.length) {
        const x = xOf(hi2);
        const c = candles[hi2];
        ctx2d.strokeStyle = 'rgba(60, 45, 5, 0.45)';
        ctx2d.lineWidth = 0.8;
        ctx2d.setLineDash([3, 3]);
        ctx2d.beginPath();
        ctx2d.moveTo(x, L.priceTop);
        ctx2d.lineTo(x, L.volumeBottom);
        ctx2d.stroke();
        const yc = yPrice(c.c);
        ctx2d.beginPath();
        ctx2d.moveTo(L.plotLeft, yc);
        ctx2d.lineTo(L.plotRight, yc);
        ctx2d.stroke();
        ctx2d.setLineDash([]);

        if (options.onHover) options.onHover(hi2, x, yc, c);
      }
    }

    /* 鼠标移动时定位到最近的K线 */
    canvas.addEventListener('mousemove', (e) => {
      const L = state.layout;
      if (!L || !state.candles.length) return;
      const rect = canvas.getBoundingClientRect();
      const relX = e.clientX - rect.left;
      const plotW = L.plotRight - L.plotLeft;
      const stepX = plotW / state.candles.length;
      const idx = Math.floor((relX - L.plotLeft) / stepX);
      if (idx >= 0 && idx < state.candles.length && idx !== state.hoverIndex) {
        state.hoverIndex = idx;
        render();
      } else if (idx < 0 || idx >= state.candles.length) {
        if (state.hoverIndex !== -1) {
          state.hoverIndex = -1;
          if (options.onHover) options.onHover(-1);
          render();
        }
      }
    });

    canvas.addEventListener('mouseleave', () => {
      state.hoverIndex = -1;
      if (options.onHover) options.onHover(-1);
      render();
    });

    // 容器尺寸变化时重新绘制，保证手机和电脑都正常
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => render());
      ro.observe(canvas.parentElement || canvas);
    } else {
      window.addEventListener('resize', render);
    }

    return {
      available: true,
      setData(candles, boll) {
        state.candles = candles || [];
        state.boll = boll || null;
        state.hoverIndex = -1;
        render();
      },
      redraw: render,
    };
  }

  window.KlineChart = { createChart };
})();
