<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import {
		Bluetooth,
		BluetoothOff,
		BluetoothConnected,
		Camera,
		ScanLine,
		MapPin,
		Package,
	} from 'lucide-svelte';
	import AppContainer from '$lib/components/AppContainer.svelte';
	import BackLink from '$lib/components/BackLink.svelte';
	import QrScanner from '$lib/components/QrScanner.svelte';
	import { bleScanner } from '$lib/services/bleScanner.svelte';
	import { scanToOpen } from '$lib/services/scanToOpen.svelte';
	import { createLogger } from '$lib/utils/logger';
	import { routeGuards } from '$lib/utils/routeGuard';
	import { getInitPromise } from '$lib/services/tokenRefresh';

	const log = createLogger({ prefix: 'ScanPage' });

	// ---------------------------------------------------------------------------
	// State
	// ---------------------------------------------------------------------------

	let showQrScanner = $state(false);

	// ---------------------------------------------------------------------------
	// BLE scanner lifecycle - only listens while this page is mounted
	// ---------------------------------------------------------------------------

	let unsubscribeScan: (() => void) | null = null;
	let destroyed = false;

	onMount(async () => {
		// Wait for auth initialization to complete to avoid race conditions
		// where we check isAuthenticated before initializeAuth clears expired tokens
		await getInitPromise();

		if (!routeGuards.scan()) return;
		if (destroyed) return;

		unsubscribeScan = bleScanner.onScan(handleScan);

		// Deep link support: /scan?code=<raw scanned text>, for external scanners
		// or a phone shortcut. Read once here (not reactively - re-navigating back
		// to /scan with the same URL shouldn't re-fire), then strip the param so a
		// refresh or back-navigation doesn't replay it.
		const code = page.url.searchParams.get('code');
		if (code) {
			replaceState(resolve('/scan'), {});
			await handleScan(code);
		}
	});

	onDestroy(() => {
		destroyed = true;
		unsubscribeScan?.();
	});

	// ---------------------------------------------------------------------------
	// Scan handler (shared between BLE, camera, and the ?code= deep link) -
	// delegates to the shared scanToOpen service so /browse and /items/[id]
	// use exactly the same resolve+navigate logic and re-entrancy guard.
	// ---------------------------------------------------------------------------

	async function handleScan(rawText: string): Promise<void> {
		showQrScanner = false;
		await scanToOpen.handle(rawText);
	}

	// ---------------------------------------------------------------------------
	// Actions
	// ---------------------------------------------------------------------------

	async function connectScanner(): Promise<void> {
		await bleScanner.connect();
	}

	async function disconnectScanner(): Promise<void> {
		await bleScanner.disconnect();
	}

	function openCamera(): void {
		showQrScanner = true;
	}

	function closeCamera(): void {
		showQrScanner = false;
	}

	/**
	 * Log and toast only - does NOT close the scanner. `QrScanner` shows its own
	 * file-upload fallback UI for camera errors (e.g. no HTTPS); closing the
	 * scanner here would take that fallback away before the user can use it.
	 */
	function handleScanError(error: string): void {
		log.warn('QR Scanner error:', error);
	}
</script>

<AppContainer>
	<div class="flex min-h-screen flex-col gap-4 pb-24 pt-4">
		<!-- ------------------------------------------------------------------ -->
		<!-- Header                                                              -->
		<!-- ------------------------------------------------------------------ -->
		<div class="px-1">
			<BackLink href="/browse" label="Back to Browse" />
			<h1 class="text-xl font-semibold text-neutral-100">Scan</h1>
			<p class="text-body-sm text-neutral-500">
				Scan an item's asset tag to open it, or a location tag to browse its contents.
			</p>
		</div>

		<!-- ------------------------------------------------------------------ -->
		<!-- BLE Scanner Status                                                  -->
		<!-- ------------------------------------------------------------------ -->
		<div class="rounded-2xl border border-neutral-700 bg-neutral-800/60 p-4">
			<p class="mb-3 text-xs font-medium uppercase tracking-wider text-neutral-500">Scanner</p>

			{#if !bleScanner.isSupported}
				<div class="flex items-center gap-3 text-neutral-400">
					<BluetoothOff size={20} class="shrink-0 text-neutral-500" />
					<p class="text-sm">Web Bluetooth not supported in this browser. Use the camera below.</p>
				</div>
			{:else if bleScanner.connected}
				<div class="flex items-center justify-between">
					<div class="flex items-center gap-3">
						<BluetoothConnected size={20} class="shrink-0 text-primary-400" />
						<p class="text-sm text-neutral-200">Scanner connected</p>
					</div>
					<button
						type="button"
						onclick={disconnectScanner}
						class="rounded-lg px-3 py-1.5 text-sm text-neutral-400 transition-colors hover:bg-neutral-700/50 hover:text-neutral-200"
					>
						Disconnect
					</button>
				</div>
			{:else}
				<div class="flex items-center justify-between">
					<div class="flex items-center gap-3">
						<Bluetooth size={20} class="shrink-0 text-neutral-500" />
						<p class="text-sm text-neutral-400">
							{bleScanner.connecting ? 'Connecting…' : 'No scanner connected'}
						</p>
					</div>
					<button
						type="button"
						onclick={connectScanner}
						disabled={bleScanner.connecting}
						class="rounded-lg bg-primary-500/10 px-3 py-1.5 text-sm font-medium text-primary-400 transition-colors hover:bg-primary-500/20 disabled:opacity-50"
					>
						{bleScanner.connecting ? 'Connecting…' : 'Connect Scanner'}
					</button>
				</div>
				{#if bleScanner.error}
					<p class="mt-2 text-xs text-red-400">{bleScanner.error}</p>
				{/if}
			{/if}

			<!-- Camera fallback -->
			<div class="mt-3 border-t border-neutral-700/50 pt-3">
				<button
					type="button"
					onclick={openCamera}
					disabled={scanToOpen.processing}
					class="flex items-center gap-2 text-sm text-neutral-400 transition-colors hover:text-neutral-200 disabled:opacity-50"
				>
					<Camera size={16} />
					Scan with camera
				</button>
			</div>
		</div>

		<!-- ------------------------------------------------------------------ -->
		<!-- Hint                                                                -->
		<!-- ------------------------------------------------------------------ -->
		<div class="rounded-2xl border border-neutral-700 bg-neutral-800/60 p-4">
			<p class="mb-3 text-xs font-medium uppercase tracking-wider text-neutral-500">
				What you can scan
			</p>
			<div class="flex flex-col gap-3">
				<div class="flex items-center gap-3">
					<Package size={20} class="shrink-0 text-neutral-500" />
					<p class="text-sm text-neutral-400">Item tag &rarr; opens the item's detail page</p>
				</div>
				<div class="flex items-center gap-3">
					<MapPin size={20} class="shrink-0 text-neutral-500" />
					<p class="text-sm text-neutral-400">Location tag &rarr; opens Browse filtered to it</p>
				</div>
				<div class="flex items-center gap-3">
					<ScanLine size={20} class="shrink-0 text-neutral-500" />
					<p class="text-sm text-neutral-400">
						Anything else &rarr; searched as free text in Browse
					</p>
				</div>
			</div>
		</div>

		{#if scanToOpen.processing}
			<p class="px-1 text-sm text-neutral-500">Looking that up…</p>
		{/if}
	</div>
</AppContainer>

<!-- QR Scanner Modal -->
{#if showQrScanner}
	<QrScanner onScan={handleScan} onClose={closeCamera} onError={handleScanError} />
{/if}
