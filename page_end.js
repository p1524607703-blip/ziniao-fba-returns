(function(){
  try{
    var btns = Array.from(document.querySelectorAll('button,a')).filter(function(b){ return b.offsetParent !== null; });
    var next = btns.find(function(b){
      var tx = (b.innerText || b.getAttribute('aria-label') || b.title || '').trim();
      return /^next$|^next page$|next page|›|»/i.test(tx);
    });
    var nextState = 'MISSING';
    if (next) {
      var cls = (next.className || '').toString();
      var dis = !!next.disabled || /disabled|is-disabled/i.test(cls) || next.getAttribute('aria-disabled') === 'true';
      nextState = dis ? 'DISABLED' : 'USABLE';
    }
    var cand = Array.from(document.querySelectorAll('div,section,nav,footer,span')).filter(function(e){
      var tx = e.innerText || '';
      return /Next|Prev/.test(tx) && tx.length < 600;
    });
    cand.sort(function(a,b){ return (a.innerText||'').length - (b.innerText||'').length; });
    var pagerText = cand.length ? cand[0].innerText.replace(/\s+/g,' ').trim().slice(0,300) : null;
    var nums = pagerText ? (pagerText.match(/\d+/g) || []).map(Number) : [];
    var totalPages = nums.length ? Math.max.apply(null, nums) : null;
    var active = Array.from(document.querySelectorAll('[aria-current="page"]')).filter(function(e){
      return /^\d+$/.test((e.innerText||'').trim());
    }).map(function(e){ return Number(e.innerText.trim()); });
    var activePage = active.length ? active[0] : null;
    var t = document.querySelector('table');
    var rowCount = t ? Array.from(t.querySelectorAll('tbody tr')).filter(function(r){ return r.querySelectorAll('td').length >= 5; }).length : 0;
    var hasUsableNext = (nextState === 'USABLE') ||
      (totalPages != null && activePage != null && totalPages > activePage);
    return JSON.stringify({ status:'OK', nextState: nextState, hasUsableNext: !!hasUsableNext,
      pagerText: pagerText, totalPages: totalPages, activePage: activePage, rowCount: rowCount });
  }catch(e){ return JSON.stringify({ status:'ERR', msg:String(e) }); }
})();
