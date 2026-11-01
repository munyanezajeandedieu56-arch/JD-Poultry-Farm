const CACHE_NAME = "jd-poultry-v1";

const STATIC_FILES = [
    "/style.css",
    "/script.js"
];

self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(STATIC_FILES))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys
                    .filter(key => key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            )
        ).then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", event => {
    const request = event.request;
    const url = new URL(request.url);

    if (
        request.method !== "GET" ||
        url.origin !== self.location.origin ||
        url.pathname.startsWith("/api/") ||
        url.pathname.includes("admin") ||
        url.pathname.includes("login") ||
        url.pathname.includes("order")
    ) {
        return;
    }

    if (request.mode === "navigate") {
        event.respondWith(
            fetch(request).catch(() =>
                new Response(
                    "JD Poultry Farm is temporarily offline. Please check your internet connection.",
                    {
                        headers: { "Content-Type": "text/plain" }
                    }
                )
            )
        );
        return;
    }

    event.respondWith(
        caches.match(request).then(cached => {
            return cached || fetch(request);
        })
    );
});