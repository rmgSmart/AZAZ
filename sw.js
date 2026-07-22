const CACHE='zeit-v11';
const ASSETS=['./','./index.html','./manifest.json'];
self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).catch(()=>{}));
  self.skipWaiting();
});
self.addEventListener('activate',e=>{
  e.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET') return;
  const url=e.request.url;
  const sameOrigin = url.startsWith(self.location.origin);
  // Eigene App-Dateien: immer zuerst aus dem Netz holen, damit Updates sofort ankommen.
  // Nur wenn offline/kein Netz -> aus dem Cache bedienen.
  e.respondWith(
    fetch(e.request).then(res=>{
      if(sameOrigin){
        const clone=res.clone();
        caches.open(CACHE).then(c=>c.put(e.request,clone));
      }
      return res;
    }).catch(()=> caches.match(e.request).then(hit=> hit || caches.match('./index.html')))
  );
});
