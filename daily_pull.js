'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// 店铺与 CLI 全部来自配置（config.json 或环境变量），脚本本身不含任何店铺信息
const { requireConfig } = require('./config');
const { ensureStore } = require('./store_guard');
const cfg = requireConfig();
const CLI = cfg.cliPath;
const STORE_ID = cfg.storeId;
const STORE_NAME = cfg.storeName;
const URL_ = cfg.marketplaceUrl;
const DIR = __dirname;
const MASTER = path.join(DIR, 'master.csv');
const GOOD_BAK = path.join(DIR, 'master.csv.good.bak'); // last-known-good 自愈快照
const HEADER = ['Marketplace', 'Order ID', 'Image', 'Title', 'ASIN', 'Seller SKU', 'Return Reason', 'Authorization Date', 'Refund Date', 'Unit Received Date', 'Disposition', 'Status', 'Action'];
const FILTER = 'LAST_7_DAYS'; // 7天退款日窗口: 游标方案已改为"全量翻页扫描整窗 + 按订单×ASIN 去重",不再命中游标即停。
// 原因: FBA 退货列表按授权/订单时间排序, 退款日刚进 7 天窗口但排序键更老的记录会排在游标下方被漏抓;
// 全扫整窗(筛选本就按退款日)可闭合该缺口。7 天窗口单次约 2-3 页, 远低于 UI ~1万行上限;
// 退款日 >7 天的迟到记录由独立"每周深扫(30天)"兜底(见对话与 automation memory)。
const PAGE_SIZE = 1000;
const MAX_PAGES = 50; // 仅作失控保护: 全扫整窗正常情况下 2-3 页即无下一页而停
// ---- 页面延迟容忍 (2026-09-23 修复) ----------------------------------------
// 故障现象: 拉取页数=1 / 只抓到 25 条 / stuck=true。
// 根因: Amazon FBA Return 表格是服务端渲染, 改「每页条数」和点「下一页」之后,
//       数据要 20~60s 才真正落下来。旧版用固定 sleep(9~11s / 8~10s) 硬等,
//       结果 ①表格仍是默认 25 行就开抓 -> 只拿到 25 条;
//            ②点 next 后首行没变就判「翻页卡死」-> 直接中断整个 7 天窗扫描。
//       故障是间歇性的(09-15 / 09-17 / 09-23 均命中), 会被误读成「低量日」。
// 修法: 不再猜时间, 轮询到「页面实测状态真的变了」才继续。任何一次未达标都重试/降级,
//       绝不因为"没等够"而假设已达万行上限。7 天窗真实量约 9 千条(363 页 x 25)。
const SETTLE_RPP_TIMEOUT_MS = 150000;   // 「每页条数」生效上限 150s
const SETTLE_PAGE_TIMEOUT_MS = 120000;  // 「翻页」生效上限 120s
const POLL_INTERVAL_MS = 4000;          // 轮询间隔

const STATE = path.join(DIR, 'daily_state.json');
// 导出日报的 Title 列: 保留列头、清空内容(用户 2026-09-17 定, 因日报要上传钉钉知识库)。
// master.csv 是本地台账, 仍保留 Title 原文, 只有外发的日报分片做脱敏。
// 需要临时还原全文时: FBA_KEEP_TITLE=1 node daily_pull.js
const REDACT_TITLE = process.env.FBA_KEEP_TITLE !== '1';
const TITLE_IDX = HEADER.indexOf('Title');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => Math.floor(a + Math.random() * (b - a));
const esc = c => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"';
// 提取已在浏览器内由 extract_full.js 完成 DOM 结构化:
// Title/ASIN/Seller SKU 直接分离(非 B0 的 ASIN 也能精准取到),
// Return Reason 仅取原因分类、自动剥离买家留言 "comment" 块。
// extract_full 直接返回 13 列, 无需再拆分。
// 原子写入: 先写 .tmp 再 rename, 杜绝半截写入导致文件损坏
function atomicWrite(p, content) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, p);
}
// 写后校验: 确认文件是合法 13 列 CSV(任一行列数不符即报警, 不静默损坏)
function verifyCsv(p, expectCols) {
  try {
    const txt = fs.readFileSync(p, 'utf8');
    const lines = txt.split('\n').filter(l => l.length);
    let bad = 0;
    for (let i = 1; i < lines.length; i++) {
      if (parseCSVLine(lines[i]).length !== expectCols) { bad++; if (bad <= 3) console.error('   [校验] 第', i + 1, '行列数异常:', parseCSVLine(lines[i]).length); }
    }
    if (bad > 0) console.error('   [校验]', p, '有', bad, '行不是', expectCols, '列!');
    else console.log('   [校验]', path.basename(p), 'OK:', lines.length - 1, '行 x', expectCols, '列');
    return bad === 0;
  } catch (e) { console.error('   [校验] 读取失败:', p, e.message); return false; }
}

// 严格 CSV 单行解析(处理引号内逗号与转义引号)
function parseCSVLine(line) {
  const row = []; let i = 0, field = '', inQ = false;
  while (i < line.length) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += c; i++; continue;
    } else {
      if (c === '"') { inQ = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      field += c; i++;
    }
  }
  row.push(field); return row;
}
// 去重键:订单号 + ASIN(Product 单元格里提取),一条退货事件只记一次
function rowKeyOf(cells) {
  const orderId = cells[1] || '';
  let asin = '';
  if (cells.length >= 5) asin = cells[4] || '';            // 13 列: ASIN 在第 5 列(index 4)
  if (!asin) { const m = (cells[3] || '').match(/B0[A-Z0-9]{8}/); asin = m ? m[0] : ''; }
  return orderId + '|' + asin;
}

function runCli(args, timeout = 60000) {
  return new Promise(resolve => {
    const cp = spawn(CLI, args, { timeout });
    let out = '', err = '';
    cp.stdout.on('data', d => out += d);
    cp.stderr.on('data', d => err += d);
    cp.on('close', code => resolve({ code, out, err }));
    cp.on('error', e => resolve({ code: -1, out, err: String(e) }));
  });
}
function parseExecResult(s) {
  try {
    const o = JSON.parse(s);
    const inner = o?.data?.data?.result;
    if (typeof inner === 'string') { const r = JSON.parse(inner); if (r && r.status) return r; }
    if (inner && typeof inner === 'object' && inner.status) return inner;
    if (o?.status) return o;
  } catch (e) {}
  return null;
}
// 2026-09-23: 增加瞬态重试。ZClaw Bridge 会「端口在听但假死」, 表现为
// CDP_ERROR / 无法连接 Bridge; 这类错误单发重试即可恢复, 不应直接判失败。
async function pageExecOnce(tid, scriptFile, timeout) {
  const script = fs.readFileSync(scriptFile, 'utf8');
  const r = await runCli(['page', 'exec', '--store-id', STORE_ID, '--target-id', tid, '--script', script, '--timeout', '50000'], timeout);
  if (r.code !== 0) return { transient: true, err: r.err.slice(0, 300) };
  const res = parseExecResult(r.out);
  if (!res) return { transient: true, err: 'no parseable result' };
  return { transient: false, res };
}
async function pageExec(tid, scriptFile, timeout = 55000) {
  const TRANSIENT_RETRY = 3;
  for (let i = 1; i <= TRANSIENT_RETRY; i++) {
    const r = await pageExecOnce(tid, scriptFile, timeout);
    if (!r.transient) return r.res;
    const isTransient = /CDP_ERROR|无法连接紫鸟浏览器|network|timeout|ECONNREFUSED/i.test(r.err || '');
    console.error('page exec failed' + (isTransient ? ' [transient]' : '') + ':', (r.err || '').slice(0, 200));
    if (!isTransient || i === TRANSIENT_RETRY) return null;
    // 桥假死时给足恢复时间, 退避重试
    await sleep(6000 * i);
  }
  return null;
}
function makeInjectScript(val) {
  // 2026-09-23 修复: 必须走「原型 setter + input/change」双事件。
  // 直接 sel.value=... 只是改了 DOM 属性, 页面(AJS/jQuery 受控组件)检测不到,
  // 表格不会重新取数 —— 旧版因此误报 OK 却停在 25 行/页。
  // 且 1000 不是页面自带选项, 需要先补一个真 option。
  return `(function(){
    try{
      function find(){
        return Array.from(document.querySelectorAll('select')).find(function(s){
          return /results per page/.test(Array.from(s.options).map(function(o){return o.text||'';}).join('|'))
              || /25|50|100/.test(Array.from(s.options).map(function(x){return x.value;}).join(','));
        });
      }
      var sel=null, tries=0;
      while(tries<25 && !(sel=find())){ tries++; }
      if(!sel) return JSON.stringify({status:'NO_SELECT'});
      var want=String(${val});
      var opt=Array.from(sel.options).find(function(o){ return o.value===want; });
      if(!opt){
        opt=document.createElement('option');
        opt.value=want; opt.text=want+' results per page';
        sel.appendChild(opt);
      }
      var d=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value');
      d.set.call(sel, want);
      sel.dispatchEvent(new Event('input', {bubbles:true}));
      sel.dispatchEvent(new Event('change',{bubbles:true}));
      try{ if(window.jQuery) window.jQuery(sel).trigger('change'); }catch(e){}
      return JSON.stringify({status:'OK', setTo: sel.value});
    }catch(e){return JSON.stringify({status:'ERR', msg:String(e)});}
  })();`;
}

// 读取页面实测状态(行数 / 首行主键 / 每页条数 / 分页文本)。用于「等到真的变了」而不是猜时间。
async function readPageKey(tid) {
  const k = await pageExec(tid, path.join(DIR, 'page_key.js'));
  return (k && k.status === 'OK') ? k : null;
}
// 分页器终态复核(只读): next.js 报 NO_NEXT/DISABLED 时不单次采信, 用它做二次确认。
// 2026-09-28 事故: 第 7 页后 next.js 一次性返回非 OK -> 直接判「无下一页」,
// 整窗尾部(第 8/9 页, 约 2000 行)被静默吞掉; 实为分页控件重渲染期间短暂不可用。
async function readPagerState(tid) {
  const p = await pageExec(tid, path.join(DIR, 'page_end.js'));
  return (p && p.status === 'OK') ? p : null;
}
// 从分页器文本解析「整窗总页数」(独立裁判, 2026-09-28 二次修复)。
// 例: "Prev 1 2 3 4 5 6 7 8 9 Next" -> 9。
// 出现 "..." 省略号说明页码被截断 -> 返回 null(未知), 不猜。
// 页面慢时 分页器/Next 按钮 会在重渲染期间读不到, 此时 hasUsableNext=false 属**假阴性**,
// 绝不能当成「已到末页」的证据 —— 必须用总页数这个稳定事实来判。
function parseTotalPages(pagerText) {
  const t = String(pagerText || '');
  if (!t || !/Next|Prev/.test(t) || /\.\.\.|…/.test(t)) return null;
  const nums = (t.match(/\d+/g) || []).map(Number).filter(n => n > 0);
  return nums.length ? Math.max(...nums) : null;
}


// 日报命名规则(用户 2026-09-02 定):
//   "<北京时间 M月D日>导出增量数据_<MM-DD> (N 条) + <MM-DD> (M 条).csv"
//   例: 9月2日导出增量数据_08-31 (548 条) + 09-01 (1115 条).csv
// 说明:
//   - 统计维度 = Refund Date(退款日), 即本次新增行的退款日期分布
//   - 日期原本是 MM/DD/YYYY, 取 MM-DD; "/" 在 Unix 文件名里是路径分隔符, 必须换成 "-"
//   - 多天时按日期升序, 用 " + " 连接; 未标注日期归入 "未标注" 并排最后
//   - 长度保护: 分布天数过多会超出文件系统 255 字节上限, 此时退化为区间摘要
function buildDailyName(rows) {
  const counts = new Map();
  for (const r of rows) {
    let d = String(r[8] == null ? '' : r[8]).trim();
    if (!d || d === '--') d = '未标注';
    else {
      const m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      d = m ? (m[1] + '-' + m[2]) : d.replace(/\//g, '-');
    }
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  const entries = [...counts.entries()].sort((a, b) => {
    if (a[0] === '未标注') return 1;
    if (b[0] === '未标注') return -1;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  const bj = new Date(Date.now() + 8 * 3600 * 1000); // 北京时间 = UTC+8
  const mm = bj.getUTCMonth() + 1, dd = bj.getUTCDate();
  const prefix = `${mm}月${dd}日导出增量数据_`;
  const full = entries.map(([d, n]) => `${d} (${n} 条)`).join(' + ');
  const safe = Buffer.byteLength(prefix + full + '.csv', 'utf8') <= 180
    ? full
    : `${entries[0][0]}~${entries[entries.length - 1][0]} (${rows.length} 条)`;
  return prefix + safe + '.csv';
}

// 同一天重跑时, 若退款日分布与上一次完全相同, 日报文件名会撞车, 直接写会静默覆盖上一份。
// 这里在撞车时追加序号后缀。注意: master 主表不受影响, 数据不会丢, 仅日报分片多一份。
function uniqueDailyPath(p) {
  if (!fs.existsSync(p)) return p;
  const base = p.replace(/\.csv$/, '');
  for (let i = 2; i < 100; i++) {
    const cand = `${base} (${i}).csv`;
    if (!fs.existsSync(cand)) return cand;
  }
  return `${base} (${Date.now()}).csv`;
}

function readMaster() {
  if (!fs.existsSync(MASTER)) return { existing: new Set(), lines: [HEADER.map(esc).join(',')] };
  let txt = fs.readFileSync(MASTER, 'utf8');
  // 保安检 1: 主文件绝不能是 xlsx/二进制(历史上曾因提取异常被写成 PK 压缩包)
  if (/^PK\x03\x04/.test(txt) || txt.slice(0, 2) === 'PK') {
    // 自愈: 尝试从 last-known-good 快照恢复, 避免人工介入
    if (fs.existsSync(GOOD_BAK)) {
      console.error('[自愈] master 是 xlsx/二进制, 尝试从', path.basename(GOOD_BAK), '恢复');
      fs.copyFileSync(GOOD_BAK, MASTER);
      return readMaster(); // 递归重读
    }
    return { corrupt: true, reason: 'MASTER 是 xlsx/二进制, 且无 good.bak 可恢复' };
  }
  const lines = txt.split('\n').filter(l => l.length);
  // 保安检 2: 表头必须是合法 13 列且等于 HEADER
  const head = parseCSVLine(lines[0] || '');
  if (head.length !== HEADER.length || head.join(',') !== HEADER.join(',')) {
    if (fs.existsSync(GOOD_BAK)) {
      console.error('[自愈] master 表头异常(列数=' + head.length + '), 尝试从 good.bak 恢复');
      fs.copyFileSync(GOOD_BAK, MASTER);
      return readMaster(); // 递归重读
    }
    return { corrupt: true, reason: `MASTER 表头异常(列数=${head.length}), 拒绝读入` };
  }
  const existing = new Set();
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCSVLine(lines[i]);
    existing.add(rowKeyOf(cells));
  }
  if (lines.length === 0) lines.push(HEADER.map(esc).join(','));
  return { existing, lines };
}

// 游标状态:记录上次运行抓到的最新 Order ID(列表顶部=最新),下次从顶部往下翻,
// 重新遇到该 Order ID 即抵达"上次边界",其上方全为新增,到此停止翻页。
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { return {}; }
}
function writeState(s) { fs.writeFileSync(STATE, JSON.stringify(s, null, 2), 'utf8'); }

(async () => {
  const t0 = Date.now();
  // today 一律按北京时间(UTC+8)计算, 与用户心智一致, 也决定日报文件名前缀
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  console.log(`[${today}] ${STORE_NAME} FBA 每日新增退货提取 启动`);

  // 0) 前置判定：店铺必须可控且在 FBA 退货页（store_guard.js，来源无关 + 失败自动补救）
  //    FBA_FORCE_FRESH=1  → 直接关店冷启动
  //    FBA_NO_REMEDIATE=1 → 禁用自动补救（仅验证）
  const g = await ensureStore(cfg, {
    fresh: process.env.FBA_FORCE_FRESH === '1',
    remediate: process.env.FBA_NO_REMEDIATE !== '1',
  });
  g.warnings.forEach(w => console.warn('   [guard][warn] ' + w));
  if (!g.ok) { console.error('[guard] 中止: ' + g.reason); process.exit(11); }
  const tid = g.tid;
  await sleep(6000);

  // 1) apply LAST_7_DAYS filter
  console.log('1) 设置筛选 =', FILTER);
  let f = null;
  for (let i = 0; i < 4; i++) { f = await pageExec(tid, path.join(DIR, 'set_filter.js')); if (f && f.status === 'OK') break; await sleep(rand(4000, 6000)); }
  console.log('   ', JSON.stringify(f));
  if (!f || f.status !== 'OK') { console.error('设置筛选失败'); process.exit(1); }
  await sleep(rand(9000, 11000));

  // 2) 注入每页条数, 并轮询到「表格实测行数」真的变成目标值(而不是只看 select.value)
  console.log('2) 注入 recordsPerPage =', PAGE_SIZE);
  const injFile = path.join(DIR, '_inject_tmp.js');
  fs.writeFileSync(injFile, makeInjectScript(PAGE_SIZE));
  const baseKey = await readPageKey(tid);
  const baseRows = baseKey ? baseKey.rowCount : -1;
  let inj = null;
  let rppOk = false;
  let knownTotalPages = null;   // 整窗总页数(独立裁判): settle 时分页器读到的最大页码
  for (let attempt = 1; attempt <= 3 && !rppOk; attempt++) {
    inj = await pageExec(tid, injFile);
    console.log('   inject#' + attempt + ':', JSON.stringify(inj));
    if (!inj || inj.status !== 'OK') { await sleep(rand(5000, 7000)); continue; }
    const t0s = Date.now();
    while (Date.now() - t0s < SETTLE_RPP_TIMEOUT_MS) {
      await sleep(POLL_INTERVAL_MS);
      const k = await readPageKey(tid);
      if (!k) continue;
      // 生效判据: 表格行数已不是注入前的基线(说明真重新取数了),
      // 或已经够到目标页大小(窗口总行数可能少于 PAGE_SIZE)。
      const target = Math.min(PAGE_SIZE, 900);
      if (k.rowCount !== baseRows || k.rowCount >= target) {
        rppOk = true;
        // 顺手拿下整窗总页数(注入后分页器已按 1000/页 重算): 后续判"是否到末页"用这个, 不靠易假阴性的按钮状态
        knownTotalPages = parseTotalPages(k.pagerText);
        console.log('   [settle] 每页条数生效于 ~' + Math.round((Date.now() - t0s) / 1000) + 's: rows=' + k.rowCount + ' (注入前 ' + baseRows + ') pg=' + String(k.pagerText || '').slice(0, 50) + (knownTotalPages ? (' 总页数=' + knownTotalPages) : ' 总页数=未知'));
        break;
      }
    }
    if (!rppOk) console.log('   [settle] inject#' + attempt + ' 后 ' + (SETTLE_RPP_TIMEOUT_MS / 1000) + 's 内表格未变化, 重试');
  }
  if (!rppOk) {
    // 不因为等不到就假设"已达万行上限"继续跑 —— 那正是本次事故的成因。直接失败留待续跑。
    console.error('[settle] 每页条数注入未生效, 本轮中止(不落盘, 幂等可续跑)');
    try { fs.unlinkSync(injFile); } catch (e) {}
    process.exit(6);
  }

  // 3) paginate + collect (全量翻页扫描 7 天整窗: 不再命中游标即停, 翻到无下一页为止;
  //    游标仅作日志标记; 旧行由去重挡掉, 故整窗重扫零重复)
  const masterRead = readMaster();
  if (masterRead.corrupt) {
    console.error('[保安] 中止: 现有 master.csv 损坏 ->', masterRead.reason);
    console.error('[保安] 未对 master.csv 做任何写入, 请从备份恢复后重试');
    process.exit(2);
  }
  const { existing, lines: masterLines } = masterRead;
  // mtime 守护: 记录本进程"读到的 master"的修改时间。若运行期间 master 被外部改动
  // (典型: 人工恢复 / 另一个延迟进程), 则放弃本次写入, 以免用旧内存覆盖好数据。
  const startMtime = (() => { try { return fs.statSync(MASTER).mtimeMs; } catch (e) { return Date.now(); } })();
  const state = readState();
  let cursor = state.cursorOrderId || null;
  // 首次运行无游标时,用 master 顶部(最新)Order ID 种子化,避免重复全量拉取
  if (!cursor && masterLines.length > 1) {
    try { cursor = parseCSVLine(masterLines[1])[1] || null; } catch (e) {}
  }
  console.log('3) 起始游标(上次最新 Order ID) =', cursor || '(无, 全量拉取)');
  const collected = [];
  let prevFirstKey = null;
  let pages = 0;
  let stuck = false;
  let hitCursor = false;
  // 抓完一页后「等页面真的翻过去」再抓下一页, 见文件头 SETTLE_* 说明
  let lastPageRowCount = 0;
  while (pages < MAX_PAGES) {
    let full = null;
    for (let i = 0; i < 4; i++) { full = await pageExec(tid, path.join(DIR, 'extract_full.js')); if (full && full.status === 'OK' && full.rowCount > 0) break; await sleep(rand(4000, 6000)); }
    if (!full || full.status !== 'OK' || full.rowCount === 0) { console.log('   提取为空或失败, 停止翻页'); break; }
    const fullRows = full.rows || [];
    if (!fullRows.length) { console.log('   全量提取为空, 停止'); break; }
    // 主键用「订单号+ASIN」而不是整行文本: 整行含图片等易变字段, 会误判成"变了"
    const firstKey = (fullRows[0][1] || '') + '|' + (fullRows[0][4] || '');
    if (firstKey === prevFirstKey) { console.log('   首页主键未变化 -> 翻页卡死, 停止'); stuck = true; break; }
    prevFirstKey = firstKey;
    lastPageRowCount = fullRows.length;
    // 命中游标? 当前页出现上次最新 Order ID => 其下方(含)皆为旧数据
    if (cursor) {
      for (const r of fullRows) { if ((r[1] || '') === cursor) { hitCursor = true; break; } }
    }
    collected.push(...fullRows);
    pages++;
    console.log(`   第 ${pages} 页: +${fullRows.length} 行 (累计 ${collected.length})${hitCursor ? ' [经过上次游标]' : ''}`);
    if (pages >= MAX_PAGES) break;
    // 点击下一页, 然后轮询「首行主键真的变了」才继续; 未变则重试点击, 仍不变才判卡死。
    // 2026-09-28 修复(两轮): ① next.js 报 NO_NEXT/DISABLED 不再单次采信(旧逻辑一次判死,
    //   实测第 7 页后误停吞掉第 8/9 页约 2000 行); ② **总页数才是独立裁判** —— 页面慢时
    //   分页器与 Next 按钮会在重渲染期间读不到, 此时 hasUsableNext=false 是假阴性,
    //   不能当"已到末页"的证据。判据改为: 只要已知总页数且 pages < 总页数, 就必须继续推进;
    //   只有「已抓到 >= 总页数」或「分页器可读且明确确认到末页」才允许结束。
    let advanced = false;
    let noNext = false;
    let endConfirmed = 0;      // 可读分页器明确确认「已到末页」的连续次数
    let relaxBudget = 0;       // 无法确认时的额外重试预算(页面慢, 最多放宽 8 次)
    for (let attempt = 1; attempt <= 10 && !advanced; attempt++) {
      const behindKnownEnd = !!(knownTotalPages && pages < knownTotalPages);
      const nx = await pageExec(tid, path.join(DIR, 'next.js'));
      // ⚠️ 桥级瞬态(CDP_ERROR / 桥不可连, pageExec 内部已重试 3 次) 与「没有下一页」是两码事:
      //    桥一抖就把确认数记一笔, 等于桥不稳就静默少数据 —— 方向性错误, 必须分开。
      if (!nx || nx.status === 'CLI_FAIL') {
        console.log('   [settle] next#' + attempt + ' 桥级瞬态(' + ((nx && nx.status) || 'NULL') + '), 退避重试(不计入末页确认)');
        if (relaxBudget++ >= 8) break;
        await sleep(rand(6000, 10000));
        continue;
      }
      if (nx.status === 'OK') {
        const t0s = Date.now();
        while (Date.now() - t0s < SETTLE_PAGE_TIMEOUT_MS) {
          await sleep(POLL_INTERVAL_MS);
          const k = await readPageKey(tid);
          if (k && k.firstKey && k.firstKey !== firstKey) {
            advanced = true;
            console.log('   [settle] 翻页生效于 ~' + Math.round((Date.now() - t0s) / 1000) + 's: first=' + k.firstKey.slice(0, 26) + ' rows=' + k.rowCount);
            break;
          }
        }
        if (advanced) break;
        console.log('   [settle] next#' + attempt + ' 已点击但 ' + (SETTLE_PAGE_TIMEOUT_MS / 1000) + 's 首行未变'
          + (behindKnownEnd ? ' (分页器表明仍有后续页 ' + pages + '/' + knownTotalPages + ', 判瞬态)' : ''));
        if (relaxBudget++ >= 8) break;
        await sleep(rand(6000, 10000));
        continue;
      }
      // NO_NEXT / DISABLED: 需要独立证据才认「整窗扫完」
      const pg = await readPagerState(tid);
      if (behindKnownEnd) {
        console.log('   [settle] next#' + attempt + ' 报 ' + nx.status + ' 但分页器表明仍有后续页(已拉 ' + pages + '/' + knownTotalPages + '), 判瞬态, 退避重试');
        if (relaxBudget++ >= 8) break;
        await sleep(rand(8000, 12000));
        continue;
      }
      const atLastPage = pg && pg.totalPages && pg.activePage && pg.activePage >= pg.totalPages;
      if (atLastPage) {
        console.log('   已至最后一页(' + pg.activePage + '/' + pg.totalPages + '), 正常结束');
        noNext = true;
        break;
      }
      if (!pg) {
        // 分页器读不到 => 状态未知, 不能作为"无下一页"的证据; 已知总页数用尽或未知时放宽重试
        console.log('   [settle] next#' + attempt + ' 报 ' + nx.status + ' 但分页器探针无结果(未知), 退避重试');
        if (relaxBudget++ >= 8) break;
        await sleep(rand(6000, 10000));
        continue;
      }
      endConfirmed++;
      if (endConfirmed >= 3) { noNext = true; break; }
      console.log('   [settle] next#' + attempt + ' 报 ' + nx.status + ' 且分页器无可用下一页(确认 ' + endConfirmed + '/3), 稍后复核');
      if (relaxBudget++ >= 8) break;
      await sleep(rand(6000, 10000));
    }
    if (noNext) { console.log('   无下一页, 停止' + (knownTotalPages ? '(总页数 ' + knownTotalPages + ', 已扫 ' + pages + ')' : '')); break; }
    if (!advanced) {
      console.log('   点 Next 后页面始终未推进 -> 判定翻页卡死(stuck), 本轮已抓 ' + pages + ' 页'
        + (knownTotalPages ? '/共 ' + knownTotalPages + ' 页' : '') + ', 尾部可能未覆盖');
      stuck = true;
      break;
    }
  }
  try { fs.unlinkSync(injFile); } catch (e) {}

  // 4) dedupe vs master (按 订单号+ASIN 去重,一条退货事件只记一次)
  //    日报分片(上传知识库的外发件)会清空 Title 列内容、保留列头; master 台账保留全文。
  console.log(`4) 去重落盘 (Title 列: master 保留原文 / 日报分片${REDACT_TITLE ? '清空内容' : '保留原文'})`);
  const newLines = [];
  const newRowCells = [];                     // 与 newLines 平行, 保留单元格用于日报命名统计
  for (const row of collected) {
    const r13 = row;                          // extract_full 已返回 13 列(结构化取数)
    // 保安检 3: 提取到的每一行必须是 13 列字符串, 否则视为提取异常, 拒绝落盘
    if (!Array.isArray(r13) || r13.length !== HEADER.length) {
      console.error('[保安] 提取行格式异常(列数=' + (r13 && r13.length) + '), 中止写入以免损坏 master');
      process.exit(3);
    }
    const line = r13.map(esc).join(',');
    const k = rowKeyOf(r13);
    if (!existing.has(k)) {
      existing.add(k);
      // master 台账入库时保留 Title 原文; 日报分片(外发件)按 REDACT_TITLE 清空 Title 内容, 列头不变
      const reportCells = r13.slice();
      if (REDACT_TITLE && TITLE_IDX >= 0) reportCells[TITLE_IDX] = '';
      newLines.push(reportCells.map(esc).join(','));
      newRowCells.push(r13.slice());          // 命名统计仍用原始行(取 Refund Date, 不受 Title 脱敏影响)
      masterLines.push(line);
    }
  }
  const content = masterLines.join('\n');
  // 保安检 4: 落盘前最后确认内容不是二进制(xlsx 签名 PK)
  if (/^PK\x03\x04/.test(content) || content.slice(0, 2) === 'PK') {
    console.error('[保安] 待写内容疑似二进制, 中止写入');
    process.exit(4);
  }
  // mtime 守护: 运行期间若 master 被外部改动, 放弃写入(保留外部的好数据)
  try {
    const cur = fs.statSync(MASTER).mtimeMs;
    if (cur > startMtime + 1000) {
      console.error('[守护] master.csv 在运行中已被外部改动(mtime 更新), 放弃本次写入以免覆盖好数据');
      process.exit(5);
    }
  } catch (e) {}
  atomicWrite(MASTER, content);
  // 日报文件名按命名规则动态生成(依赖新增行的退款日分布, 故必须在去重之后构造)
  let dailyReport = null;
  if (newLines.length > 0) {
    dailyReport = uniqueDailyPath(path.join(DIR, buildDailyName(newRowCells)));
    atomicWrite(dailyReport, [HEADER.map(esc).join(',')].concat(newLines).join('\n'));
  }
  // 写后校验, 确保两份文件都合法 13 列
  const okM = verifyCsv(MASTER, HEADER.length);
  const okD = newLines.length > 0 ? verifyCsv(dailyReport, HEADER.length) : true;
  if (!okM || !okD) {
    console.error('[保安] 写后校验未通过, 但文件已写入; 请人工核对 master.csv');
  }
  // 写后: 更新 last-known-good 自愈快照(仅当校验通过, 避免快照自身损坏)
  if (okM) { try { fs.copyFileSync(MASTER, GOOD_BAK); console.log('   [快照] 已更新', path.basename(GOOD_BAK)); } catch (e) {} }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  // 新游标 = 本次抓取的最顶部(最新)Order ID;若本次无数据则沿用旧游标
  const newCursor = (collected.length && collected[0][1]) ? collected[0][1] : cursor;
  writeState({ lastRun: today, cursorOrderId: newCursor, masterCount: masterLines.length - 1, lastRunNewRows: newLines.length });
  console.log('=== DONE ===');
  console.log(JSON.stringify({
    date: today, filter: FILTER, pagesPulled: pages, rowsCollected: collected.length,
    newRows: newLines.length, masterTotal: masterLines.length - 1, stuck, hitCursor,
    cursorPrev: cursor, cursorNew: newCursor, elapsedSec: dt,
    titleRedactedInDailyReport: REDACT_TITLE,
    dailyReport: newLines.length > 0 ? dailyReport : '(无新增, 未生成)'
  }, null, 2));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
