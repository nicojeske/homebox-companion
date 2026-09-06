<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Bluetooth, BluetoothOff, BluetoothConnected, Camera, ChevronRight, MapPin, RotateCcw, Trash2, Package, ExternalLink } from 'lucide-svelte';
	import AppContainer from '$lib/components/AppContainer.svelte';
	import QrScanner from '$lib/components/QrScanner.svelte';
	import { bleScanner } from '$lib/services/bleScanner.svelte';
	import { relocateWorkflow, type MoveLogEntry } from '$lib/workflows/relocate.svelte';
	import { locations } from '$lib/api/locations';
	import type { LocationTreeNode } from '$lib/types';
	import { items } from '$lib/api/items';
	import { showToast } from '$lib/stores/ui.svelte';
	import { resolveQrUrl } from '$lib/utils/qrUrl';
	import { parseScannedCode } from '$lib/utils/scanCode';
	import { getConfig } from '$lib/api/settings';
	import { createLogger } from '$lib/utils/logger';

	const log = createLogger({ prefix: 'RelocatePage' });

	// ---------------------------------------------------------------------------
	// State
	// ---------------------------------------------------------------------------

	let showQrScanner = $state(false);
	let isProcessingQr = $state(false);
	let homeboxUrl = $state<string>('');

	/** Blob URL cache: itemId → object URL string (for thumbnails) */
	let thumbnailUrls = $state<Record<string, string>>({});
	/** Track revoke functions to avoid memory leaks */
	let thumbnailRevokes: Record<string, () => void> = {};

	// ---------------------------------------------------------------------------
	// BLE scanner lifecycle
	// ---------------------------------------------------------------------------

	let unsubscribeScan: (() => void) | null = null;

	onMount(async () => {
		unsubscribeScan = bleScanner.onScan(handleScan);
		// Load Homebox URL for opening items
		try {
			const config = await getConfig();
			homeboxUrl = config.homebox_url;
		} catch (err) {
			log.error('Failed to load config:', err);
		}
	});

	onDestroy(() => {
		unsubscribeScan?.();
		// Revoke all cached thumbnail blob URLs
		for (const revoke of Object.values(thumbnailRevokes)) {
			revoke();
		}
	});

	// ---------------------------------------------------------------------------
	// Scan handler (shared between BLE and camera)
	// ---------------------------------------------------------------------------

	function findAncestors(
		nodes: LocationTreeNode[],
		targetId: string,
		ancestors: string[] = []
	): string[] | null {
		for (const node of nodes) {
			if (node.id === targetId) return ancestors;
			const found = findAncestors(
				(node.children ?? []) as LocationTreeNode[],
				targetId,
				[...ancestors, node.name]
			);
			if (found !== null) return found;
		}
		return null;
	}

	async function handleScan(rawText: string): Promise<void> {
		if (isProcessingQr || relocateWorkflow.processing) return;
		isProcessingQr = true;
		showQrScanner = false;

		try {
			const resolved = await resolveQrUrl(rawText);
			log.debug(`Resolved scan: ${resolved}`);

			const parsed = parseScannedCode(resolved);

			if (parsed.kind === 'location') {
				const uuid = parsed.locationId;
				const [loc, tree] = await Promise.all([locations.get(uuid), locations.tree()]);
				const ancestors = findAncestors(tree as LocationTreeNode[], uuid) ?? [];
				relocateWorkflow.setTargetLocation(loc.id, loc.name, ancestors);
				showToast(`Destination: ${loc.name}`, 'success');
				return;
			}

			if (parsed.kind === 'asset') {
				await relocateWorkflow.processItemScan(parsed.assetId);
				// Load thumbnail for new log entry if available
				const entry = relocateWorkflow.moveLog[0];
				if (entry?.thumbnailId && !(entry.itemId in thumbnailUrls)) {
					loadThumbnail(entry.itemId, entry.thumbnailId);
				}
				return;
			}

			showToast('Unrecognised QR code.', 'warning');
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			showToast(`Scan error: ${msg}`, 'error');
			log.error('Scan handling error:', err);
		} finally {
			isProcessingQr = false;
		}
	}

	// ---------------------------------------------------------------------------
	// Thumbnail loading
	// ---------------------------------------------------------------------------

	function loadThumbnail(itemId: string, thumbnailId: string): void {
		items
			.getThumbnail(itemId, thumbnailId)
			.then((result) => {
				// Revoke previous blob URL if any
				thumbnailRevokes[itemId]?.();
				thumbnailUrls = { ...thumbnailUrls, [itemId]: result.url };
				thumbnailRevokes[itemId] = result.revoke;
				log.debug(`Loaded thumbnail for item ${itemId}`);
			})
			.catch((err) => {
				log.warn(`Failed to load thumbnail for item ${itemId} (attachment ${thumbnailId}):`, err);
				// Placeholder will show instead
			});
	}

	// Load thumbnails for entries that don't yet have a URL (e.g. after undo-reload)
	$effect(() => {
		for (const entry of relocateWorkflow.moveLog) {
			if (entry.thumbnailId && !(entry.itemId in thumbnailUrls)) {
				log.debug(`Loading thumbnail for ${entry.itemName} (${entry.itemId}): ${entry.thumbnailId}`);
				loadThumbnail(entry.itemId, entry.thumbnailId);
			} else if (!entry.thumbnailId) {
				log.debug(`Item ${entry.itemName} (${entry.itemId}) has no thumbnailId`);
			}
		}
	});

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

	async function handleUndo(index: number): Promise<void> {
		await relocateWorkflow.undoMove(index);
	}

	function clearLog(): void {
		// Revoke all blob URLs before clearing
		for (const [itemId, revoke] of Object.entries(thumbnailRevokes)) {
			revoke();
			delete thumbnailRevokes[itemId];
		}
		thumbnailUrls = {};
		relocateWorkflow.clearLog();
	}

	function openItemInHomebox(entry: MoveLogEntry): void {
		if (!homeboxUrl) {
			showToast('Homebox URL not available', 'warning');
			return;
		}
		const itemUrl = `${homeboxUrl}/a/${encodeURIComponent(entry.assetId)}`;
		window.open(itemUrl, '_blank');
	}

	function formatTime(date: Date): string {
		return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}
</script>

<AppContainer>
	<div class="flex min-h-screen flex-col gap-4 pb-24 pt-4">

		<!-- ------------------------------------------------------------------ -->
		<!-- Header                                                              -->
		<!-- ------------------------------------------------------------------ -->
		<div class="flex items-center justify-between px-1">
			<h1 class="text-xl font-semibold text-neutral-100">Move Items</h1>
			{#if relocateWorkflow.moveLog.length > 0}
				<button
					type="button"
					onclick={clearLog}
					class="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-neutral-400 hover:bg-neutral-700/50 hover:text-neutral-200 transition-colors"
					title="Clear move log"
				>
					<Trash2 size={14} />
					Clear log
				</button>
			{/if}
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
						class="rounded-lg px-3 py-1.5 text-sm text-neutral-400 hover:bg-neutral-700/50 hover:text-neutral-200 transition-colors"
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
						class="rounded-lg bg-primary-500/10 px-3 py-1.5 text-sm font-medium text-primary-400 hover:bg-primary-500/20 disabled:opacity-50 transition-colors"
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
					disabled={isProcessingQr || relocateWorkflow.processing}
					class="flex items-center gap-2 text-sm text-neutral-400 hover:text-neutral-200 disabled:opacity-50 transition-colors"
				>
					<Camera size={16} />
					Scan with camera
				</button>
			</div>
		</div>

		<!-- ------------------------------------------------------------------ -->
		<!-- Target Location                                                      -->
		<!-- ------------------------------------------------------------------ -->
		<div class="rounded-2xl border {relocateWorkflow.targetLocation ? 'border-primary-500/30 bg-primary-500/5' : 'border-neutral-700 bg-neutral-800/60'} p-4">
			<p class="mb-2 text-xs font-medium uppercase tracking-wider text-neutral-500">
				Destination Location
			</p>

			{#if relocateWorkflow.targetLocation}
				<div class="flex items-center justify-between">
					<div class="flex min-w-0 items-center gap-3">
						<MapPin size={20} class="shrink-0 text-primary-400" />
						<div class="min-w-0">
							{#if relocateWorkflow.targetLocationPath.length > 0}
								<p class="mb-0.5 flex flex-wrap items-center gap-x-1 text-xs text-neutral-400">
									{#each relocateWorkflow.targetLocationPath as ancestor, i}
										{#if i > 0}
											<ChevronRight size={12} class="shrink-0 text-neutral-600" />
										{/if}
										<span>{ancestor}</span>
									{/each}
								</p>
							{/if}
							<span class="text-base font-medium text-neutral-100">
								{relocateWorkflow.targetLocation.name}
							</span>
						</div>
					</div>
					<button
						type="button"
						onclick={() => relocateWorkflow.clearTargetLocation()}
						class="rounded-lg px-3 py-1.5 text-sm text-neutral-400 hover:bg-neutral-700/50 hover:text-neutral-200 transition-colors"
					>
						Clear
					</button>
				</div>
			{:else}
				<div class="flex items-center gap-3 text-neutral-500">
					<MapPin size={20} class="shrink-0" />
					<p class="text-sm">Scan a location QR code to set the destination.</p>
				</div>
			{/if}
		</div>

		<!-- ------------------------------------------------------------------ -->
		<!-- Move Log                                                             -->
		<!-- ------------------------------------------------------------------ -->
		{#if relocateWorkflow.moveLog.length > 0}
			<div>
				<p class="mb-2 px-1 text-xs font-medium uppercase tracking-wider text-neutral-500">
					{relocateWorkflow.moveLog.length}
					{relocateWorkflow.moveLog.length === 1 ? 'item' : 'items'} moved this session
				</p>

				<ul class="flex flex-col gap-2">
					{#each relocateWorkflow.moveLog as entry, index (entry.itemId + entry.movedAt.toISOString())}
						<li
							class="flex items-center gap-3 rounded-2xl border {entry.undone ? 'border-neutral-700/50 bg-neutral-800/30 opacity-60' : 'border-neutral-700 bg-neutral-800/60'} p-3 transition-opacity"
						>
							<!-- Thumbnail -->
							<div class="h-12 w-12 shrink-0 overflow-hidden rounded-xl bg-neutral-700">
								{#if thumbnailUrls[entry.itemId]}
									<img
										src={thumbnailUrls[entry.itemId]}
										alt={entry.itemName}
										class="h-full w-full object-cover"
									/>
								{:else}
									<div class="flex h-full w-full items-center justify-center text-neutral-500">
										<Package size={20} />
									</div>
								{/if}
							</div>

							<!-- Item info (clickable) -->
							<button
								type="button"
								onclick={() => openItemInHomebox(entry)}
								disabled={entry.undone}
								class="min-w-0 flex-1 text-left disabled:cursor-default"
								title={entry.undone ? 'Item was undone' : 'Click to open in Homebox'}
							>
								<p class="truncate text-sm font-medium {entry.undone ? 'line-through text-neutral-500' : 'text-neutral-100 hover:text-primary-300'} transition-colors">
									{entry.itemName}
								</p>
								<p class="truncate text-xs text-neutral-400">
									{entry.previousLocationName ?? '—'}
									→
									{entry.targetLocationName}
								</p>
								<p class="text-xs text-neutral-600">{formatTime(entry.movedAt)}</p>
							</button>

							<!-- Undo button -->
							<button
								type="button"
								onclick={() => handleUndo(index)}
								disabled={entry.undone || relocateWorkflow.processing}
								class="shrink-0 flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium {entry.undone ? 'text-neutral-600 cursor-default' : 'text-neutral-400 hover:bg-neutral-700/50 hover:text-neutral-200'} disabled:opacity-50 transition-colors"
								title={entry.undone ? 'Already undone' : 'Undo this move'}
							>
								<RotateCcw size={12} />
								{entry.undone ? 'Undone' : 'Undo'}
							</button>
						</li>
					{/each}
				</ul>
			</div>
		{:else}
			<!-- Empty state -->
			<div class="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-neutral-700 py-12 text-neutral-600">
				<Package size={32} strokeWidth={1.5} />
				<p class="text-sm">No items moved yet.</p>
				<p class="text-xs text-neutral-700">
					{#if relocateWorkflow.targetLocation}
						Scan an item QR code to move it.
					{:else}
						Scan a location QR code first.
					{/if}
				</p>
			</div>
		{/if}

		<!-- Processing indicator -->
		{#if relocateWorkflow.processing}
			<div class="fixed bottom-20 left-1/2 -translate-x-1/2">
				<div class="rounded-full bg-neutral-800 px-4 py-2 text-sm text-neutral-300 shadow-lg border border-neutral-700">
					Processing…
				</div>
			</div>
		{/if}
	</div>
</AppContainer>

<!-- QR Scanner Modal -->
{#if showQrScanner}
	<QrScanner
		onScan={handleScan}
		onClose={() => (showQrScanner = false)}
		onError={(err) => {
			showToast(`Camera error: ${err}`, 'error');
			showQrScanner = false;
		}}
	/>
{/if}
