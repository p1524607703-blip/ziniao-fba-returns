'use strict';
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
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => Math.floor(a + Math.random() * (b - a));
function runCli(args, timeout = 60000) {
  return new Promise(resolve => { const cp = spawn(CLI, args, { timeout }); let out = '', err = ''; cp.stdout.on('data', d => out += d); cp.stderr.on('data', d => err += d); cp.on('close', code => resolve({ code, out, err })); cp.on('error', e => resolve({ code: -1, out, err: String(e) })); });
}
function parseExecResult(s) {
  try { const o = JSON.parse(s); const inner = o?.data?.data?.result; if (typeof inner === 'string') { const r = JSON.parse(inner); if (r && r.status) return r; } if (inner && typeof inner === 'object' && inner.status) return inner; if (o?.status) return o; } catch (e) {} return null;
}
async function pageExec(tid, scriptFile, timeout = 55000) {
  const script = fs.readFileSync(scriptFile, 'utf8');
  const r = await runCli(['page', 'exec', '--store-id', STORE_ID, '--target-id', tid, '--script', script, '--timeout', '50000'], timeout);
  if (r.code !== 0) { console.error('page exec failed:', r.err.slice(0, 400)); return null; } return parseExecResult(r.out);
}
function makeInjectScript(val) {
  return `(function(){try{var all=Array.from(document.querySelectorAll('select'));var sel=all.find(function(s){var o=Array.from(s.options).map(function(x){return x.value;}).join(',');return /25|50|100/.test(o);});if(!sel)return JSON.stringify({status:'NO_SELECT'});var opt=document.createElement('option');opt.value=String(${val});opt.text=String(${val});sel.appendChild(opt);sel.value=String(${val});sel.dispatchEvent(new Event('change',{bubbles:true}));return JSON.stringify({status:'OK',setTo:sel.value});}catch(e){return JSON.stringify({status:'ERR',msg:String(e)});}})();`;
}
(async () => {
  console.log('[validate] 打开页面...');
  await runCli(['store', 'open', '--name', STORE_NAME, '--url', URL_], 60000);
  const v = await runCli(['zclaw', 'invoke', 'visit_page', '--args', JSON.stringify({ storeId: STORE_ID, url: URL_ })], 60000);
  let tid = null; try { const o = JSON.parse(v.out); tid = o?.data?.data?.targetId || o?.data?.targetId; } catch (e) {}
  if (!tid) { console.error('no targetId'); process.exit(1); }
  console.log('   targetId =', tid); await sleep(6000);
  console.log('1) 设筛选 LAST_7_DAYS'); let f = null; for (let i = 0; i < 4; i++) { f = await pageExec(tid, path.join(DIR, 'set_filter.js')); if (f && f.status === 'OK') break; await sleep(rand(4000, 6000)); } console.log('   ', JSON.stringify(f)); if (!f || f.status !== 'OK') { console.error('筛选失败'); process.exit(1); } await sleep(rand(9000, 11000));
  console.log('2) 注入 1000'); const injFile = path.join(DIR, '_inject_tmp.js'); fs.writeFileSync(injFile, makeInjectScript(1000)); let inj = null; for (let i = 0; i < 4; i++) { inj = await pageExec(tid, injFile); if (inj && inj.status === 'OK') break; await sleep(rand(4000, 6000)); } console.log('   ', JSON.stringify(inj)); if (!inj || inj.status !== 'OK') { console.error('注入失败'); process.exit(1); } await sleep(rand(9000, 11000));
  console.log('3) 用【新】extract_full.js 提取...');
  let full = null; for (let i = 0; i < 4; i++) { full = await pageExec(tid, path.join(DIR, 'extract_full.js')); if (full && full.status === 'OK' && full.rowCount > 0) break; await sleep(rand(4000, 6000)); }
  try { fs.unlinkSync(injFile); } catch (e) {}
  if (!full || full.status !== 'OK') { console.error('提取失败:', JSON.stringify(full)); process.exit(1); }
  console.log('   rowCount =', full.rowCount, '| 每行列数 =', full.rows[0] ? full.rows[0].length : '?');
  console.log('--- 前 3 行抽查(Order/Title/ASIN/SKU/Reason) ---');
  for (let i = 0; i < Math.min(3, full.rows.length); i++) {
    const r = full.rows[i];
    console.log(`  行${i + 1}: Order=${r[1]} | Title=${r[3].slice(0, 50)} | ASIN=${r[4]} | SKU=${r[5]} | Reason=${r[6]}`);
  }
  // 列数一致性检查
  const bad = full.rows.filter(r => r.length !== 13).length;
  console.log('--- 列数异常行数:', bad, '(应为 0) ---');
  console.log('=== VALIDATE DONE ===');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
