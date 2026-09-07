/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

/**
 * Service Worker - installability + fast app-shell loads.
 *
 * Scope is deliberately narrow: this is NOT a full offline-first cache.
 * - `/api/*` and every non-GET request always hit the network untouched
 *   (auth tokens, SSE chat streams, vision analysis must never be cached/replayed).
 * - Hashed build assets (`_app/immutable/*`) and static files are cache-first —
 *   safe because their filenames change on every content change.
 * - Navigations are network-first with the cached shell (`/`) as a fallback,
 *   so a stale bundle never sticks around after a deploy (see AGENTS.md).
 *
 * No `skipWaiting()`: an old page may still be running and could request a
 * lazily-loaded chunk that no longer exists in a new build. Letting the new
 * worker wait until old clients close avoids serving it a 404-turned-index.html.
 */

import { build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = `hbc-cache-${version}`;

// `build`/`files` don't include the SPA fallback document itself under
// adapter-static, so add '/' explicitly to precache the app shell.
const PRECACHE_URLS = [...build, ...files, '/'];

sw.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE);
			await cache.addAll(PRECACHE_URLS);
		})()
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			const keys = await caches.keys();
			await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
		})()
	);
});

sw.addEventListener('fetch', (event) => {
	const { request } = event;

	// Only handle same-origin GET requests - everything else (API calls,
	// cross-origin fonts, POST/PUT/DELETE) is left entirely to the network.
	if (request.method !== 'GET') return;

	const url = new URL(request.url);
	if (url.origin !== sw.location.origin) return;
	if (url.pathname.startsWith('/api/')) return;

	if (request.mode === 'navigate') {
		event.respondWith(networkFirst(request));
		return;
	}

	if (PRECACHE_URLS.includes(url.pathname)) {
		event.respondWith(cacheFirst(request));
	}
});

async function cacheFirst(request: Request): Promise<Response> {
	const cache = await caches.open(CACHE);
	const cached = await cache.match(request);
	if (cached) return cached;
	return fetch(request);
}

async function networkFirst(request: Request): Promise<Response> {
	try {
		return await fetch(request);
	} catch {
		const cache = await caches.open(CACHE);
		const cached = await cache.match('/');
		if (cached) return cached;
		throw new Error('Network request failed and no cached shell is available');
	}
}
