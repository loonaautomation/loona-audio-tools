const CACHE='loona-audio-tools-v2';
const PREFIX='loona-audio-tools-';
const CORE=['./','./index.html','./manifest.webmanifest','./icon-192.png','./apple-touch-icon.png'];
self.addEventListener('install',function(e){{e.waitUntil(caches.open(CACHE).then(function(c){{return Promise.all(CORE.map(function(u){{return c.add(u).catch(function(){{}});}}));}}).then(function(){{return self.skipWaiting();}}));}});
self.addEventListener('activate',function(e){{e.waitUntil(caches.keys().then(function(keys){{return Promise.all(keys.filter(function(k){{return k.indexOf(PREFIX)===0&&k!==CACHE;}}).map(function(k){{return caches.delete(k);}}));}}).then(function(){{return self.clients.claim();}}));}});
self.addEventListener('fetch',function(e){{
  var req=e.request;
  if(req.method!=='GET')return;
  var url;
  try{{url=new URL(req.url);}}catch(_ ){{return;}}
  if(url.origin!==self.location.origin)return;
  if(req.mode==='navigate'||req.destination==='document'){{
    e.respondWith(caches.match(req).then(function(hit){{
      var net=fetch(req).then(function(res){{if(res&&res.status===200){{var copy=res.clone();caches.open(CACHE).then(function(c){{var p=c.put(req,copy);if(p&&p.catch)p.catch(function(){{}});}});}}return res;}}).catch(function(){{return hit||caches.match('./');}});
      if(hit){{try{{e.waitUntil(net);}}catch(_ ){{}}return hit;}}
      return net;
    }}));
    return;
  }}
  e.respondWith(caches.match(req).then(function(hit){{
    var net=fetch(req).then(function(res){{if(res&&res.status===200){{var copy=res.clone();caches.open(CACHE).then(function(c){{var p=c.put(req,copy);if(p&&p.catch)p.catch(function(){{}});}});}}return res;}}).catch(function(){{return hit;}});
    return hit||net;
  }}));
}});
