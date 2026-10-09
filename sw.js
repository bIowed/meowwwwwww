/*global UVServiceWorker,__uv$config*/
importScripts('/uv/uv.bundle.js');
importScripts('/uv/uv.config.js');
importScripts(__uv$config.sw || '/uv/uv.sw.js');

const uv = new UVServiceWorker();

self.addEventListener('fetch', (event) => {
    if (uv.route(event)) {
        event.respondWith(uv.fetch(event));
    }
});
