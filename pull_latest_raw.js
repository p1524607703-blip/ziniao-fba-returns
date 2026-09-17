'use strict';
/**
 * pull_latest_raw.js — 一次性「最近 N 条原始快照」抓取（不去重）
 *
 * 用途：用户要求「抓取最近的 4000 条，不要去重，完整给我」时的临时取数。
 * 与 daily_pull.js 的区别：
 *   - 完全不读 master.csv、不读/写 daily_state.json（不动增量管线）
 *   - 不做任何去重，页面抓到什么就原样落什么
 *   - 不命中游标即停；从列表顶部（最新）往下翻，抓到目标条数为止
 *   - 输出独立文件，不影响 master / 日报
 *
 * 抓取顺序：列表默认按退款日倒序，顶部=最新，翻到目标条数即停，天然取「最近 N 条」。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const { requireConfig } = require('./config');
const { ensureStore } = require('./store_guard');
const cfg = requireConfig();
const CLI = cfg.cliPath;
const STORE_ID = cfg.storeId;
const STORE_NAME = cfg.storeName;
const URL_ = cfg.marketplaceUrl;
const DIR = __dirname;

const TARGET = Number(process.env.RAW_TARGET || 4000);   // 目标条数
const PAGE_SIZE = 1000;
const MAX_PAGES = Math.ceil(TARGET / PAGE_SIZE) + 2;     // 留 2 页余量
const FILTER = 'LAST_7_DAYS';

const HEADER = ['Marketplace', 'Order ID', 'Image', 'Title', 'ASIN', 'Seller SKU', 'Return Reason', 'Authorization Date', 'Refund Date', 'Unit Received Date', 'Disposition', 'Status', 'Action'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => Math.floor(a + Math.random() * (b - a));
const esc = c => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"';

function atomicWrite(p, content) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, p);
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

(async () => {
  const t0 = Date.now();
  const stamp = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); // 北京时间
  console.log(`[${stamp}] ${STORE_NAME} 原始快照抓取（不去重） 启动 目标=${TARGET} 条`);

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
  await sleep(8000);

  // 1) LAST_7_DAYS
  console.log('1) 设置筛选 =', FILTER);
  let f = null;
  for (let i = 0; i < 5; i++) { f = await pageExec(tid, path.join(DIR, 'set_filter.js')); if (f && f.status === 'OK') break; await sleep(rand(4000, 6000)); }
  console.log('   ', JSON.stringify(f));
  if (!f || f.status !== 'OK') { console.error('设置筛选失败'); process.exit(1); }
  await sleep(rand(10000, 13000));

  // 2) 注入 recordsPerPage = 1000
  console.log('2) 注入 recordsPerPage =', PAGE_SIZE);
  const injFile = path.join(DIR, '_inject_raw_tmp.js');
  fs.writeFileSync(injFile, makeInjectScript(PAGE_SIZE));
  let inj = null;
  for (let i = 0; i < 6; i++) { inj = await pageExec(tid, injFile); if (inj && inj.status === 'OK') break; await sleep(rand(5000, 7000)); }
  console.log('   ', JSON.stringify(inj));
  if (!inj || inj.status !== 'OK') { console.error('注入失败'); process.exit(1); }
  await sleep(rand(12000, 15000));

  // 3) 逐页抓取（不去重）
  const collected = [];
  let prevSig = null;
  let pages = 0;
  let stuck = false;
  let reachedEnd = false;
  while (pages < MAX_PAGES) {
    let full = null;
    // 每页多试几次，避免表格未渲染完就抓到残缺结果
    for (let i = 0; i < 5; i++) {
      full = await pageExec(tid, path.join(DIR, 'extract_full.js'));
      if (full && full.status === 'OK' && full.rowCount > 0) break;
      await sleep(rand(4000, 6000));
    }
    if (!full || full.status !== 'OK' || !full.rowCount) { console.log('   提取为空或失败, 停止'); reachedEnd = true; break; }
    const rows = full.rows || [];
    if (!rows.length) { console.log('   全量提取为空, 停止'); reachedEnd = true; break; }

    // 卡死判定：整页签名（首行+行数+末行）与上一页完全相同
    const sig = rows.length + '|' + rows[0].join('\u0001') + '|' + rows[rows.length - 1].join('\u0001');
    if (sig === prevSig) { console.log('   本页内容与上一页完全相同 -> 翻页卡死, 停止'); stuck = true; break; }
    prevSig = sig;

    collected.push(...rows);
    pages++;
    console.log(`   第 ${pages} 页: +${rows.length} 行 (累计 ${collected.length})`);
    if (collected.length >= TARGET) { console.log('   -> 已达目标条数, 停止翻页'); break; }
    if (rows.length < PAGE_SIZE) { console.log('   -> 本页不足 ' + PAGE_SIZE + ' 行, 视为最后一页'); reachedEnd = true; break; }

    const nx = await pageExec(tid, path.join(DIR, 'next.js'));
    if (!nx || nx.status !== 'OK') { console.log('   无下一页, 停止:', JSON.stringify(nx)); reachedEnd = true; break; }
    console.log('   -> 翻页:', JSON.stringify(nx));
    await sleep(rand(9000, 12000));
  }
  try { fs.unlinkSync(injFile); } catch (e) {}

  // 4) 原样落盘（不去重），截到目标条数
  const finalRows = collected.slice(0, TARGET);
  const outFile = path.join(DIR, `最近${TARGET}条_原始不去重_${stamp}.csv`);
  const content = [HEADER.map(esc).join(',')].concat(finalRows.map(r => r.map(esc).join(','))).join('\n');
  if (!finalRows.length) {
    console.error('!!! 未抓到任何数据, 不生成文件');
    process.exit(1);
  }
  atomicWrite(outFile, content);

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('=== DONE ===');
  console.log(JSON.stringify({
    date: stamp, filter: FILTER, target: TARGET,
    pagesPulled: pages, rowsCollected: collected.length, rowsWritten: finalRows.length,
    stuck, reachedEnd, elapsedSec: dt, output: outFile
  }, null, 2));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
