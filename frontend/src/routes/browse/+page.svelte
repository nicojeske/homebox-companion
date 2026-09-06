<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Search, X, MapPin, Tag as TagIcon, Package, ExternalLink } from 'lucide-svelte';
	import AppContainer from '$lib/components/AppContainer.svelte';
	import PullToRefresh from '$lib/components/PullToRefresh.svelte';
	import Loader from '$lib/components/Loader.svelte';
	import Skeleton from '$lib/components/Skeleton.svelte';
	import { browseWorkflow } from '$lib/workflows/browse.svelte';
	import { items as itemsApi, type BlobUrlResult } from '$lib/api';
	import { getConfig } from '$lib/api/settings';
	import { routeGuards } from '$lib/utils/routeGuard';
	import { getInitPromise } from '$lib/services/tokenRefresh';
	import { createLogger } from '$lib/utils/logger';
	import type { ItemSearchResult } from '$lib/types';

	const log = createLogger({ prefix: 'BrowsePage' });

	let homeboxUrl = $state('');

	// Thumbnail blob URLs, keyed by item ID (revoked on destroy / when superseded)
	let thumbnailUrls = $state<Record<string, string>>({});
	let thumbnailRevokes: Record<string, () => void> = {};

	let searchInputEl: HTMLInputElement | undefined = $state();
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;

	onMount(async () => {
		await getInitPromise();
		if (!routeGuards.browse()) return;

		await browseWorkflow.ensureAuxData();

		try {
			const config = await getConfig();
			homeboxUrl = config.homebox_url;
		} catch (err) {
			log.debug('Failed to load config (Homebox deep links disabled):', err);
		}
	});

	onDestroy(() => {
		if (debounceTimer) clearTimeout(debounceTimer);
		for (const revoke of Object.values(thumbnailRevokes)) revoke();
	});

	function handleQueryInput(value: string): void {
		browseWorkflow.setQuery(value);
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			void browseWorkflow.search();
		}, 300);
	}

	function clearQuery(): void {
		if (debounceTimer) clearTimeout(debounceTimer);
		browseWorkflow.reset();
		searchInputEl?.focus();
	}

	function selectLocation(location: { id: string; name: string }): void {
		browseWorkflow.setLocationFilter(location);
		if (debounceTimer) clearTimeout(debounceTimer);
		void browseWorkflow.search();
	}

	function selectTag(tag: { id: string; name: string }): void {
		browseWorkflow.setTagFilter(tag);
		if (debounceTimer) clearTimeout(debounceTimer);
		void browseWorkflow.search();
	}

	function removeLocationFilter(): void {
		browseWorkflow.setLocationFilter(null);
		void browseWorkflow.search();
	}

	function removeTagFilter(): void {
		browseWorkflow.setTagFilter(null);
		void browseWorkflow.search();
	}

	async function handleRefresh(): Promise<void> {
		await browseWorkflow.search();
	}

	function openInHomebox(item: ItemSearchResult): void {
		if (!homeboxUrl) return;
		window.open(`${homeboxUrl}/item/${encodeURIComponent(item.id)}`, '_blank');
	}

	// Load thumbnails for any newly-seen items that have one
	$effect(() => {
		for (const item of browseWorkflow.items) {
			if (item.thumbnailId && !(item.id in thumbnailUrls)) {
				loadThumbnail(item.id, item.thumbnailId);
			}
		}
	});

	function loadThumbnail(itemId: string, thumbnailId: string): void {
		itemsApi
			.getThumbnail(itemId, thumbnailId)
			.then((result: BlobUrlResult) => {
				thumbnailRevokes[itemId]?.();
				thumbnailUrls = { ...thumbnailUrls, [itemId]: result.url };
				thumbnailRevokes[itemId] = result.revoke;
			})
			.catch((err) => {
				log.debug(`Failed to load thumbnail for item ${itemId}:`, err);
			});
	}
</script>

<AppContainer>
	<PullToRefresh onRefresh={handleRefresh}>
		<div class="flex min-h-screen flex-col gap-4 pb-24 pt-4">
			<!-- Header -->
			<div class="px-1">
				<h1 class="text-xl font-semibold text-neutral-100">Browse</h1>
				<p class="text-body-sm text-neutral-500">Search items, locations, and tags</p>
			</div>

			<!-- Search input -->
			<div class="px-1">
				<div class="relative">
					<div class="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
						<Search class="text-neutral-500" size={20} strokeWidth={1.5} />
					</div>
					<input
						bind:this={searchInputEl}
						type="text"
						placeholder="Search everything..."
						value={browseWorkflow.query}
						oninput={(e) => handleQueryInput(e.currentTarget.value)}
						class="input-with-icon"
					/>
					{#if browseWorkflow.query}
						<button
							type="button"
							onclick={clearQuery}
							class="absolute inset-y-0 right-0 flex items-center pr-3 text-neutral-500 hover:text-neutral-300"
							aria-label="Clear search"
						>
							<X size={18} strokeWidth={1.5} />
						</button>
					{/if}
				</div>
			</div>

			<!-- Active filter chips -->
			{#if browseWorkflow.locationFilter || browseWorkflow.tagFilter}
				<div class="flex flex-wrap gap-2 px-1">
					{#if browseWorkflow.locationFilter}
						<button
							type="button"
							onclick={removeLocationFilter}
							class="flex items-center gap-1.5 rounded-full border border-primary-500/30 bg-primary-500/10 px-3 py-1 text-xs font-medium text-primary-300 transition-colors hover:bg-primary-500/20"
						>
							<MapPin size={12} />
							{browseWorkflow.locationFilter.name}
							<X size={12} />
						</button>
					{/if}
					{#if browseWorkflow.tagFilter}
						<button
							type="button"
							onclick={removeTagFilter}
							class="flex items-center gap-1.5 rounded-full border border-primary-500/30 bg-primary-500/10 px-3 py-1 text-xs font-medium text-primary-300 transition-colors hover:bg-primary-500/20"
						>
							<TagIcon size={12} />
							{browseWorkflow.tagFilter.name}
							<X size={12} />
						</button>
					{/if}
				</div>
			{/if}

			<!-- Location matches -->
			{#if browseWorkflow.matchingLocations.length > 0}
				<div>
					<p class="mb-2 px-1 text-xs font-medium uppercase tracking-wider text-neutral-500">
						Locations
					</p>
					<div class="flex flex-wrap gap-2 px-1">
						{#each browseWorkflow.matchingLocations as flat (flat.location.id)}
							<button
								type="button"
								onclick={() => selectLocation({ id: flat.location.id, name: flat.location.name })}
								class="flex items-center gap-1.5 rounded-full border border-neutral-700 bg-neutral-800/60 px-3 py-1.5 text-xs text-neutral-300 transition-colors hover:border-neutral-600 hover:bg-neutral-700/50"
								title={flat.path}
							>
								<MapPin size={12} class="text-neutral-500" />
								{flat.displayName}
							</button>
						{/each}
					</div>
				</div>
			{/if}

			<!-- Tag matches -->
			{#if browseWorkflow.matchingTags.length > 0}
				<div>
					<p class="mb-2 px-1 text-xs font-medium uppercase tracking-wider text-neutral-500">
						Tags
					</p>
					<div class="flex flex-wrap gap-2 px-1">
						{#each browseWorkflow.matchingTags as tag (tag.id)}
							<button
								type="button"
								onclick={() => selectTag({ id: tag.id, name: tag.name })}
								class="flex items-center gap-1.5 rounded-full border border-neutral-700 bg-neutral-800/60 px-3 py-1.5 text-xs text-neutral-300 transition-colors hover:border-neutral-600 hover:bg-neutral-700/50"
							>
								<TagIcon size={12} class="text-neutral-500" />
								{tag.name}
							</button>
						{/each}
					</div>
				</div>
			{/if}

			<!-- Items -->
			<div>
				{#if browseWorkflow.items.length > 0}
					<p class="mb-2 px-1 text-xs font-medium uppercase tracking-wider text-neutral-500">
						Items
						{#if browseWorkflow.total > 0}
							<span class="text-neutral-600">({browseWorkflow.total})</span>
						{/if}
					</p>
				{/if}

				{#if browseWorkflow.isLoading && browseWorkflow.items.length === 0}
					<div class="flex flex-col gap-2">
						{#each Array(6) as _, i (i)}
							<div
								class="flex items-center gap-3 rounded-2xl border border-neutral-700 bg-neutral-800/60 p-3"
							>
								<Skeleton width="3.5rem" height="3.5rem" rounded="xl" />
								<div class="flex-1 space-y-2">
									<Skeleton width="60%" height="0.9rem" />
									<Skeleton width="40%" height="0.75rem" />
								</div>
							</div>
						{/each}
					</div>
				{:else if browseWorkflow.error}
					<div
						class="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-neutral-700 py-12 text-neutral-500"
					>
						<p class="text-sm">{browseWorkflow.error}</p>
					</div>
				{:else if browseWorkflow.items.length === 0}
					<div
						class="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-neutral-700 py-12 text-neutral-600"
					>
						<Package size={32} strokeWidth={1.5} />
						{#if browseWorkflow.hasSearched}
							<p class="text-sm">No items found.</p>
						{:else}
							<p class="text-sm">Search for an item, location, or tag.</p>
						{/if}
					</div>
				{:else}
					<ul class="flex flex-col gap-2">
						{#each browseWorkflow.items as item (item.id)}
							<li
								class="flex items-center gap-3 rounded-2xl border border-neutral-700 bg-neutral-800/60 p-3"
							>
								<!-- Thumbnail -->
								<div class="h-14 w-14 flex-shrink-0 overflow-hidden rounded-xl bg-neutral-700">
									{#if thumbnailUrls[item.id]}
										<img src={thumbnailUrls[item.id]} alt="" class="h-full w-full object-cover" />
									{:else}
										<div class="flex h-full w-full items-center justify-center">
											<Package class="text-neutral-500" size={24} strokeWidth={1} />
										</div>
									{/if}
								</div>

								<div class="min-w-0 flex-1">
									<button
										type="button"
										onclick={() => openInHomebox(item)}
										disabled={!homeboxUrl}
										class="flex min-w-0 items-center gap-1.5 text-left disabled:cursor-default"
										title={homeboxUrl ? 'Open in Homebox' : undefined}
									>
										<p
											class="truncate font-medium text-neutral-100 {homeboxUrl
												? 'hover:text-primary-300'
												: ''} transition-colors"
										>
											{item.name}
										</p>
										{#if homeboxUrl}
											<ExternalLink size={12} class="shrink-0 text-neutral-600" />
										{/if}
									</button>
									<p class="truncate text-body-sm text-neutral-500">
										Qty: {item.quantity}
										{#if item.location}
											· {item.location.name}
										{/if}
									</p>
									{#if item.tags.length > 0}
										<div class="mt-1 flex flex-wrap gap-1">
											{#each item.tags as tag (tag.id)}
												<button
													type="button"
													onclick={() => selectTag(tag)}
													class="rounded-full bg-neutral-700/50 px-2 py-0.5 text-[0.65rem] text-neutral-400 transition-colors hover:bg-neutral-700 hover:text-neutral-200"
												>
													{tag.name}
												</button>
											{/each}
										</div>
									{/if}
								</div>
							</li>
						{/each}
					</ul>

					{#if browseWorkflow.hasMore}
						<div class="mt-3 flex justify-center">
							<button
								type="button"
								onclick={() => browseWorkflow.loadMore()}
								disabled={browseWorkflow.isLoadingMore}
								class="rounded-lg bg-neutral-800 px-4 py-2 text-sm text-neutral-300 transition-colors hover:bg-neutral-700 disabled:opacity-50"
							>
								{#if browseWorkflow.isLoadingMore}
									<Loader size="sm" />
								{:else}
									Load more ({browseWorkflow.items.length} of {browseWorkflow.total})
								{/if}
							</button>
						</div>
					{/if}
				{/if}
			</div>
		</div>
	</PullToRefresh>
</AppContainer>
