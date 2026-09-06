<script lang="ts">
	/**
	 * AttachmentGallery - photo gallery for an existing Homebox item
	 *
	 * Unlike ImagesPanel (built for in-progress capture sessions, binding a local
	 * `File[]`), this operates on server-side attachments that already have IDs -
	 * upload/set-primary/delete are each a round trip, delegated to the parent via
	 * callbacks (matching the workflow-owns-state rule: this component never talks
	 * to the API directly).
	 */
	import { onDestroy } from 'svelte';
	import { ImageIcon, Star, Trash2, Upload } from 'lucide-svelte';
	import { items as itemsApi, type BlobUrlResult } from '$lib/api';
	import { createLogger } from '$lib/utils/logger';
	import type { ItemAttachmentRef } from '$lib/types';

	const log = createLogger({ prefix: 'AttachmentGallery' });

	interface Props {
		itemId: string;
		attachments: ItemAttachmentRef[];
		disabled?: boolean;
		onUpload: (file: File) => Promise<boolean>;
		onSetPrimary: (attachmentId: string) => Promise<boolean>;
		onDelete: (attachmentId: string) => Promise<boolean>;
	}

	let { itemId, attachments, disabled = false, onUpload, onSetPrimary, onDelete }: Props = $props();

	// Thumbnail blob URLs, keyed by attachment ID (revoked on destroy / when an attachment is gone)
	let thumbnailUrls = $state<Record<string, string>>({});
	let thumbnailRevokes: Record<string, () => void> = {};

	let fileInput: HTMLInputElement | undefined = $state();
	let uploading = $state(false);
	/** Attachment ID currently being set-primary'd or deleted, to disable its own buttons only. */
	let pendingId = $state<string | null>(null);

	onDestroy(() => {
		for (const revoke of Object.values(thumbnailRevokes)) revoke();
	});

	// Load thumbnails for newly-seen attachments; revoke ones that disappeared (e.g. after delete).
	$effect(() => {
		const currentIds = new Set(attachments.map((a) => a.id));

		for (const attachment of attachments) {
			if (!(attachment.id in thumbnailUrls)) loadThumbnail(attachment.id);
		}

		for (const id of Object.keys(thumbnailUrls)) {
			if (!currentIds.has(id)) {
				thumbnailRevokes[id]?.();
				delete thumbnailRevokes[id];
				const next = { ...thumbnailUrls };
				delete next[id];
				thumbnailUrls = next;
			}
		}
	});

	function loadThumbnail(attachmentId: string): void {
		itemsApi
			.getThumbnail(itemId, attachmentId)
			.then((result: BlobUrlResult) => {
				thumbnailRevokes[attachmentId]?.();
				thumbnailUrls = { ...thumbnailUrls, [attachmentId]: result.url };
				thumbnailRevokes[attachmentId] = result.revoke;
			})
			.catch((err) => {
				log.debug(`Failed to load thumbnail for attachment ${attachmentId}:`, err);
			});
	}

	function handleFileSelect(e: Event): void {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		input.value = ''; // allow re-selecting the same file later
		if (!file) return;
		void handleUpload(file);
	}

	async function handleUpload(file: File): Promise<void> {
		uploading = true;
		try {
			await onUpload(file);
		} finally {
			uploading = false;
		}
	}

	async function handleSetPrimary(attachmentId: string): Promise<void> {
		pendingId = attachmentId;
		try {
			await onSetPrimary(attachmentId);
		} finally {
			pendingId = null;
		}
	}

	async function handleDelete(attachmentId: string): Promise<void> {
		pendingId = attachmentId;
		try {
			await onDelete(attachmentId);
		} finally {
			pendingId = null;
		}
	}
</script>

<div class="space-y-3">
	<div class="flex items-center justify-between">
		<span class="label">Photos</span>
		{#if !disabled}
			<button
				type="button"
				class="inline-flex items-center gap-1.5 rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-body-sm text-neutral-300 transition-colors hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
				onclick={() => fileInput?.click()}
				disabled={uploading}
			>
				<Upload size={14} />
				{uploading ? 'Uploading…' : 'Add Photo'}
			</button>
			<input
				bind:this={fileInput}
				type="file"
				accept="image/*"
				class="hidden"
				onchange={handleFileSelect}
			/>
		{/if}
	</div>

	{#if attachments.length === 0}
		<div
			class="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-neutral-700 py-8 text-neutral-500"
		>
			<ImageIcon size={28} strokeWidth={1.5} />
			<p class="text-body-sm">No photos yet</p>
		</div>
	{:else}
		<div class="grid grid-cols-3 gap-2 sm:grid-cols-4">
			{#each attachments as attachment (attachment.id)}
				<div
					class="group relative aspect-square overflow-hidden rounded-xl border border-neutral-700 bg-neutral-800"
				>
					{#if thumbnailUrls[attachment.id]}
						<img
							src={thumbnailUrls[attachment.id]}
							alt={attachment.title}
							class="h-full w-full object-cover"
						/>
					{:else}
						<div class="flex h-full w-full items-center justify-center">
							<ImageIcon class="text-neutral-600" size={24} strokeWidth={1} />
						</div>
					{/if}

					{#if attachment.primary}
						<div class="absolute left-1 top-1 rounded-full bg-primary-600 p-1">
							<Star size={12} class="fill-current text-white" />
						</div>
					{/if}

					{#if !disabled}
						<div
							class="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-neutral-950/70 p-1 opacity-0 transition-opacity group-hover:opacity-100"
						>
							{#if !attachment.primary}
								<button
									type="button"
									class="min-h-touch min-w-touch rounded-lg p-1.5 text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-warning-400 disabled:cursor-not-allowed disabled:opacity-50"
									onclick={() => handleSetPrimary(attachment.id)}
									disabled={pendingId === attachment.id}
									aria-label="Set as primary photo"
									title="Set as primary photo"
								>
									<Star size={16} />
								</button>
							{/if}
							<button
								type="button"
								class="hover:text-error-400 min-h-touch min-w-touch rounded-lg p-1.5 text-neutral-300 transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
								onclick={() => handleDelete(attachment.id)}
								disabled={pendingId === attachment.id}
								aria-label="Delete photo"
								title="Delete photo"
							>
								<Trash2 size={16} />
							</button>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
