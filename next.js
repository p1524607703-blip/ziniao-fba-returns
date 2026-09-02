(function(){
  try{
    var btns = Array.from(document.querySelectorAll('button, a'));
    var next = btns.find(function(b){
      var t = (b.innerText||b.getAttribute('aria-label')||b.title||'').trim().toLowerCase();
      return /next|next page|›|»|>/i.test(t) && b.offsetParent !== null;
    });
    if(!next) return JSON.stringify({status:'NO_NEXT'});
    if(next.disabled || /disabled/.test(next.className||'')) return JSON.stringify({status:'DISABLED'});
    next.click();
    return JSON.stringify({status:'OK', clicked: (next.innerText||'').trim().slice(0,20)});
  }catch(e){ return JSON.stringify({status:'ERR', msg:String(e)}); }
})();
