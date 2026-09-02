(function(){
  try{
    var table = document.querySelector('table');
    if(!table) return JSON.stringify({status:'NO_TABLE'});
    var trs = Array.from(table.querySelectorAll('tbody tr'));
    var rows = trs.filter(function(r){ return r.querySelectorAll('td').length >= 5; });
    function clean(s){ return (s||'').replace(/\s+/g,' ').trim(); }
    // 从 Product 单元格结构化提取 Title / ASIN / Seller SKU。
    // 亚马逊新 UI: mt-combination 内含多个块, 标题在 .mt-table-main, ASIN/SKU 在 .mt-table-detail。
    // 此写法不依赖 "B0" 前缀, 图书 ISBN-10 等非 B0 的 ASIN 也能精准取到。
    function extractProduct(td){
      var main = td.querySelectorAll('.mt-text-content.mt-table-main');
      var detail = td.querySelectorAll('.mt-text-content.mt-table-detail');
      var title = main.length ? clean(main[0].innerText) : '';
      var asin  = detail.length>0 ? clean(detail[0].innerText) : '';
      var sku   = detail.length>1 ? clean(detail[1].innerText) : '';
      if(title && asin) return {title:title, asin:asin, sku:sku};
      // 兜底: 合并文本按 B0 切(兼容旧布局 / 非结构化回退)
      var txt = clean(td.innerText);
      var m = txt.match(/\bB0[A-Z0-9]{8}\b/);
      if(m){
        var i = txt.indexOf(m[0]);
        return {title: txt.slice(0,i).trim(), asin: m[0], sku: txt.slice(i+m[0].length).trim()};
      }
      return {title: txt, asin:'', sku:''};
    }
    // Return Reason: 仅取第一个 .mt-table-main(原因分类), 忽略买家留言等附加块(即页面上的 "comment" 图标文本)。
    function extractReason(td){
      var main = td.querySelectorAll('.mt-text-content.mt-table-main');
      if(main.length) return clean(main[0].innerText);
      return clean(td.innerText);
    }
    var data = rows.map(function(r){
      var tds = Array.from(r.querySelectorAll('td'));
      var p = extractProduct(tds[3]);
      return [
        clean(tds[0].innerText),   // Marketplace
        clean(tds[1].innerText),   // Order ID
        clean(tds[2].innerText),   // Image
        p.title,                   // Title
        p.asin,                    // ASIN (结构化, 非 B0 也能取)
        p.sku,                     // Seller SKU
        extractReason(tds[4]),     // Return Reason (已剥离 comment)
        clean(tds[5].innerText),   // Authorization Date
        clean(tds[6].innerText),   // Refund Date
        clean(tds[7].innerText),   // Unit Received Date
        clean(tds[8].innerText),   // Disposition
        clean(tds[9].innerText),   // Status
        clean(tds[10].innerText)   // Action
      ];
    });
    return JSON.stringify({status:'OK', rowCount: data.length, rows: data});
  }catch(e){ return JSON.stringify({status:'ERR', msg: String(e)}); }
})();
