/* Stand-in for Claude's live room, used when the game is hosted outside Claude. Talks to server.js. */
(function(){
if(window.claude&&window.claude.use)return;
window.__BZ_STANDALONE=true;
var teacherLink=/[?&]teacher(=|&|$)/.test(location.search);
function wsUrl(){
  if(window.BZ_WS)return window.BZ_WS;
  return (location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws';
}
function Room(name){
  var self=this;
  name=String(name||'').toLowerCase().replace(/^bz-/,'').replace(/[^a-z0-9]/g,'').slice(0,12);
  self.isAdmin=false;self.round='';self.bank=null;self.store=false;var lastBank=null;
  var sock=null,open=false,dead=false,backoff=800,lastPres=null,pinSent='';
  var peers={};            // id -> presence
  var peerCbs=[],connCbs=[],topicCbs={};
  var myId=null,firstJoin,firstFail,retryT=null;
  function pin(){try{var c=document.getElementById('isteacher'),p=document.getElementById('tpin');return (c&&c.checked&&p)?String(p.value||'').slice(0,40):'';}catch(e){return '';}}
  function fireConn(ok){connCbs.slice().forEach(function(f){try{f(ok);}catch(e){}});}
  function firePeers(joined,left){
    var list=[];
    for(var id in peers)list.push({peer:id,isMe:false,sameTab:false,by:null,kind:'viewer',guest:false,presence:peers[id]});
    var j=joined.map(function(id){return {peer:id,isMe:false,sameTab:false,by:null,kind:'viewer',guest:false,presence:peers[id]};});
    var l=left.map(function(id){return {peer:id,isMe:false,sameTab:false,by:null,kind:'viewer',guest:false,presence:{}};});
    peerCbs.slice().forEach(function(f){try{f({peers:list,joined:j,left:l});}catch(e){}});
  }
  function connect(){
    if(dead)return;
    var s;
    try{s=new WebSocket(wsUrl());}catch(e){fail(e);return;}
    sock=s;
    s.onopen=function(){pinSent=pin();s.send(JSON.stringify({t:'join',room:name,pin:pinSent}));};
    s.onmessage=function(ev){
      var m;try{m=JSON.parse(ev.data);}catch(e){return;}
      if(m.t==='welcome'){
        myId=m.id;self.isAdmin=!!m.admin;self.round=m.round||'';self.bank=m.bank||null;self.store=!!m.store;open=true;backoff=800;
        if(firstJoin){var f=firstJoin;firstJoin=null;firstFail=null;f(self);}
        fireConn(true);
        if(lastPres)s.send(JSON.stringify({t:'pres',d:lastPres}));
        if(self.isAdmin&&lastBank)s.send(JSON.stringify({t:'bank',b:lastBank}));
      }else if(m.t==='full'){
        peers={};var j=[];
        (m.u||[]).forEach(function(p){peers[p[0]]=p[1];j.push(p[0]);});
        firePeers(j,[]);
      }else if(m.t==='d'){
        var j2=[],l2=[];
        (m.u||[]).forEach(function(p){if(p[0]===myId)return;if(!(p[0] in peers))j2.push(p[0]);peers[p[0]]=p[1];});
        (m.l||[]).forEach(function(id){if(id in peers){delete peers[id];l2.push(id);}});
        if((m.u&&m.u.length)||l2.length)firePeers(j2,l2);
      }else if(m.t==='ev'){
        (topicCbs[m.topic]||[]).slice().forEach(function(f){try{f({topic:m.topic,data:m.data,peer:m.from||'',isMe:m.from===myId,sameTab:m.from===myId,by:null,kind:'viewer',guest:false});}catch(e){}});
      }else if(m.t==='bank'){
        self.bank=m.b||null;
        (topicCbs.bank||[]).slice().forEach(function(f){try{f({topic:'bank',data:{b:m.b},peer:'',isMe:false,sameTab:false,by:null,kind:'viewer',guest:false});}catch(e){}});
      }else if(m.t==='bankok'){
        self.store=!!m.store;
        (topicCbs.banksaved||[]).slice().forEach(function(f){try{f({topic:'banksaved',data:{ok:!!m.ok,store:!!m.store}});}catch(e){}});
      }else if(m.t==='err'){
        if(m.c==='bad_room'||m.c==='room_full'||m.c==='server_full'){if(firstFail){var g=firstFail;firstJoin=null;firstFail=null;dead=true;try{s.close();}catch(e){}g(new Error(m.c));}}
      }
    };
    s.onclose=function(){
      var was=open;open=false;peers={};
      if(was){fireConn(false);firePeers([],[]);}
      if(firstFail){var g=firstFail;firstJoin=null;firstFail=null;dead=true;g(new Error('connect_failed'));return;}
      if(dead)return;
      retryT=setTimeout(connect,backoff);backoff=Math.min(8000,backoff*1.7);
    };
    s.onerror=function(){};
  }
  function fail(e){if(firstFail){var g=firstFail;firstJoin=null;firstFail=null;dead=true;g(e);}}
  self._start=function(){
    return new Promise(function(res,rej){
      firstJoin=res;firstFail=rej;
      setTimeout(function(){if(firstFail){var g=firstFail;firstJoin=null;firstFail=null;dead=true;try{sock&&sock.close();}catch(e){}g(new Error('timeout'));}},9000);
      connect();
    });
  };
  self.onConnection=function(cb){connCbs.push(cb);try{cb(open);}catch(e){}return function(){connCbs=connCbs.filter(function(x){return x!==cb;});};};
  self.connected=function(){return open;};
  self.onPeers=function(cb,err){peerCbs.push(cb);return function(){peerCbs=peerCbs.filter(function(x){return x!==cb;});};};
  self.on=function(topic,cb){(topicCbs[topic]=topicCbs[topic]||[]).push(cb);return function(){topicCbs[topic]=(topicCbs[topic]||[]).filter(function(x){return x!==cb;});};};
  self.emit=function(topic,data){
    if(!self.isAdmin)return Promise.reject({code:'not_permitted',message:'Only the teacher can send this.'});
    if(open)try{sock.send(JSON.stringify({t:'ev',topic:topic,data:data}));}catch(e){}
    return Promise.resolve();
  };
  self.publishBank=function(b){lastBank=b;if(open&&self.isAdmin){try{sock.send(JSON.stringify({t:'bank',b:b}));}catch(e){}}};
  self.presence=function(o){
    lastPres=o;
    if(open)try{sock.send(JSON.stringify({t:'pres',d:o}));}catch(e){}
    return Promise.resolve();
  };
  self.leave=function(){dead=true;clearTimeout(retryT);try{sock&&sock.close();}catch(e){}};
}
window.claude={use:function(name){
  if(name==='user')return Promise.resolve({canEdit:function(){return Promise.resolve(teacherLink);}});
  if(name==='room')return Promise.resolve({join:function(n){var r=new Room(n);return r._start();}});
  return Promise.resolve(null);
}};
})();
