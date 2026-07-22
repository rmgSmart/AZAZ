const CACHE='zeit-v2';
const ASSETS=['./','./index.html','./app.js','./manifest.json'];
self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).catch(()=>{}));
  self.skipWaiting();
});
self.addEventListener('activate',e=>{ e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch',e=>{
  const url=e.request.url;
  // CDN-Skripte immer aus Netz (mit Cache-Fallback)
  e.respondWith(
    caches.match(e.request).then(hit=> hit || fetch(e.request).then(res=>{
      if(e.request.method==='GET' && url.startsWith(self.location.origin)){
        const clone=res.clone(); caches.open(CACHE).then(c=>c.put(e.request,clone));
      }
      return res;
    }).catch(()=>caches.match('./index.html')))
  );
});
