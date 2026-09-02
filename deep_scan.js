'use strict';
// 每周深扫:覆盖每日7天窗口之外的遗漏(任务中断>7天 + 亚马逊回溯补登)。
// 关键防卡断设计:每翻 CHUNK_PAGES(15) 页就"重置"一次(重新应用筛选+重注入1000),
// 刷新 SPA 的 CSRF 令牌与分页状态,使每次客户端会话都 <15 次翻页,永远够不到"21页脱节点"。
// 重置后回到第1页,靠全局去重(订单+ASIN)吸收重翻的页,自然覆盖整个窗口。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// 店铺与 CLI 全部来自配置（config.json 或环境变量），脚本本身不含任何店铺信息
const { requireConfig } = require('./config');
const cfg = requireConfig();
const CLI = cfg.cliPath;
const STORE_ID = cfg.storeId;
const STORE_NAME = cfg.storeName;
const URL_ = cfg.marketplaceUrl;
const DIR = __dirname;
const MASTER = path.join(DIR, 'master.csv');
const HEADER = ['Marketplace', 'Order ID', 'Image', 'Title', 'ASIN', 'Seller SKU', 'Return Reason', 'Authorization Date', 'Refund Date', 'Unit Received Date', 'Disposition', 'Status', 'Action'];
const FILTER = 'LAST_30_DAYS'; // 30天窗口;如需更强回溯补登覆盖可改 LAST_90_DAYS
const PAGE_SIZE = 1000;
const CHUNK_PAGES = 8;    // 每段翻页数;实测1000/页时列表自然末页在第10~11页,取8留安全余量,主动在脱节点前重置
const MAX_CHUNKS = 12;    // 上限:12*15=180页,远超30天(~43页)/90天(~130页)所需
const RESET_WAIT = [11000, 13000]; // 重置后等待渲染(ms 区间)
const PAGE_WAIT = [8000, 10000];    // 每页之间等待(ms 区间)

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => Math.floor(a + Math.random() * (b - a));
const esc = c => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"';
// 提取已在浏览器内由 extract_full.js 完成 DOM 结构化: Title/ASIN/Seller SKU 直接分离,
// Return Reason 仅取原因分类、自动剥离买家留言 "comment" 块。extract_full 直接返回 13 列。
function atomicWrite(p, content) { const tmp = p + '.tmp'; fs.writeFileSync(tmp, content, 'utf8'); fs.renameSync(tmp, p); }
function verifyCsv(p, expectCols) {
  try {
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(l => l.length);
    let bad = 0;
    for (let i = 1; i < lines.length; i++) { if (parseCSVLine(lines[i]).length !== expectCols) bad++; }
    if (bad > 0) console.error('   [校验]', p, '有', bad, '行不是', expectCols, '列!');
    else console.log('   [校验]', path.basename(p), 'OK:', lines.length - 1, '行 x', expectCols, '列');
    return bad === 0;
  } catch (e) { console.error('   [校验] 读取失败:', p, e.message); return false; }
}

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
function rowKeyOf(cells) {
  const orderId = cells[1] || '';
  let asin = '';
  if (cells.length >= 5) asin = cells[4] || '';
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
      var all=Array.from(document.querySelectorAll('select'));
      var sel=all.find(function(s){var o=Array.from(s.options).map(function(x){return x.value;}).join(',');return /25|50|100/.test(o);});
      if(!sel) return JSON.stringify({status:'NO_SELECT'});
      var opt=document.createElement('option');opt.value=String(${val});opt.text=String(${val});
      sel.appendChild(opt);sel.value=String(${val});
      sel.dispatchEvent(new Event('change',{bubbles:true}));
      return JSON.stringify({status:'OK', setTo: sel.value});
    }catch(e){return JSON.stringify({status:'ERR', msg:String(e)});}
  })();`;
}
// 重新应用筛选 + 重注入1000:刷新 SPA 的 CSRF 令牌与分页状态(防脱关键)
async function resetSpa(tid) {
  let ok = false;
  for (let i = 0; i < 4; i++) {
    const f = await pageExec(tid, path.join(DIR, 'set_filter_30.js'));
    if (f && f.status === 'OK') { ok = true; break; }
    await sleep(rand(4000, 6000));
  }
  if (!ok) return false;
  await sleep(rand(9000, 11000));
  const injFile = path.join(DIR, '_inject_tmp.js');
  fs.writeFileSync(injFile, makeInjectScript(PAGE_SIZE));
  let ok2 = false;
  for (let i = 0; i < 4; i++) {
    const inj = await pageExec(tid, injFile);
    if (inj && inj.status === 'OK') { ok2 = true; break; }
    await sleep(rand(4000, 6000));
  }
  try { fs.unlinkSync(injFile); } catch (e) {}
  await sleep(rand(RESET_WAIT[0], RESET_WAIT[1]));
  return ok2;
}

(async () => {
  const t0 = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const report = path.join(DIR, `deepscan_${today}.csv`);
  console.log(`[${today}] ${STORE_NAME} FBA 每周深扫 启动 (窗口=${FILTER}, 分段=${CHUNK_PAGES}页)`);

  await runCli(['store', 'open', '--name', STORE_NAME, '--url', URL_], 60000);
  const v = await runCli(['zclaw', 'invoke', 'visit_page', '--args', JSON.stringify({ storeId: STORE_ID, url: URL_ })], 60000);
  let tid = null;
  try { const o = JSON.parse(v.out); tid = o?.data?.data?.targetId || o?.data?.targetId; } catch (e) {}
  if (!tid) { console.error('no targetId:', v.out.slice(0, 200)); process.exit(1); }
  console.log('   targetId =', tid);
  await sleep(6000);

  if (!(await resetSpa(tid))) { console.error('初始筛选/注入失败'); process.exit(1); }
  console.log('   初始筛选+注入 OK');

  // 全局去重集(跨段):已见过的"订单+ASIN"
  const localSeen = new Set();
  const collected = [];
  let chunk = 0, reachedEnd = false, errored = false, capped = false;
  let totalPages = 0, totalResets = 0;

  while (chunk < MAX_CHUNKS) {
    chunk++;
    let prevFirst = null, pagesInChunk = 0, newThisChunk = 0, pagesSeen = 0, breakDetected = false;
    while (pagesInChunk < CHUNK_PAGES) {
      let full = null;
      for (let i = 0; i < 4; i++) { full = await pageExec(tid, path.join(DIR, 'extract_full.js')); if (full && full.status === 'OK' && full.rowCount > 0) break; await sleep(rand(4000, 6000)); }
      if (!full || full.status !== 'OK' || full.rowCount === 0) { console.log(`   段${chunk} 提取失败/空, 跳出本段`); break; }
      const rows = full.rows || [];
      if (!rows.length) { console.log(`   段${chunk} 空行, 跳出本段`); break; }
      const firstKey = rows[0].join('\u0001');
      // 翻页卡死检测:本段内首页主键未变化 -> SPA 脱节,跳出本段去重置
      if (firstKey === prevFirst) { console.log(`   段${chunk} 检测到翻页卡死(首页主键=${firstKey.slice(0,40)}), 跳出本段准备重置`); breakDetected = true; break; }
      prevFirst = firstKey;
      for (const r of rows) { const k = rowKeyOf(r); if (!localSeen.has(k)) { localSeen.add(k); collected.push(r); newThisChunk++; } }
      pagesSeen++; pagesInChunk++;
      console.log(`   段${chunk} 第${pagesInChunk}页: +${rows.length}行 本段新增${newThisChunk} (累计见${localSeen.size})`);
      if (pagesInChunk >= CHUNK_PAGES) break; // 正常段边界 -> 重置
      const nx = await pageExec(tid, path.join(DIR, 'next.js'));
      if (!nx || nx.status === 'OK') { /* 有下一页, 继续 */ }
      else { console.log('   到达真实末页(Next=' + (nx ? nx.status : 'null') + '), 停止'); reachedEnd = true; break; }
      await sleep(rand(PAGE_WAIT[0], PAGE_WAIT[1]));
    }
    totalPages += pagesSeen;

    if (reachedEnd) { console.log('-> 已到窗口末页, 停止'); break; }
    // 区分"全部重复(窗口耗尽)"与"提取失败"
    if (pagesSeen === 0) { console.error('段内连续提取失败, 中止'); errored = true; break; }
    if (newThisChunk === 0) { console.log('-> 本段无新增(窗口已覆盖完), 停止'); break; }
    // 重置 SPA 继续下一段
    totalResets++;
    console.log(`-> 段${chunk} 结束, 重置 SPA 进入段${chunk + 1} (已重置${totalResets}次)`);
    if (!(await resetSpa(tid))) { console.error('重置失败, 中止'); errored = true; break; }
  }

  // 落盘:与 master 去重合并
  const { existing, lines: masterLines } = readMaster();
  const newLines = [];
  for (const row of collected) {
    const r13 = row;   // extract_full 已返回 13 列(结构化取数)
    const line = r13.map(esc).join(',');
    const k = rowKeyOf(r13);
    if (!existing.has(k)) { existing.add(k); newLines.push(line); masterLines.push(line); }
  }
  atomicWrite(MASTER, masterLines.join('\n'));
  verifyCsv(MASTER, HEADER.length);
  if (newLines.length > 0) {
    atomicWrite(report, [HEADER.map(esc).join(',')].concat(newLines).join('\n'));
    verifyCsv(report, HEADER.length);
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const state = { lastDeepScan: today, window: FILTER, masterCount: masterLines.length - 1, deepScanNewRows: newLines.length, reachedEnd, errored };
  fs.writeFileSync(path.join(DIR, 'deepscan_state.json'), JSON.stringify(state, null, 2), 'utf8');
  console.log('=== DONE ===');
  console.log(JSON.stringify({
    date: today, window: FILTER, chunks: chunk, resets: totalResets, pagesSeen: totalPages,
    rowsCollected: collected.length, newRows: newLines.length, masterTotal: masterLines.length - 1,
    reachedEnd, errored, elapsedSec: dt, report: newLines.length > 0 ? report : '(无新增, 未生成)'
  }, null, 2));

  function readMaster() {
    if (!fs.existsSync(MASTER)) return { existing: new Set(), lines: [HEADER.map(esc).join(',')] };
    const txt = fs.readFileSync(MASTER, 'utf8');
    const lines = txt.split('\n').filter(l => l.length);
    const existing = new Set();
    for (let i = 1; i < lines.length; i++) existing.add(rowKeyOf(parseCSVLine(lines[i])));
    if (lines.length === 0) lines.push(HEADER.map(esc).join(','));
    return { existing, lines };
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
