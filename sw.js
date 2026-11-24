/* Cache solamente l'interfaccia offline. Gli appuntamenti richiedono Supabase. */
const CACHE = 'orbis-lite-shell-v5';
const ASSETS = ['./','./index.html','./styles.css','./app.js','./recurrence.js','./config.js','./manifest.webmanifest','./icon.svg','./apple-touch-icon.png','./icons/icon-192-v3.png','./icons/icon-512-v3.png','./icons/icon-maskable-512-v3.png','./icons/apple-touch-icon-167.png','./icons/apple-touch-icon-152.png','./icons/favicon-32-v3.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(Promise.all([
  self.clients.claim(),
  caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
])));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin)return;
  event.respondWith(fetch(event.request).catch(async()=>{
    const stored=await caches.match(event.request,{ignoreSearch:true});
    if(stored)return stored;
    if(event.request.mode==='navigate')return caches.match('./index.html');
    return Response.error();
  }));
});
