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
const STATE = path.join(DIR, 'daily_state.json');

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
async function pageExec(tid, scriptFile, timeout = 55000) {
  const script = fs.readFileSync(scriptFile, 'utf8');
  const r = await runCli(['page', 'exec', '--store-id', STORE_ID, '--target-id', tid, '--script', script, '--timeout', '50000'], timeout);
  if (r.code !== 0) { console.error('page exec failed:', r.err.slice(0, 300)); return null; }
  return parseExecResult(r.out);
}
function makeInjectScript(val) {
  return `(function(){
    try{
      function find(){return Array.from(document.querySelectorAll('select')).find(function(s){var o=Array.from(s.options).map(function(x){return x.value;}).join(',');return /25|50|100/.test(o);});}
      var sel=null, tries=0;
      while(tries<25 && !(sel=find())){ tries++; }
      if(!sel) return JSON.stringify({status:'NO_SELECT'});
      var opt=document.createElement('option');opt.value=String(${val});opt.text=String(${val});
      sel.appendChild(opt);sel.value=String(${val});
      sel.dispatchEvent(new Event('change',{bubbles:true}));
      return JSON.stringify({status:'OK', setTo: sel.value});
    }catch(e){return JSON.stringify({status:'ERR', msg:String(e)});}
  })();`;
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

  // 2) inject 1000
  console.log('2) 注入 recordsPerPage =', PAGE_SIZE);
  const injFile = path.join(DIR, '_inject_tmp.js');
  fs.writeFileSync(injFile, makeInjectScript(PAGE_SIZE));
  let inj = null;
  for (let i = 0; i < 6; i++) { inj = await pageExec(tid, injFile); if (inj && inj.status === 'OK') break; await sleep(rand(5000, 7000)); }
  console.log('   ', JSON.stringify(inj));
  if (!inj || inj.status !== 'OK') { console.error('注入失败'); process.exit(1); }
  await sleep(rand(9000, 11000));

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
  while (pages < MAX_PAGES) {
    let full = null;
    for (let i = 0; i < 4; i++) { full = await pageExec(tid, path.join(DIR, 'extract_full.js')); if (full && full.status === 'OK' && full.rowCount > 0) break; await sleep(rand(4000, 6000)); }
    if (!full || full.status !== 'OK' || full.rowCount === 0) { console.log('   提取为空或失败, 停止翻页'); break; }
    const fullRows = full.rows || [];
    if (!fullRows.length) { console.log('   全量提取为空, 停止'); break; }
    const firstKey = fullRows[0].join('\u0001');
    if (firstKey === prevFirstKey) { console.log('   首页主键未变化 -> 翻页卡死, 停止'); stuck = true; break; }
    prevFirstKey = firstKey;
    // 命中游标? 当前页出现上次最新 Order ID => 其下方(含)皆为旧数据
    if (cursor) {
      for (const r of fullRows) { if ((r[1] || '') === cursor) { hitCursor = true; break; } }
    }
    collected.push(...fullRows);
    pages++;
    console.log(`   第 ${pages} 页: +${fullRows.length} 行 (累计 ${collected.length})${hitCursor ? ' [经过上次游标]' : ''}`);
    if (pages >= MAX_PAGES) break;
    // click next
    const nx = await pageExec(tid, path.join(DIR, 'next.js'));
    if (!nx || nx.status !== 'OK') { console.log('   无下一页, 停止'); break; }
    await sleep(rand(8000, 10000));
  }
  try { fs.unlinkSync(injFile); } catch (e) {}

  // 4) dedupe vs master (按 订单号+ASIN 去重,一条退货事件只记一次)
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
    if (!existing.has(k)) { existing.add(k); newLines.push(line); newRowCells.push(r13.slice()); masterLines.push(line); }
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
    dailyReport: newLines.length > 0 ? dailyReport : '(无新增, 未生成)'
  }, null, 2));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
