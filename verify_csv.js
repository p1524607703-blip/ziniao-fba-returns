'use strict';
// 校验 master.csv / daily_*.csv 的列数与字段拆分质量
const fs = require('fs');
const path = require('path');
const DIR = __dirname;

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

function check(file) {
  const full = path.join(DIR, file);
  if (!fs.existsSync(full)) { console.log(`[缺失] ${file}`); return; }
  const txt = fs.readFileSync(full, 'utf8');
  const lines = txt.split('\n').filter(l => l.length);
  const counts = {};
  let noAsin = 0, noSku = 0;
  for (const l of lines) {
    const c = parseCSVLine(l);
    counts[c.length] = (counts[c.length] || 0) + 1;
    if (c.length >= 6) { if (!c[4]) noAsin++; if (!c[5]) noSku++; }
  }
  const header = parseCSVLine(lines[0]);
  console.log(`\n=== ${file} ===`);
  console.log('  行数(含表头) =', lines.length, ' 数据行 =', lines.length - 1);
  console.log('  列数分布 =', JSON.stringify(counts), '(应全部为 13)');
  console.log('  表头 =', JSON.stringify(header));
  console.log('  缺 ASIN 的行 =', noAsin, ' | 缺 SKU 的行 =', noSku);
  if (lines.length > 1) {
    const r = parseCSVLine(lines[1]);
    console.log('  首行样例:');
    console.log('    Marketplace =', r[0], '| Order =', r[1]);
    console.log('    Title  =', r[3]);
    console.log('    ASIN   =', r[4]);
    console.log('    SKU    =', r[5]);
    console.log('    Refund =', r[7], '| Status =', r[11]);
  }
}

check('master.csv');
const daily = fs.readdirSync(DIR).filter(f => /^daily_\d{4}-\d{2}-\d{2}\.csv$/.test(f)).sort();
if (daily.length) check(daily[daily.length - 1]);
