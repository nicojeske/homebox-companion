/**
 * Shared "scan -> navigate" handler for every screen that listens to
 * `bleScanner` (or a camera scan) live rather than through the dedicated
 * `/scan` route.
 *
 * This is the same body `/scan`'s `handleScan` used to inline, lifted out so
 * `/browse` and `/items/[id]` can share one implementation - and, critically,
 * one re-entrancy guard. Each page previously kept its own local
 * `isProcessing` flag, which only guards a single page: once two routes can
 * both receive the same scan (e.g. a BLE notification firing while a
 * `goto()` from a previous scan is still resolving), per-page flags stop
 * being enough. `processing` here is a single module-level flag shared by
 * every caller.
 */

import { navigateToScannedCode, resolveScannedCode } from '$lib/services/scanResolver';
import { showToast } from '$lib/stores/ui.svelte';
import { createLogger } from '$lib/utils/logger';

const log = createLogger({ prefix: 'ScanToOpen' });

class ScanToOpen {
	/** True while a scan is being resolved/routed. Reactive - bind to it for a spinner/disabled state. */
	processing = $state(false);

	/**
	 * Resolve raw scanned text and navigate to what it identifies. Never
	 * throws - `resolveScannedCode` already degrades gracefully, and any
	 * other failure (e.g. a non-404 API error from `navigateToScannedCode`)
	 * is caught here and surfaced as a toast, matching `/scan`'s original
	 * behavior.
	 *
	 * A second call while one is still in flight is dropped rather than
	 * queued - `bleScanner` calls subscribers synchronously and drops the
	 * returned promise (see `bleScanner.svelte.ts`'s notification handler),
	 * so without this guard a fast double-notification could kick off two
	 * overlapping navigations.
	 */
	async handle(rawText: string): Promise<void> {
		if (this.processing) return;
		this.processing = true;

		try {
			const parsed = await resolveScannedCode(rawText);
			await navigateToScannedCode(parsed);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			showToast(`Scan error: ${msg}`, 'error');
			log.error('Scan handling error:', err);
		} finally {
			this.processing = false;
		}
	}
}

export const scanToOpen = new ScanToOpen();
