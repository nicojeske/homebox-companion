/**
 * BrowseWorkflow - Unified search across items, locations, and tags
 *
 * Owns the /browse page's search query, filters, and paginated item results.
 * Location/tag matches are derived from the already-cached locationStore/tagStore
 * (populated via ensureAuxData()) rather than fetched separately.
 */
import { items as itemsApi } from '$lib/api';
import { locationNavigator } from '$lib/services/locationNavigator.svelte';
import { locationStore, type FlatLocation } from '$lib/stores/locations.svelte';
import { tagStore } from '$lib/stores/tags.svelte';
import { showToast } from '$lib/stores/ui.svelte';
import { createLogger } from '$lib/utils/logger';
import { parseScannedCode } from '$lib/utils/scanCode';
import type { ItemSearchResult, Tag } from '$lib/types';

const log = createLogger({ prefix: 'Browse' });

/** Items fetched per page. */
export const PAGE_SIZE = 30;
/** Max location/tag matches shown per section (items carry the full pagination). */
const MAX_AUX_MATCHES = 8;

class BrowseWorkflow {
	// =========================================================================
	// STATE
	// =========================================================================

	private _query = $state('');
	private _locationFilter = $state<{ id: string; name: string } | null>(null);
	private _tagFilter = $state<{ id: string; name: string } | null>(null);

	private _items = $state<ItemSearchResult[]>([]);
	private _page = $state(1);
	private _total = $state(0);

	/**
	 * The `q` param the last successful `search()` actually used - either the raw
	 * query, or `#<assetId>` when the query was recognized as an asset tag
	 * (see `_resolveSearchQuery`). `loadMore()` must page with this, not `_query`
	 * directly, or later pages would silently fall back to a text search.
	 */
	private _effectiveQuery: string | undefined = undefined;

	private _isLoading = $state(false);
	private _isLoadingMore = $state(false);
	private _error = $state<string | null>(null);

	private _auxLoaded = false;

	/** Monotonic token to discard stale responses from superseded searches. */
	private _searchToken = 0;

	// =========================================================================
	// GETTERS
	// =========================================================================

	get query(): string {
		return this._query;
	}

	get locationFilter(): { id: string; name: string } | null {
		return this._locationFilter;
	}

	get tagFilter(): { id: string; name: string } | null {
		return this._tagFilter;
	}

	get items(): ItemSearchResult[] {
		return this._items;
	}

	get total(): number {
		return this._total;
	}

	get isLoading(): boolean {
		return this._isLoading;
	}

	get isLoadingMore(): boolean {
		return this._isLoadingMore;
	}

	get error(): string | null {
		return this._error;
	}

	get hasMore(): boolean {
		return this._items.length < this._total;
	}

	get hasSearched(): boolean {
		return (
			this._query.trim().length > 0 || this._locationFilter !== null || this._tagFilter !== null
		);
	}

	/** Locations whose name matches the current query (search-as-you-type). */
	get matchingLocations(): FlatLocation[] {
		const q = this._query.trim().toLowerCase();
		if (!q) return [];
		return locationStore.flatList
			.filter((f) => f.location.name.toLowerCase().includes(q))
			.slice(0, MAX_AUX_MATCHES);
	}

	/** Tags whose name matches the current query (search-as-you-type). */
	get matchingTags(): Tag[] {
		const q = this._query.trim().toLowerCase();
		if (!q) return [];
		return tagStore.tags.filter((t) => t.name.toLowerCase().includes(q)).slice(0, MAX_AUX_MATCHES);
	}

	// =========================================================================
	// SETUP
	// =========================================================================

	/** Load the location tree and tag list once, so aux matches have data to filter. */
	async ensureAuxData(): Promise<void> {
		if (this._auxLoaded) return;
		this._auxLoaded = true;
		try {
			await Promise.all([
				locationStore.flatList.length > 0 ? Promise.resolve() : locationNavigator.loadTree(),
				tagStore.fetchTags(),
			]);
		} catch (error) {
			log.warn('Failed to load aux search data (locations/tags)', error);
			// Non-fatal - item search still works without location/tag matches
		}
	}

	// =========================================================================
	// FILTERS
	// =========================================================================

	setQuery(query: string): void {
		this._query = query;
	}

	setLocationFilter(filter: { id: string; name: string } | null): void {
		this._locationFilter = filter;
	}

	setTagFilter(filter: { id: string; name: string } | null): void {
		this._tagFilter = filter;
	}

	clearFilters(): void {
		this._locationFilter = null;
		this._tagFilter = null;
	}

	// =========================================================================
	// SEARCH
	// =========================================================================

	/**
	 * Resolve the raw query box text into the `q` param to actually send.
	 *
	 * A query recognized as an asset tag (`a1110`, `001-110`, a scanned
	 * `/a/000-085` URL, ...) is rewritten to Homebox's own `#<assetId>`
	 * asset-search syntax so the backend does an exact asset lookup instead of
	 * a text match on the literal scanned string. Anything else - including a
	 * bare number with no dash, which stays a plain search - passes through
	 * unchanged.
	 */
	private _resolveSearchQuery(raw: string): { param: string | undefined; isAssetLookup: boolean } {
		if (!raw) return { param: undefined, isAssetLookup: false };
		const parsed = parseScannedCode(raw);
		if (parsed.kind === 'asset') {
			return { param: `#${parsed.assetId}`, isAssetLookup: true };
		}
		return { param: raw, isAssetLookup: false };
	}

	/** Run a fresh search (page 1), discarding any in-flight results for a superseded query. */
	async search(): Promise<void> {
		const token = ++this._searchToken;
		this._isLoading = true;
		this._error = null;

		const rawQuery = this._query.trim();
		const { param: initialParam, isAssetLookup } = this._resolveSearchQuery(rawQuery);
		let queryParam = initialParam;

		try {
			let response = await itemsApi.search({
				q: queryParam,
				locationId: this._locationFilter?.id,
				tagIds: this._tagFilter ? [this._tagFilter.id] : undefined,
				page: 1,
				pageSize: PAGE_SIZE,
			});

			if (token !== this._searchToken) return; // A newer search superseded this one

			// No item has that asset ID - fall back to a plain text search of what
			// was actually typed rather than showing a bare empty result for what
			// looked like a valid tag (e.g. a typo, or a tag from another install).
			if (isAssetLookup && response.total === 0) {
				queryParam = rawQuery || undefined;
				response = await itemsApi.search({
					q: queryParam,
					locationId: this._locationFilter?.id,
					tagIds: this._tagFilter ? [this._tagFilter.id] : undefined,
					page: 1,
					pageSize: PAGE_SIZE,
				});
				if (token !== this._searchToken) return;
			}

			this._effectiveQuery = queryParam;
			this._items = response.items;
			this._page = response.page;
			this._total = response.total;
		} catch (error) {
			if (token !== this._searchToken) return;
			log.error('Search failed', error);
			this._error = 'Failed to search items';
			showToast('Failed to search items', 'error');
		} finally {
			if (token === this._searchToken) this._isLoading = false;
		}
	}

	/** Fetch the next page and append to the current results. */
	async loadMore(): Promise<void> {
		if (this._isLoadingMore || this._isLoading || !this.hasMore) return;

		const token = this._searchToken;
		this._isLoadingMore = true;

		try {
			const response = await itemsApi.search({
				// Page with whatever `search()` actually matched on (raw text, or the
				// `#assetId` rewrite) - not `_query` directly, which would silently
				// switch an asset lookup back to a text search from page 2 on.
				q: this._effectiveQuery,
				locationId: this._locationFilter?.id,
				tagIds: this._tagFilter ? [this._tagFilter.id] : undefined,
				page: this._page + 1,
				pageSize: PAGE_SIZE,
			});

			if (token !== this._searchToken) return;

			this._items = [...this._items, ...response.items];
			this._page = response.page;
			this._total = response.total;
		} catch (error) {
			if (token !== this._searchToken) return;
			log.error('Load more failed', error);
			showToast('Failed to load more items', 'error');
		} finally {
			if (token === this._searchToken) this._isLoadingMore = false;
		}
	}

	/** Reset all search state (query, filters, results). */
	reset(): void {
		this._searchToken++; // Invalidate any in-flight requests
		this._query = '';
		this._locationFilter = null;
		this._tagFilter = null;
		this._effectiveQuery = undefined;
		this._items = [];
		this._page = 1;
		this._total = 0;
		this._error = null;
		this._isLoading = false;
		this._isLoadingMore = false;
	}
}

// =============================================================================
// SINGLETON EXPORT
// =============================================================================

export const browseWorkflow = new BrowseWorkflow();
