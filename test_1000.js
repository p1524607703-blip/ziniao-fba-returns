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
const VAL = parseInt(process.argv[2] || '1000', 10);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => Math.floor(a + Math.random() * (b - a));

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
      var sel=all.find(function(s){
        var opts=Array.from(s.options).map(function(o){return o.value;}).join(',');
        return /25|50|100/.test(opts);
      });
      if(!sel) return JSON.stringify({status:'NO_SELECT', selects: all.map(function(s){return {id:s.id,name:s.name,opts:Array.from(s.options).map(function(o){return o.value;})};})});
      var opt=document.createElement('option');
      opt.value=String(${val}); opt.text=String(${val});
      sel.appendChild(opt);
      sel.value=String(${val});
      sel.dispatchEvent(new Event('change',{bubbles:true}));
      return JSON.stringify({status:'OK', setTo: sel.value, selId: sel.id, totalOpts: Array.from(sel.options).map(function(o){return o.value;})});
    }catch(e){ return JSON.stringify({status:'ERR', msg: String(e)}); }
  })();`;
}

(async () => {
  const t0 = Date.now();
  console.log(`== 测试 recordsPerPage=${VAL} ==`);
  console.log('1) open store browser');
  await runCli(['store', 'open', '--name', STORE_NAME, '--url', URL_], 60000);
  console.log('2) navigate -> targetId');
  const v = await runCli(['zclaw', 'invoke', 'visit_page', '--args', JSON.stringify({ storeId: STORE_ID, url: URL_ })], 60000);
  let tid = null;
  try { const o = JSON.parse(v.out); tid = o?.data?.data?.targetId || o?.data?.targetId; } catch (e) {}
  if (!tid) { console.error('no targetId:', v.out.slice(0, 200)); process.exit(1); }
  console.log('   targetId =', tid);
  await sleep(6000);

  const injFile = path.join(DIR, `_inject_tmp.js`);
  fs.writeFileSync(injFile, makeInjectScript(VAL));
  console.log(`3) inject recordsPerPage=${VAL}`);
  let inj = null;
  for (let i = 0; i < 4; i++) {
    inj = await pageExec(tid, injFile);
    if (inj && inj.status === 'OK') break;
    console.log(`   inject retry ${i+1}`, JSON.stringify(inj));
    await sleep(rand(4000, 6000));
  }
  console.log('   inject result:', JSON.stringify(inj));
  if (!inj || inj.status !== 'OK') { console.error('inject failed'); process.exit(1); }
  await sleep(rand(9000, 11000));

  console.log('4) extract rendered row count');
  let ext = null;
  for (let i = 0; i < 4; i++) {
    ext = await pageExec(tid, path.join(DIR, 'extract.js'));
    if (ext && ext.status === 'OK' && ext.rowCount > 0) break;
    console.log(`   extract retry ${i+1} (rowCount=${ext?.rowCount})`);
    await sleep(rand(4000, 6000));
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('=== RESULT ===');
  console.log(JSON.stringify({ requested: VAL, setTo: inj.setTo, renderedRows: ext?.rowCount, sample: ext?.sample, elapsedSec: dt }, null, 2));
  try { fs.unlinkSync(injFile); } catch (e) {}
})().catch(e => { console.error('FATAL', e); process.exit(1); });
