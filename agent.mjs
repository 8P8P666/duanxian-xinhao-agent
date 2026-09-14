#!/usr/bin/env node
/**
 * agent.mjs —— 短线共振信号智能体的「Agent 命令行入口」
 *
 * 用途：让 AI Agent（Claude Code / OpenClaw 等）或任何脚本，用一行命令拿到
 *       某个币种的多指标共振结论与假信号过滤结果，不必打开网页。
 *
 * 四条数据通道（都不需要 API 密钥，都不涉及任何交易操作）：
 *   ① 多平台实时（默认，不带参数即走这条）：读综合交易平台与链上永续平台的公开行情
 *      接口取K线，与网页版走的是同一份代码、同一套口径。
 *   ② 官方公开行情（--live）：读币安为「仅需公开行情」场景提供的公开入口
 *      data-api.binance.vision 的 K 线接口。
 *   ③ 官方开源数据仓库（--official）：读币安官方开源的公开数据仓库
 *      （github.com/binance/binance-public-data → data.binance.vision）里的
 *      历史 K 线归档 ZIP，可复现、可复核（官方归档是 T+1，最新一两天通常还没发布）。
 *   ④ 官方技能（--skill）：调用官方技能市场（binance/binance-skills-hub）的
 *      binance 技能驱动的命令行工具 binance-cli —— 用该技能 SKILL.md 里记载的
 *      request 用法调官方公开入口；未安装 binance-cli 时会如实打印官方安装命令
 *      并回退到 ②（同一 REST 端点），绝不假装调用过官方工具。
 *
 * 引擎：共振判定与假信号过滤全部由本项目自研的纯规则引擎完成
 *      （indicators.js 算指标 + signal-engine.js 做投票与过滤），
 *      不依赖任何大模型，同样的K线必然得到同样的结论。
 *
 * 用法：
 *   node agent.mjs                                  默认通道，BTC 1小时
 *   node agent.mjs BTC 15m                          多平台实时，指定币种与周期
 *   node agent.mjs BTC --live                       官方公开行情
 *   node agent.mjs BTC --official --days 3          官方开源数据仓库（回溯 3 天）
 *   node agent.mjs BTC --skill --json               官方技能通道，输出纯 JSON
 *   node agent.mjs "看看 ETH 现在的共振信号"          自然语言
 *
 * 说明：只读取公开行情数据，不涉及任何交易操作，不需要也不接受 API 密钥。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/* ============================================================
 * 一、加载与网页完全相同的引擎代码
 *
 * indicators.js / signal-engine.js / data-direct.js 都是浏览器脚本，
 * 末尾把能力挂在 window 上。Node 里没有 window，所以先做一层等价替身，
 * 再用 new Function 执行 —— 引擎文件一行都不用改。
 * ============================================================ */

globalThis.window = globalThis;

['indicators.js', 'signal-engine.js', 'data-direct.js'].forEach((f) => {
  const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
  new Function(code)(); // eslint-disable-next-line no-new-func
});

const { Indicators, SignalEngine, DataDirect } = globalThis;

if (!Indicators || !SignalEngine) {
  console.error('引擎加载失败：找不到 indicators.js 或 signal-engine.js');
  process.exit(1);
}

/* ============================================================
 * 二、币安官方公开行情入口（现货 · 免密钥）
 *
 * 币安在 binance-spot-api-docs 里为「仅需公开行情」的场景提供了
 * data-api.binance.vision —— 只提供公开市场数据、不需要 API 密钥，
 * 也不会返回任何账户相关信息。
 *
 * 注意：Node 的 fetch 默认不读系统代理，所以本机那种「系统代理开关开着、
 * 代理进程却没跑」的假死状态不会影响到这里。
 * ============================================================ */

const BINANCE_PUBLIC_BASE = 'https://data-api.binance.vision/api/v3';
const BINANCE_BLOB_BASE = 'https://data.binance.vision';

/** 币安官方交易对命名不带下划线：BTC_USDT → BTCUSDT */
const binancePair = (symbol) => String(symbol).replace('_', '').toUpperCase();

/** 取基础币种：BTC_USDT / BTCUSDT / BTC → BTC */
const pairBase = (pair) => String(pair).toUpperCase().replace(/[_-]?USDT$/, '');

async function binancePublicGet(pathAndQuery) {
  const res = await fetch(BINANCE_PUBLIC_BASE + pathAndQuery);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`币安公开行情接口返回 ${res.status}：${text.slice(0, 120)}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('币安公开行情接口返回的不是 JSON：' + text.slice(0, 120));
  }
}

/** 官方 K 线 → 本项目统一结构（与 data-direct.js 的 candles 保持同形） */
function mapBinanceKlines(rows) {
  return rows.map((k) => ({
    t: Number(k[0]),
    o: Number(k[1]),
    h: Number(k[2]),
    l: Number(k[3]),
    c: Number(k[4]),
    v: Number(k[5]),
    sum: Number(k[7]),
  }));
}

async function fetchBinanceQuote(symbol) {
  return binancePublicGet('/ticker/24hr?symbol=' + encodeURIComponent(binancePair(symbol)));
}

async function fetchBinanceKlines(symbol, interval, limit = 500) {
  const rows = await binancePublicGet(
    '/klines?symbol=' + encodeURIComponent(binancePair(symbol)) +
    '&interval=' + encodeURIComponent(interval) +
    '&limit=' + limit,
  );
  if (!Array.isArray(rows)) throw new Error('币安 K 线接口返回结构异常');
  if (!rows.length) throw new Error(`币安没有返回 ${binancePair(symbol)} 的 K 线（交易对可能不存在）`);
  return mapBinanceKlines(rows);
}

/* ============================================================
 * 三、官方技能通道（Skills Hub 的 binance 技能 → binance-cli）
 *
 * 官方 binance 技能的 SKILL.md 末行明确记载：
 *   「For endpoints not listed in the skill, use
 *     binance-cli request (GET|POST|PUT...) <url> [--signed]」
 * 所以「用 request 子命令去调官方公开入口」是官方技能文档认可的标准用法。
 *
 * CLI 的定位：优先读环境变量 BINANCE_CLI_PATH，其次从 PATH 里找 ——
 * 这样本地装与没装都能跑，且要上传的代码里不写死任何人的绝对路径。
 * ============================================================ */

const BINANCE_CLI_INSTALL_CMD =
  "curl --proto '=https' --tlsv1.2 -LsSf " +
  'https://github.com/binance/binance-cli/releases/latest/download/binance-cli-installer.sh | sh';

let CLI_BIN_CACHE = null;

/** 找出官方 CLI 的可执行文件路径；找不到返回 null */
function binanceCliBin() {
  if (CLI_BIN_CACHE !== null) return CLI_BIN_CACHE;
  const candidates = [];
  if (process.env.BINANCE_CLI_PATH) candidates.push(process.env.BINANCE_CLI_PATH);
  candidates.push('binance-cli');
  for (const bin of candidates) {
    try {
      const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 8000 });
      if (!r.error && r.status === 0) {
        CLI_BIN_CACHE = bin;
        return bin;
      }
    } catch (e) {
      /* 换下一个候选 */
    }
  }
  CLI_BIN_CACHE = null;
  return null;
}

/** 用官方 CLI 的 request 子命令取 K 线 */
function binanceCliKlines(symbol, interval, limit) {
  const bin = binanceCliBin();
  if (!bin) throw new Error('未找到官方 CLI 工具 binance-cli');
  const url = `${BINANCE_PUBLIC_BASE}/klines?symbol=${binancePair(symbol)}&interval=${interval}&limit=${limit}`;
  const r = spawnSync(bin, ['request', 'GET', url], {
    encoding: 'utf8',
    timeout: 40000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw new Error('binance-cli 调用失败：' + (r.error.message || r.error));
  const out = String(r.stdout || '');
  const s = out.indexOf('[');
  const e = out.lastIndexOf(']');
  if (s < 0 || e <= s) {
    throw new Error(
      'binance-cli 输出里没有 JSON 数组：' +
      (out.slice(0, 120) || String(r.stderr || '').slice(0, 120)),
    );
  }
  let rows;
  try {
    rows = JSON.parse(out.slice(s, e + 1));
  } catch (err) {
    throw new Error('binance-cli 输出解析失败：' + out.slice(s, s + 120));
  }
  if (!Array.isArray(rows) || !rows.length) throw new Error('binance-cli 没有返回 K 线数据');
  return mapBinanceKlines(rows);
}

/* ============================================================
 * 四、官方开源数据仓库通道（历史 K 线归档 ZIP）
 *
 * 路径：data/{spot|futures/um}/daily/klines/<PAIR>/<interval>/<PAIR>-<interval>-<YYYY-MM-DD>.zip
 *
 * 几个必须如实处理的点：
 *   1. 归档是 T+1，当天的文件通常还没发布 → 从昨天往前探测，命中即用并如实标注日期；
 *   2. spot 的 CSV 没有表头，futures 的有 → 统一用「首列必须是数字」来跳表头；
 *   3. 官方文件名存在「面值币」代码（PEPE 实际是 1000PEPEUSDT）→ 逐个试倍数前缀；
 *   4. Node 没有内置解压，这里自己按 ZIP 本地文件头解单个条目。
 * ============================================================ */

const ZIP_SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ZIP_CD_SIG = Buffer.from([0x50, 0x4b, 0x01, 0x02]);

/** 解出 ZIP 里第一个条目的文本内容（官方归档每个 ZIP 只放一个 CSV） */
function unzipFirstEntry(buf) {
  const start = buf.indexOf(ZIP_SIG);
  if (start < 0) throw new Error('不是有效的 ZIP（找不到本地文件头）');
  const method = buf.readUInt16LE(start + 8);
  const nameLen = buf.readUInt16LE(start + 26);
  const extraLen = buf.readUInt16LE(start + 28);
  const dataStart = start + 30 + nameLen + extraLen;
  let compLen = buf.readUInt32LE(start + 18);

  let data;
  if (compLen > 0 && dataStart + compLen <= buf.length) {
    data = buf.subarray(dataStart, dataStart + compLen);
  } else {
    // 流式写入的 ZIP 里这个长度可能是 0，退化到「取到中央目录之前」
    const cd = buf.indexOf(ZIP_CD_SIG, dataStart);
    data = buf.subarray(dataStart, cd > 0 ? cd : buf.length);
  }

  if (method === 0) return data.toString('utf8');
  try {
    return zlib.inflateRawSync(data).toString('utf8');
  } catch (e) {
    throw new Error('ZIP 解压失败：' + (e.message || e));
  }
}

/** CSV 文本 → candles；首列不是数字的行（表头）自动跳过 */
function parseKlineCsv(text) {
  const out = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const f = line.split(',');
    if (f.length < 6) continue;
    const t = Number(f[0]);
    if (!Number.isFinite(t)) continue; // 表头行
    const o = Number(f[1]);
    const h = Number(f[2]);
    const l = Number(f[3]);
    const c = Number(f[4]);
    const v = Number(f[5]);
    if (![o, h, l, c, v].every(Number.isFinite)) continue;
    // 时间戳精度实测不一致（早期毫秒 13 位、较新微秒 16 位），按量级自适应归一
    let ts = t;
    while (ts > 1e14) ts = Math.floor(ts / 1000);
    out.push({ t: ts, o, h, l, c, v, sum: Number(f[7]) || null });
  }
  return out;
}

function officialKlinesUrl(market, pair, interval, date) {
  const seg = market === 'spot' ? 'spot' : 'futures/um';
  return `${BINANCE_BLOB_BASE}/data/${seg}/daily/klines/${pair}/${interval}/${pair}-${interval}-${date}.zip`;
}

/** HEAD 探测某个归档文件在不在 */
async function blobExists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
  } catch (e) {
    return false;
  }
}

/** 找一个「已经发布」的归档日期：从昨天往前试 */
async function findLatestPublishedDate(market, pair, interval, maxBack = 6) {
  for (let i = 1; i <= maxBack; i += 1) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const url = officialKlinesUrl(market, pair, interval, d);
    if (await blobExists(url)) return { date: d, url };
  }
  return null;
}

/** 面值币代码回退：PEPE → 试 1000PEPE / 10000PEPE */
function faceValueCandidates(pair) {
  const base = pairBase(pair);
  return [`${base}USDT`, `1000${base}USDT`, `10000${base}USDT`];
}

/** 下载并解析某一天的归档 K 线 */
async function fetchOfficialDay(market, pair, interval, date) {
  const url = officialKlinesUrl(market, pair, interval, date);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`归档文件不存在（HTTP ${res.status}）`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { candles: parseKlineCsv(unzipFirstEntry(buf)), url };
}

/** 简单并发池 */
async function poolMap(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(Math.max(limit, 1), items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 官方归档通道主流程
 * @returns {{candles, pair, dateUsed, days, usedFaceValue, skippedDays, missingDays}}
 */
async function fetchOfficialKlines({ market, pair, interval, days, concurrency, quiet }) {
  // 面值币回退：逐个候选探测，第一个能探到文件的就用它
  let usePair = null;
  let anchor = null;
  const candidates = faceValueCandidates(pair);
  for (const cand of candidates) {
    const hit = await findLatestPublishedDate(market, cand, interval);
    if (hit) {
      usePair = cand;
      anchor = hit;
      break;
    }
  }
  if (!usePair || !anchor) {
    throw new Error(
      `官方归档里找不到 ${pair} 的 ${interval} K 线（已试 ${candidates.join(' / ')}，并回溯 6 天）`,
    );
  }

  const usedFaceValue = usePair !== binancePair(pair);
  if (usedFaceValue) {
    say(`官方归档里该币种用的是面值币代码「${usePair}」，已自动对应`, quiet);
  }
  say(`官方归档已发布到 ${anchor.date}（T+1 归档，当天的通常还没发布）`, quiet);

  // 从 anchor 那天往前回溯 days 天
  const dates = [];
  const anchorMs = Date.parse(anchor.date + 'T00:00:00Z');
  for (let i = 0; i < days; i += 1) {
    dates.push(new Date(anchorMs - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  }

  const results = await poolMap(dates, concurrency, async (d) => {
    try {
      const r = await fetchOfficialDay(market, usePair, interval, d);
      return { date: d, candles: r.candles, ok: true };
    } catch (e) {
      return { date: d, ok: false, error: e.message };
    }
  });

  const missingDays = results.filter((r) => !r.ok).map((r) => r.date);
  const got = results.filter((r) => r.ok && r.candles.length);
  if (!got.length) {
    throw new Error('官方归档这几天都没有下载到有效 K 线：' + (missingDays.join('、') || '未知原因'));
  }

  // 按时间升序拼接 + 按时间戳去重
  const byTime = new Map();
  got.forEach((r) => r.candles.forEach((c) => byTime.set(c.t, c)));
  const candles = [...byTime.values()].sort((a, b) => a.t - b.t);

  return {
    candles,
    pair: usePair,
    dateUsed: anchor.date,
    dateFrom: dates[dates.length - 1],
    days: got.length,
    usedFaceValue,
    missingDays,
  };
}

/* ============================================================
 * 五、参数解析（支持自然语言）
 * ============================================================ */

const INTERVALS = {
  '1m': { ms: 60 * 1000, label: '1分钟', perDay: 1440 },
  '5m': { ms: 5 * 60 * 1000, label: '5分钟', perDay: 288 },
  '15m': { ms: 15 * 60 * 1000, label: '15分钟', perDay: 96 },
  '30m': { ms: 30 * 60 * 1000, label: '30分钟', perDay: 48 },
  '1h': { ms: 60 * 60 * 1000, label: '1小时', perDay: 24 },
  '4h': { ms: 4 * 60 * 60 * 1000, label: '4小时', perDay: 6 },
};

const KNOWN_SYMBOLS = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'TON',
  'SUI', 'APT', 'ARB', 'OP', 'PEPE', 'WIF', 'SHIB', 'LTC', 'DOT', 'TRX',
];

/** 官方归档要下多少天才够算指标（EMA50 至少需要 50 根，这里目标 140 根） */
function defaultDaysFor(interval) {
  const per = (INTERVALS[interval] || INTERVALS['1h']).perDay;
  return Math.min(Math.max(Math.ceil(140 / per), 1), 16);
}

/** 把一句话里的通道意图映射成数据源 —— 只做保守的关键词匹配，识别不出就返回 null */
function sourceFromIntent(text) {
  if (/官方技能|技能包|binance-?cli/i.test(text)) return 'skill';
  if (/官方开源|开源数据|公开数据仓库|历史数据|官方归档|官方数据/i.test(text)) return 'official';
  if (/官方公开行情|官方行情|官方接口|官方实时|行情接口/i.test(text)) return 'live';
  if (/多平台|实时|综合平台|链上/i.test(text)) return 'realtime';
  return null;
}

function parseArgs(argv) {
  const opts = {
    market: 'perp',
    symbol: null,
    interval: '1h',
    source: 'realtime',
    limit: 500,
    days: null,
    concurrency: 4,
    json: false,
    help: false,
  };

  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--spot') opts.market = 'spot';
    else if (a === '--perp') opts.market = 'perp';
    else if (a === '--official' || a === '--binance-data') opts.source = 'official';
    else if (a === '--live' || a === '--binance-live') opts.source = 'live';
    else if (a === '--skill' || a === '--binance-cli') opts.source = 'skill';
    else if (a === '--realtime') opts.source = 'realtime';
    else if (a === '--limit') {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v > 0) opts.limit = Math.min(Math.round(v), 1000);
      i += 1;
    } else if (a === '--days') {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v > 0) opts.days = Math.min(Math.round(v), 30);
      i += 1;
    } else if (a === '--concurrency') {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v > 0) opts.concurrency = Math.min(Math.round(v), 32);
      i += 1;
    } else rest.push(a);
  }

  // 剩余参数当成一句自然语言来解析
  const text = rest.join(' ').trim();
  const explicitSource = argv.some((a) =>
    ['--official', '--binance-data', '--live', '--binance-live', '--skill', '--binance-cli', '--realtime'].includes(a));

  if (text) {
    const iv = text.match(/\b(1m|5m|15m|30m|1h|4h)\b/i);
    if (iv) opts.interval = iv[1].toLowerCase();
    else {
      const zh = text.match(/(1|5|15|30)\s*分钟/);
      if (zh) opts.interval = zh[1] + 'm';
      else if (/4\s*小时|4h/i.test(text)) opts.interval = '4h';
      else if (/1\s*小时|1h|小时线/i.test(text)) opts.interval = '1h';
    }

    const pair = text.match(/([A-Za-z0-9]{2,12})[\/_](USDT|usdt)/);
    if (pair) opts.symbol = pair[1].toUpperCase() + '_USDT';
    if (!opts.symbol) {
      const upper = text.toUpperCase().match(/\b([A-Z0-9]{2,12})\b/g) || [];
      const hit = upper.find((t) => t !== 'USDT' && !/^\d+$/.test(t) && !INTERVALS[t.toLowerCase()]);
      if (hit) opts.symbol = hit + '_USDT';
    }
    if (!opts.symbol) {
      const upperText = text.toUpperCase();
      const known = KNOWN_SYMBOLS.find((s) => upperText.indexOf(s) >= 0);
      if (known) opts.symbol = known + '_USDT';
    }
    if (/现货|spot/i.test(text)) opts.market = 'spot';
    if (!explicitSource) {
      const guessed = sourceFromIntent(text);
      if (guessed) {
        opts.source = guessed;
        opts.intentSource = guessed;
      } else {
        opts.intentUnmatched = true;
      }
    } else {
      // 只有句子里真的出现了通道关键词才提示「被显式参数忽略」——
      // 否则 "BTC 1h" 这种纯位置参数也会被误当成一句话
      const g = sourceFromIntent(text);
      if (g) {
        opts.intentIgnored = true;
        opts.intentConflict = g;
      }
    }
  }

  if (!opts.symbol) opts.symbol = 'BTC_USDT';
  if (opts.source === 'official' && !opts.days) opts.days = defaultDaysFor(opts.interval);

  return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
  console.log(`
短线共振信号智能体 · 命令行入口

四条数据通道（都不需要 API 密钥、都不涉及交易操作）：
  多平台实时    ：读综合交易平台与链上永续平台的公开行情接口取K线（与网页版完全一致）
  官方公开行情  ：--live，读币安公开行情入口 data-api.binance.vision 的 K 线
  官方开源数据  ：--official，读币安官方开源数据仓库 data.binance.vision 的历史 K 线归档 ZIP
  官方技能      ：--skill，调用官方 Skills Hub 的 binance 技能驱动的 binance-cli

用法：
  node agent.mjs                                  多平台实时，BTC 1小时
  node agent.mjs BTC 15m                          指定币种与周期
  node agent.mjs ETH --live                       币安官方公开行情接口
  node agent.mjs BTC --official                   币安官方开源数据仓库（回溯天数自动算）
  node agent.mjs BTC --official --days 5          指定回溯天数
  node agent.mjs BTC --official --spot            现货口径（默认永续）
  node agent.mjs SOL --skill                      官方技能通道（未装 binance-cli 会自动回退并给安装命令）
  node agent.mjs "看看 ETH 现在的共振信号"          自然语言
  node agent.mjs BTC --json                       输出纯 JSON（进度信息走 stderr）
  node agent.mjs BTC --limit 800                  指定取多少根K线（默认 500）

参数：
  --live            币安官方公开行情接口（data-api.binance.vision）
  --official        币安官方开源数据仓库（data.binance.vision 归档 ZIP，T+1）
  --skill           官方技能通道（binance-cli；未安装时如实回退到 --live）
  --realtime        多平台实时（默认通道，与网页版一致）
  --spot / --perp   现货 / 永续（默认永续）
  --days N          仅 --official：回溯天数，默认按周期自动算到约 140 根K线
  --limit N         取多少根K线，默认 500，上限 1000
  --concurrency N   --official 的并发下载数，默认 4，上限 32
  --json            输出纯 JSON，便于程序解析

提示：本作品是「按K线即时计算」的横截面分析，没有需要跨次保留的本地状态，
      因此不提供 --status / --reset 这类状态管理参数。
`);
  process.exit(0);
}

/* ============================================================
 * 六、主线：按通道取数 → 喂给自研引擎
 * ============================================================ */

const say = (s = '') => (opts.json ? process.stderr.write(String(s) + '\n') : console.log(s));
const started = Date.now();

if (opts.symbol) {
  // 符号统一成 XXX_USDT 形式，便于四个通道共用
  const s = String(opts.symbol).toUpperCase();
  opts.symbol = s.includes('_') ? s : s.replace(/USDT$/, '') + '_USDT';
}
if (opts.intentUnmatched) {
  say('未从自然语言中识别出数据通道，沿用默认通道（多平台实时）');
} else if (opts.intentIgnored) {
  say('已显式指定数据通道，忽略自然语言里的通道意图');
}

/** 通道一：多平台实时（与网页版同一份 data-direct.js 代码） */
async function collectRealtime() {
  const platform = opts.market === 'spot' ? 'gate' : 'hyperliquid';
  const env = await DataDirect.fetchMarketEnvelope({
    platform,
    market: opts.market,
    // 链上永续平台用 BTC 这种基础币种；综合交易平台用 BTC_USDT 这种带下划线的交易对
    symbol: platform === 'hyperliquid' ? pairBase(opts.symbol) : String(opts.symbol).toUpperCase(),
    interval: opts.interval,
    limit: opts.limit,
  });
  if (!env.ok) throw new Error(env.error || '多平台行情接口请求失败');
  return {
    candles: env.candles,
    ticker: env.ticker || {},
    sourceLabel: env.sourceLabel || '多平台公开行情接口',
    symbol: env.symbol || binancePair(opts.symbol),
    display: env.display || binancePair(opts.symbol),
    via: 'direct',
  };
}

/** 通道二：币安官方公开行情接口 */
async function collectLive() {
  const [ticker, candles] = await Promise.all([
    fetchBinanceQuote(opts.symbol),
    fetchBinanceKlines(opts.symbol, opts.interval, opts.limit),
  ]);
  return {
    candles,
    ticker: {
      last: Number(ticker.lastPrice),
      changePercent24h: Number(ticker.priceChangePercent),
      quoteVolume24h: Number(ticker.quoteVolume),
      high24h: Number(ticker.highPrice),
      low24h: Number(ticker.lowPrice),
      openInterestUsd: null, // 现货快照不提供持仓量与资金费率，如实留空
      fundingAnnualized: null,
    },
    sourceLabel: '币安官方公开行情接口（data-api.binance.vision）',
    symbol: binancePair(opts.symbol),
    display: String(opts.symbol).replace('_', '/'),
    via: 'official-rest',
  };
}

/** 通道三：币安官方开源数据仓库（历史归档 ZIP） */
async function collectOfficial() {
  const r = await fetchOfficialKlines({
    market: opts.market,
    pair: binancePair(opts.symbol),
    interval: opts.interval,
    days: opts.days,
    concurrency: opts.concurrency,
    quiet: opts.json,
  });
  return {
    candles: r.candles,
    ticker: {},
    sourceLabel: '币安官方开源数据仓库（data.binance.vision 归档 ZIP）',
    symbol: r.pair,
    display: r.pair.replace(/USDT$/, '/USDT'),
    via: 'official-archive',
    archive: {
      dateFrom: r.dateFrom,
      dateTo: r.dateUsed,
      daysUsed: r.days,
      usedFaceValue: r.usedFaceValue,
      missingDays: r.missingDays,
    },
  };
}

/** 通道四：官方技能（binance-cli）；未装则如实回退并标注 */
async function collectSkill() {
  if (!binanceCliBin()) {
    say('');
    say('未检测到官方 CLI 工具 binance-cli，本次如实回退到「官方公开行情」通道（同一 REST 端点）。');
    say('想用官方技能通道，请先安装官方 CLI，官方安装命令：');
    say('  ' + BINANCE_CLI_INSTALL_CMD);
    say('（Windows 也可直接下载官方 v2.0.0 构建的 zip 解压出 binance-cli.exe，'
      + '放到 PATH 里或设置环境变量 BINANCE_CLI_PATH 指向它）');
    say('');
    const fallback = await collectLive();
    return { ...fallback, requestedSource: 'skill', sourceLabel: fallback.sourceLabel };
  }
  const [ticker, candles] = await Promise.all([
    fetchBinanceQuote(opts.symbol),
    Promise.resolve().then(() => binanceCliKlines(opts.symbol, opts.interval, opts.limit)),
  ]);
  return {
    candles,
    ticker: {
      last: Number(ticker.lastPrice),
      changePercent24h: Number(ticker.priceChangePercent),
      quoteVolume24h: Number(ticker.quoteVolume),
      high24h: Number(ticker.highPrice),
      low24h: Number(ticker.lowPrice),
      openInterestUsd: null,
      fundingAnnualized: null,
    },
    sourceLabel: '官方技能 binance（经官方 CLI binance-cli 调官方公开行情接口）',
    symbol: binancePair(opts.symbol),
    display: String(opts.symbol).replace('_', '/'),
    via: 'binance-cli',
  };
}

const CHANNEL_LABEL = {
  realtime: '多平台实时',
  live: '币安官方公开行情接口',
  official: '币安官方开源数据仓库',
  skill: '币安官方技能（binance-cli）',
};

async function main() {
  say(`通道：${CHANNEL_LABEL[opts.source]}　币种：${opts.symbol}　周期：${INTERVALS[opts.interval].label}`);

  let bundle;
  if (opts.source === 'official') bundle = await collectOfficial();
  else if (opts.source === 'live') bundle = await collectLive();
  else if (opts.source === 'skill') bundle = await collectSkill();
  else bundle = await collectRealtime();

  const candles = (bundle.candles || [])
    .filter((c) => [c.t, c.o, c.h, c.l, c.c, c.v].every((x) => Number.isFinite(Number(x))))
    .map((c) => ({ t: Number(c.t), o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), v: Number(c.v) }))
    .sort((a, b) => a.t - b.t);

  if (candles.length < 60) {
    throw new Error(
      `K 线只有 ${candles.length} 根，不足以计算指标（EMA50 与 MACD 至少需要 60 根以上）。` +
      '官方归档通道可以加大 --days，其他通道可以加大 --limit。',
    );
  }

  say(`取得 ${candles.length} 根K线，正在计算四指标与过滤规则 ...`);

  // 引擎与网页完全一致：先算指标，再做共振判定与假信号过滤
  const ctx = Indicators.calcAll(candles);
  const result = SignalEngine.analyze(ctx, 48);
  const cur = result.current;

  const lastCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];

  const payload = {
    task: '短线共振信号',
    ok: true,
    source: opts.source,
    sourceLabel: bundle.sourceLabel,
    symbol: bundle.symbol || binancePair(opts.symbol),
    display: bundle.display || binancePair(opts.symbol),
    market: opts.market,
    interval: opts.interval,
    intervalLabel: INTERVALS[opts.interval].label,
    via: bundle.via,
    archive: bundle.archive || null,
    requestedSource: bundle.requestedSource || null,
    candleCount: candles.length,
    firstCandleTime: new Date(candles[0].t).toISOString(),
    lastCandleTime: new Date(lastCandle.t).toISOString(),
    lastCandleForming: !!cur.lastForming,
    price: cur.price,
    priceChangeLastCandlePct:
      prevCandle && prevCandle.c ? ((lastCandle.c - prevCandle.c) / prevCandle.c) * 100 : null,
    ticker: bundle.ticker || {},
    rating: { key: cur.rating.key, label: cur.rating.label, desc: cur.rating.desc },
    finalScore: cur.finalScore,
    baseScore: cur.baseScore,
    totalPenalty: cur.totalPenalty,
    agreeSide: cur.agreeSide,
    agreeCount: cur.agreeCount,
    bullVotes: cur.bullVotes,
    bearVotes: cur.bearVotes,
    fullyFiltered: cur.fullyFiltered,
    judges: cur.judges.map((j) => ({
      key: j.key,
      name: j.name,
      vote: j.vote,
      state: j.state,
      ok: j.ok,
      zone: j.zone || null,
      cross: j.cross || null,
      momentum: j.momentum || null,
      value: j.value !== undefined ? j.value : null,
    })),
    filters: cur.filters.map((f) => ({
      id: f.id,
      name: f.name,
      status: f.status,
      detail: f.detail,
      penalty: f.penalty,
    })),
    history: result.history,
    engine: 'indicators.js + signal-engine.js（本项目自研，纯规则、可复现）',
    generatedAt: new Date().toISOString(),
    elapsedSeconds: Number(((Date.now() - started) / 1000).toFixed(2)),
    honesty: [],
  };

  /* 诚实边界：本次结论必须一起交代的前提，一条都不省略 */
  payload.honesty.push('四指标共振是程序化技术信号，用于描述市场结构，不是交易指令，不构成投资建议。');
  payload.honesty.push(
    `本引擎按传入的整段K线计算指标，本次用了 ${candles.length} 根；技术指标（EMA / MACD / RSI）的取值`
    + '与窗口长度有关，跨通道或跨 --limit 比较结论时请保持根数一致，'
    + '否则数值差异来自窗口口径，而不是数据出错。',
  );
  if (opts.source === 'official') {
    payload.honesty.push(
      `官方开源数据仓库是 T+1 归档，本次用的是 ${payload.archive.dateFrom} ~ ${payload.archive.dateTo} 的已发布文件`
      + `（共 ${payload.archive.daysUsed} 天）。`,
    );
    if (payload.archive.usedFaceValue) {
      payload.honesty.push(`该币种在官方归档里用的是面值币代码「${payload.symbol}」，已自动对应。`);
    }
    if (payload.archive.missingDays && payload.archive.missingDays.length) {
      payload.honesty.push(`以下日期没有取到归档文件（按缺失如实处理，未补齐）：${payload.archive.missingDays.join('、')}。`);
    }
    payload.honesty.push('本通道的K线来自官方归档，最新一根是已收线的；实时成交尚未走完的那根不在其中。');
  }
  if (opts.source === 'live' || opts.source === 'skill') {
    payload.honesty.push('现货快照不含合约持仓量与资金费率，本通道这两项如实留空，不估算。');
  }
  if (opts.source === 'skill' && payload.requestedSource === 'skill' && bundle.via !== 'binance-cli') {
    payload.honesty.push('本次未检测到官方 CLI binance-cli，已如实回退到官方公开行情通道（同一 REST 端点），并非真的经由官方 CLI 调用。');
  }
  if (cur.lastForming) {
    payload.honesty.push('最新一根K线可能仍在形成中，方向会随价格变化；量能比较已避开这根未收线K线。');
  }
  payload.honesty.push(
    '「评级变化轨迹」按引擎原有口径只计算基础分、不叠加过滤降级，所以它的分数与「共振评级」的'
    + '最终分不是同一个口径；轨迹用于观察方向是否稳定，不能替代最终结论。',
  );
  if (candles.length < 100) {
    payload.honesty.push(`本次只取到 ${candles.length} 根K线，长周期指标（如 EMA50、MACD）的起步阶段会受影响。`);
  }

  /* ---------------- 输出 ---------------- */

  if (opts.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return;
  }

  const line = '─'.repeat(70);
  const eq = '='.repeat(70);
  const voteText = (v) => (v > 0 ? '偏多' : v < 0 ? '偏空' : '中性');
  const num = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  const fmtTime = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const statusText = (s) =>
    s === 'trigger' ? '触发' : s === 'pass' ? '通过' : s === 'ok' ? '不适用' : String(s);

  console.log(eq);
  console.log(' 短线共振信号智能体');
  console.log(eq);
  console.log(` 数据来源：${payload.sourceLabel}`);
  console.log(` 通道标识：${payload.source}${payload.via ? ' / ' + payload.via : ''}      耗时 ${payload.elapsedSeconds} 秒`);
  console.log(` 交易对　：${payload.display}（${payload.symbol}）      市场：${payload.market === 'spot' ? '现货' : '永续合约'}`);
  console.log(` K线周期：${payload.intervalLabel}      根数：${payload.candleCount}`);
  console.log(` 最新K线：${fmtTime(payload.lastCandleTime)}${payload.lastCandleForming ? '（可能仍在形成中）' : '（已收线）'}`);
  if (payload.archive) {
    console.log(` 归档区间：${payload.archive.dateFrom} ~ ${payload.archive.dateTo}（用了 ${payload.archive.daysUsed} 天）`);
  }
  console.log(line);
  console.log(` 共振评级：${payload.rating.label}    综合评分 ${num(payload.finalScore, 1)}（区间 -100 ~ +100）`);
  console.log(` 评级说明：${payload.rating.desc}`);
  console.log(` 打分过程：基础分 ${num(payload.baseScore, 1)}    过滤扣分 ${num(payload.totalPenalty, 1)}    最终 ${num(payload.finalScore, 1)}`);
  const sideText = payload.agreeSide === 'bull' ? '偏多' : payload.agreeSide === 'bear' ? '偏空' : '无明确方向';
  console.log(` 共振强度：${payload.agreeCount}/4 个指标与最终方向一致（${sideText}）`);
  if (payload.fullyFiltered) {
    console.log(' ⚠ 原本有方向，但强度被过滤规则完全削弱到 0 —— 属于典型的高风险假信号，已降级为震荡。');
  }
  console.log(line);
  console.log(' 四指标逐项明细');
  for (const j of payload.judges) {
    const extra = [];
    if (j.value !== null && j.value !== undefined && j.key === 'rsi') extra.push(`RSI ${num(j.value, 1)}`);
    if (j.cross) extra.push(j.cross === 'golden' ? '金叉' : '死叉');
    if (j.zone && j.zone !== 'normal') extra.push(j.zone === 'overbought' ? '超买区' : '超卖区');
    if (j.momentum && j.momentum !== 'flat') {
      extra.push(j.momentum === 'expanding-up' ? '动能放大(多)' : j.momentum === 'expanding-down' ? '动能放大(空)' : '动能收缩');
    }
    console.log(`  ${String(j.name).padEnd(5)} ${voteText(j.vote).padEnd(4)} ${j.state}${extra.length ? '（' + extra.join('，') + '）' : ''}`);
  }
  console.log(line);
  console.log(' 假信号过滤（六条规则）');
  for (const f of payload.filters) {
    const mark = f.status === 'trigger' ? '✕' : '✓';
    console.log(`  ${mark} ${String(f.name).padEnd(12)} ${statusText(f.status).padEnd(4)} ${f.penalty ? `${f.penalty} 分　` : ''}${f.detail}`);
  }
  console.log(line);
  console.log(' 评级变化轨迹（最近 48 根K线，从旧到新；轨迹只算基础分、不含过滤降级）：');
  const hist = payload.history.slice(-48);
  const arrow = { strong_long: '强多', cautious_long: '谨多', neutral: '震荡', strong_short: '强空' };
  console.log('  ' + hist.map((h) => arrow[h.rating] || '—').join(' '));
  console.log('  最新一根：' + (hist.length
    ? `${arrow[hist[hist.length - 1].rating]}　基础分 ${num(hist[hist.length - 1].score, 1)}（含过滤的最终结论见上方「共振评级」）`
    : '—'));
  console.log(eq);
  for (const h of payload.honesty) console.log(' · ' + h);
  console.log('\n分析结果仅用于研究，不构成投资建议。');
}

main().catch((err) => {
  const message = err && err.message ? err.message : String(err);
  if (opts.json) {
    process.stderr.write('执行失败：' + message + '\n');
    process.stdout.write(
      JSON.stringify({ task: '短线共振信号', ok: false, error: message }, null, 2) + '\n',
    );
  } else {
    console.log('');
    console.log('执行失败：' + message);
    console.log('（本工具不会用演示数据顶替，取不到就如实报错）');
  }
  process.exit(1);
});
