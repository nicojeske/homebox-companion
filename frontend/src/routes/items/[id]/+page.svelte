<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import {
		ExternalLink,
		MapPin,
		Package,
		Pencil,
		Printer,
		Tag as TagIcon,
		Trash2,
	} from 'lucide-svelte';
	import AppContainer from '$lib/components/AppContainer.svelte';
	import BackLink from '$lib/components/BackLink.svelte';
	import Button from '$lib/components/Button.svelte';
	import Card from '$lib/components/Card.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import Loader from '$lib/components/Loader.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import Skeleton from '$lib/components/Skeleton.svelte';
	import AttachmentGallery from '$lib/components/AttachmentGallery.svelte';
	import BleScannerChip from '$lib/components/BleScannerChip.svelte';
	import {
		ItemCoreFields,
		ItemExtendedFields,
		ItemCustomFields,
		TagSelector,
		LocationSelector,
		AssetIdInput,
	} from '$lib/components/form';
	import { itemDetailWorkflow } from '$lib/workflows/item-detail.svelte';
	import { draftFromItem, type ItemDraft } from '$lib/utils/itemDiff';
	import { locationNavigator } from '$lib/services/locationNavigator.svelte';
	import { locationStore } from '$lib/stores/locations.svelte';
	import { tagStore } from '$lib/stores/tags.svelte';
	import { settingsService } from '$lib/workflows/settings.svelte';
	import { getConfig } from '$lib/api/settings';
	import { bleScanner } from '$lib/services/bleScanner.svelte';
	import { scanToOpen } from '$lib/services/scanToOpen.svelte';
	import { routeGuards } from '$lib/utils/routeGuard';
	import { getInitPromise } from '$lib/services/tokenRefresh';
	import { createLogger } from '$lib/utils/logger';

	const log = createLogger({ prefix: 'ItemDetailPage' });

	const itemId = $derived(page.params.id);

	let draft = $state<ItemDraft | null>(null);
	let showExtendedFields = $state(false);
	let showCustomFields = $state(false);
	let showMoveModal = $state(false);
	let moveLocationId = $state('');
	let showDeleteConfirm = $state(false);
	let deleting = $state(false);
	let printing = $state(false);

	let homeboxUrl = $state<string | null>(null);
	let printEnabled = $state(false);

	const item = $derived(itemDetailWorkflow.item);
	const isEditing = $derived(itemDetailWorkflow.mode === 'edit');

	// ---------------------------------------------------------------------------
	// BLE scanner lifecycle - listens live while this page is mounted, so
	// scanning another item's tag jumps straight to it. Guarded on `isEditing`
	// rather than unsubscribed/resubscribed on mode change: `AssetIdInput` is
	// only mounted in the edit-mode branch below, so the two handlers are
	// never both live for the same scan - in edit mode the scan fills the
	// asset ID field exactly as before, in view mode it navigates.
	// ---------------------------------------------------------------------------

	let unsubscribeScan: (() => void) | null = null;
	let destroyed = false;
	let ready = $state(false);

	// Reactive on `itemId` (not just mount): scanning another tag while this
	// page is open navigates via goto() to the same route with a new param,
	// which SvelteKit handles by reusing this component instance rather than
	// remounting it - so the load has to be keyed off `itemId` itself to pick
	// up the new item.
	$effect(() => {
		const id = itemId;
		if (!ready || !id) return;
		void itemDetailWorkflow.load(id);
	});

	onMount(async () => {
		await getInitPromise();
		if (!routeGuards.itemDetail()) return;
		if (!itemId) return; // Route always supplies this; guard only satisfies the generic Page type
		if (destroyed) return;

		unsubscribeScan = bleScanner.onScan((text) => {
			if (isEditing) return;
			void scanToOpen.handle(text);
		});

		ready = true;

		await Promise.all([
			locationStore.flatList.length > 0 ? Promise.resolve() : locationNavigator.loadTree(),
			tagStore.fetchTags(),
		]);

		if (settingsService.config) {
			homeboxUrl = settingsService.config.homebox_url;
			printEnabled = settingsService.config.print_enabled;
		} else {
			try {
				const config = await getConfig();
				homeboxUrl = config.homebox_url;
				printEnabled = config.print_enabled;
			} catch (err) {
				log.debug('Failed to load config (Homebox deep link/print disabled):', err);
			}
		}
	});

	onDestroy(() => {
		destroyed = true;
		unsubscribeScan?.();
		itemDetailWorkflow.reset();
	});

	function startEdit(): void {
		if (!item) return;
		draft = draftFromItem(item, itemDetailWorkflow.customFieldDefs);
		itemDetailWorkflow.startEdit();
	}

	function cancelEdit(): void {
		draft = null;
		itemDetailWorkflow.cancelEdit();
	}

	async function saveEdit(): Promise<void> {
		if (!draft) return;
		const ok = await itemDetailWorkflow.save(draft);
		if (ok) draft = null;
	}

	function toggleTag(tagId: string): void {
		if (!draft) return;
		const current = draft.tagIds;
		draft.tagIds = current.includes(tagId)
			? current.filter((id) => id !== tagId)
			: [...current, tagId];
	}

	function handleAssetIdChange(value: string | null): void {
		if (!draft) return;
		draft.assetId = value;
	}

	function openMoveModal(): void {
		moveLocationId = item?.parent?.isLocation ? item.parent.id : '';
		showMoveModal = true;
	}

	async function confirmMove(): Promise<void> {
		const targetId = moveLocationId || null;
		const targetName = targetId
			? locationStore.flatList.find((f) => f.location.id === targetId)?.location.name
			: undefined;
		showMoveModal = false;
		await itemDetailWorkflow.moveTo(targetId, targetName);
	}

	async function confirmDelete(): Promise<void> {
		deleting = true;
		try {
			const ok = await itemDetailWorkflow.deleteItemPermanently();
			if (ok) goto(resolve('/browse'));
		} finally {
			deleting = false;
			showDeleteConfirm = false;
		}
	}

	async function handlePrintLabel(): Promise<void> {
		printing = true;
		try {
			await itemDetailWorkflow.printLabel();
		} finally {
			printing = false;
		}
	}

	function uploadAttachment(file: File): Promise<boolean> {
		return itemDetailWorkflow.uploadAttachment(file);
	}

	function setPrimaryAttachment(attachmentId: string): Promise<boolean> {
		return itemDetailWorkflow.setPrimaryAttachment(attachmentId);
	}

	function deleteAttachment(attachmentId: string): Promise<boolean> {
		return itemDetailWorkflow.deleteAttachment(attachmentId);
	}

	function openInHomebox(): void {
		if (!homeboxUrl || !item) return;
		window.open(`${homeboxUrl}/item/${encodeURIComponent(item.id)}`, '_blank');
	}
</script>

<AppContainer>
	<div class="flex min-h-screen flex-col gap-4 pb-24 pt-4">
		<div class="flex items-center justify-between gap-3 px-1">
			<BackLink href="/browse" label="Back to Browse" />
			<BleScannerChip />
		</div>

		{#if itemDetailWorkflow.isLoading}
			<div class="space-y-3 px-1">
				<Skeleton height="2rem" width="60%" />
				<Skeleton height="1.25rem" width="40%" />
				<Skeleton height="12rem" />
			</div>
		{:else if itemDetailWorkflow.error}
			<div class="flex flex-col items-center gap-3 px-4 py-12 text-center text-neutral-400">
				<Package size={32} strokeWidth={1.5} />
				<p>{itemDetailWorkflow.error}</p>
			</div>
		{:else if item}
			<Card>
				{#if item.path.length > 0}
					<p class="mb-1 truncate text-body-sm text-neutral-500">
						{item.path.map((seg) => seg.name).join(' / ')}
					</p>
				{/if}

				{#if !isEditing}
					<!-- VIEW MODE -->
					<div class="space-y-5">
						<div class="flex items-start justify-between gap-3">
							<div class="min-w-0">
								<h1 class="text-xl font-semibold text-neutral-100">{item.name}</h1>
								{#if item.description}
									<p class="mt-1 whitespace-pre-wrap text-body-sm text-neutral-400">
										{item.description}
									</p>
								{/if}
							</div>
							<button
								type="button"
								class="min-h-touch min-w-touch flex-shrink-0 rounded-lg border border-neutral-700 bg-neutral-800 p-2 text-neutral-300 transition-colors hover:bg-neutral-700"
								onclick={startEdit}
								aria-label="Edit item"
							>
								<Pencil size={18} />
							</button>
						</div>

						<div class="flex flex-wrap gap-4 text-body-sm text-neutral-400">
							<span>Qty: {item.quantity}</span>
							{#if item.assetId}<span>Asset: {item.assetId}</span>{/if}
							{#if item.insured}<span class="text-success-400">Insured</span>{/if}
							{#if item.archived}<span class="text-warning-400">Archived</span>{/if}
						</div>

						<button
							type="button"
							class="flex items-center gap-1.5 text-body-sm text-neutral-400 transition-colors hover:text-neutral-200"
							onclick={openMoveModal}
						>
							<MapPin size={14} />
							{item.parent ? item.parent.name : 'No location'} · Move
						</button>

						{#if item.tags.length > 0}
							<div class="flex flex-wrap gap-2">
								{#each item.tags as tag (tag.id)}
									<span
										class="inline-flex items-center gap-1 rounded-full bg-neutral-700/50 px-2.5 py-1 text-xs text-neutral-300"
									>
										<TagIcon size={11} />
										{tag.name}
									</span>
								{/each}
							</div>
						{/if}

						{#if item.manufacturer || item.modelNumber || item.serialNumber || item.purchasePrice || item.purchaseFrom || item.notes}
							<div class="grid grid-cols-2 gap-3 border-t border-neutral-700 pt-4 text-body-sm">
								{#if item.manufacturer}
									<div>
										<span class="text-neutral-500">Manufacturer</span>
										<p>{item.manufacturer}</p>
									</div>
								{/if}
								{#if item.modelNumber}
									<div>
										<span class="text-neutral-500">Model</span>
										<p>{item.modelNumber}</p>
									</div>
								{/if}
								{#if item.serialNumber}
									<div>
										<span class="text-neutral-500">Serial</span>
										<p>{item.serialNumber}</p>
									</div>
								{/if}
								{#if item.purchasePrice !== null}
									<div>
										<span class="text-neutral-500">Price</span>
										<p>{item.purchasePrice}</p>
									</div>
								{/if}
								{#if item.purchaseFrom}
									<div>
										<span class="text-neutral-500">Purchased from</span>
										<p>{item.purchaseFrom}</p>
									</div>
								{/if}
								{#if item.notes}
									<div class="col-span-2">
										<span class="text-neutral-500">Notes</span>
										<p class="whitespace-pre-wrap">{item.notes}</p>
									</div>
								{/if}
							</div>
						{/if}

						{#if item.fields.filter((f) => f.textValue).length > 0}
							<div class="grid grid-cols-2 gap-3 border-t border-neutral-700 pt-4 text-body-sm">
								{#each item.fields.filter((f) => f.textValue) as field (field.name)}
									<div>
										<span class="text-neutral-500">{field.name}</span>
										<p>{field.textValue}</p>
									</div>
								{/each}
							</div>
						{/if}

						<div class="border-t border-neutral-700 pt-4">
							<AttachmentGallery
								itemId={item.id}
								attachments={item.attachments}
								disabled={true}
								onUpload={uploadAttachment}
								onSetPrimary={setPrimaryAttachment}
								onDelete={deleteAttachment}
							/>
						</div>

						<div class="flex flex-wrap gap-2 border-t border-neutral-700 pt-4">
							{#if printEnabled}
								<Button variant="secondary" size="sm" onclick={handlePrintLabel} loading={printing}>
									<Printer size={16} />
									Print Label
								</Button>
							{/if}
							{#if homeboxUrl}
								<Button variant="secondary" size="sm" onclick={openInHomebox}>
									<ExternalLink size={16} />
									Open in Homebox
								</Button>
							{/if}
							<Button variant="danger" size="sm" onclick={() => (showDeleteConfirm = true)}>
								<Trash2 size={16} />
								Delete
							</Button>
						</div>
					</div>
				{:else if draft}
					<!-- EDIT MODE -->
					<div class="space-y-5">
						<ItemCoreFields
							bind:name={draft.name}
							bind:quantity={draft.quantity}
							bind:description={draft.description}
							idPrefix="item-detail"
						/>

						<AssetIdInput value={draft.assetId} onChange={handleAssetIdChange} />

						<LocationSelector bind:value={draft.locationId} idPrefix="item-detail" />

						<TagSelector selectedIds={draft.tagIds} onToggle={toggleTag} />

						<ItemExtendedFields
							bind:manufacturer={draft.manufacturer}
							bind:modelNumber={draft.modelNumber}
							bind:serialNumber={draft.serialNumber}
							bind:purchasePrice={draft.purchasePrice}
							bind:purchaseFrom={draft.purchaseFrom}
							bind:notes={draft.notes}
							expanded={showExtendedFields}
							onToggle={() => (showExtendedFields = !showExtendedFields)}
							idPrefix="item-detail"
						/>

						{#if Object.keys(draft.customFields).length > 0}
							<ItemCustomFields
								bind:customFields={draft.customFields}
								expanded={showCustomFields}
								onToggle={() => (showCustomFields = !showCustomFields)}
								idPrefix="item-detail"
							/>
						{/if}

						<div class="flex gap-4 border-t border-neutral-700 pt-4">
							<label class="flex items-center gap-2 text-body-sm text-neutral-300">
								<input
									type="checkbox"
									bind:checked={draft.insured}
									class="h-4 w-4 rounded border-neutral-600 bg-neutral-800 text-primary-600 focus:ring-2 focus:ring-primary-500/50"
								/>
								Insured
							</label>
							<label class="flex items-center gap-2 text-body-sm text-neutral-300">
								<input
									type="checkbox"
									bind:checked={draft.archived}
									class="h-4 w-4 rounded border-neutral-600 bg-neutral-800 text-primary-600 focus:ring-2 focus:ring-primary-500/50"
								/>
								Archived
							</label>
						</div>

						<div class="border-t border-neutral-700 pt-4">
							<AttachmentGallery
								itemId={item.id}
								attachments={item.attachments}
								disabled={false}
								onUpload={uploadAttachment}
								onSetPrimary={setPrimaryAttachment}
								onDelete={deleteAttachment}
							/>
						</div>

						{#if itemDetailWorkflow.error}
							<p class="text-error-400 text-body-sm">{itemDetailWorkflow.error}</p>
						{/if}

						<div class="sticky bottom-4 flex gap-3 border-t border-neutral-700 bg-neutral-900 pt-4">
							<Button
								variant="secondary"
								full
								onclick={cancelEdit}
								disabled={itemDetailWorkflow.isSaving}
							>
								Cancel
							</Button>
							<Button
								variant="primary"
								full
								onclick={saveEdit}
								loading={itemDetailWorkflow.isSaving}
							>
								Save
							</Button>
						</div>
					</div>
				{/if}
			</Card>
		{/if}
	</div>
</AppContainer>

<Modal bind:open={showMoveModal} title="Move Item">
	<div class="space-y-4">
		<LocationSelector bind:value={moveLocationId} idPrefix="move-item" fallbackDisplay="Root" />
		<div class="flex gap-3">
			<Button variant="secondary" full onclick={() => (showMoveModal = false)}>Cancel</Button>
			<Button variant="primary" full onclick={confirmMove} loading={itemDetailWorkflow.isSaving}>
				Move
			</Button>
		</div>
	</div>
</Modal>

<ConfirmDialog
	open={showDeleteConfirm}
	title="Delete Item"
	message={`Delete "${item?.name ?? 'this item'}"? This cannot be undone.`}
	confirmLabel="Delete"
	onConfirm={confirmDelete}
	onCancel={() => (showDeleteConfirm = false)}
/>

{#if deleting}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/60">
		<Loader message="Deleting…" />
	</div>
{/if}
