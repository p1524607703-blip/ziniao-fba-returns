(function(){
  try{
    var radios = Array.from(document.querySelectorAll('input[type=radio]'));
    var r = radios.find(function(x){ return x.value === 'LAST_30_DAYS'; });
    if(!r) return JSON.stringify({status:'NO_RADIO', sample: radios.slice(0,40).map(function(x){return (x.name||'')+'='+x.value;})});
    r.checked = true;
    r.dispatchEvent(new Event('click',{bubbles:true}));
    r.dispatchEvent(new Event('change',{bubbles:true}));
    return JSON.stringify({status:'OK', setTo: r.value, name: r.name});
  }catch(e){ return JSON.stringify({status:'ERR', msg:String(e)}); }
})();
