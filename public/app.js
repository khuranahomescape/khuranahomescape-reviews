(function(){
  function esc(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  var list=document.getElementById('list');
  fetch('/api/reviews').then(function(r){return r.json()}).then(function(d){
    if(!d.reviews||!d.reviews.length){
      list.innerHTML='<p class="empty">No reviews have been published yet. If you have dealt with Khurana Homescape, please share your experience below. Reviews appear here only after moderation.</p>';return;}
    list.innerHTML=d.reviews.map(function(r){
      var meta=[esc(r.name||'Anonymous')];
      if(r.area)meta.push(esc(r.area));
      if(r.year)meta.push(esc(r.year));
      if(r.rating)meta.push('Rated '+esc(r.rating)+'/5 by the author');
      meta.push(esc(r.date));
      var med=(r.media||[]).map(function(m){var u='/media/'+encodeURIComponent(r.id)+'/'+m.n;return m.type.indexOf('video')===0?'<video src="'+u+'" controls preload="metadata" style="max-width:100%;margin-top:10px"></video>':'<img src="'+u+'" loading="lazy" alt="Photo shared by the reviewer" style="max-width:100%;margin-top:10px">'}).join('');
      return '<div class="card"><div class="meta">'+meta.join(' &middot; ')+'</div><div>'+esc(r.text).replace(/\n/g,'<br>')+'</div>'+med+'<div class="meta" style="margin-top:8px">Personal experience and opinion of the author.</div></div>';
    }).join('');
  }).catch(function(){list.innerHTML='<p class="empty">Reviews could not be loaded right now.</p>'});

  var f=document.getElementById('f'),msg=document.getElementById('msg'),btn=document.getElementById('btn');
  f.addEventListener('submit',function(e){
    e.preventDefault();
    var v=function(id){return document.getElementById(id).value.trim()};
    if(!document.getElementById('ok').checked){msg.textContent='Please tick the confirmation box.';return}
    if(v('text').length<30){msg.textContent='Please write a little more (at least 30 characters).';return}
    var files=document.getElementById('media').files;
    if(files.length>4){msg.textContent='Please attach at most 4 files.';return}
    for(var k=0;k<files.length;k++){var big=files[k].type.indexOf('video')===0?20:5;if(files[k].size>big*1048576){msg.textContent='"'+files[k].name+'" is too large (images 5 MB, videos 20 MB max).';return}}
    btn.disabled=true;msg.textContent=files.length?'Uploading, please wait...':'Submitting...';
    var fd=new FormData();
    ['name','area','year','rating','text','contact','website'].forEach(function(k){fd.append(k,v(k))});
    fd.append('ok','true');
    for(var q=0;q<files.length;q++)fd.append('media',files[q]);
    fetch('/api/submit',{method:'POST',body:fd}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j}})}).then(function(x){
      if(x.ok){f.reset();msg.textContent='Thank you. Your experience has been received and will appear after a moderator reviews it.';btn.disabled=false}
      else{msg.textContent=x.j.error||'Something went wrong. Please try again.';btn.disabled=false}
    }).catch(function(){msg.textContent='Network problem. Please try again.';btn.disabled=false});
  });
})();
