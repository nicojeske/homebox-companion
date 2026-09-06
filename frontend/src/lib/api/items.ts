/**
 * Items API endpoints
 */

import { request, requestFormData, requestBlobUrl, type BlobUrlResult } from './client';
import { apiLogger as log } from '../utils/logger';
import type {
	BatchCreateRequest,
	BatchCreateResponse,
	ItemDetail,
	ItemListResponse,
	ItemSummary,
} from '../types';

export type { BlobUrlResult };

export interface CreateOptions {
	signal?: AbortSignal;
}

export interface UploadOptions {
	signal?: AbortSignal;
}

export interface SearchOptions {
	/** Free-text search query */
	q?: string;
	/** Filter to items directly inside this location */
	locationId?: string;
	/** Filter to items carrying any of these tag IDs */
	tagIds?: string[];
	/** 1-indexed page number */
	page?: number;
	/** Items per page */
	pageSize?: number;
	signal?: AbortSignal;
}

/** Build a `?a=1&b=2` query string, omitting undefined/empty values. */
function buildQueryString(params: Record<string, string | number | undefined>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== '') search.set(key, String(value));
	}
	const qs = search.toString();
	return qs ? `?${qs}` : '';
}

export interface ItemUpdateData {
	assetId?: string | null;
	name?: string;
	description?: string;
	locationId?: string | null;
	parentId?: string | null;
	quantity?: number;
	insured?: boolean;
	archived?: boolean;
	tagIds?: string[] | null;
	manufacturer?: string | null;
	modelNumber?: string | null;
	serialNumber?: string | null;
	purchasePrice?: number | null;
	purchaseFrom?: string | null;
	notes?: string | null;
	/** Custom fields keyed by display name; null (or '') removes that field. */
	fields?: Record<string, string | null>;
}

/**
 * Simple item details for QR code lookups (Move Items feature).
 *
 * Renamed from `ItemDetail` (M2) to free that name for the richer `ItemDetail`
 * type in `$lib/types` returned by `GET /items/{id}` (the detail/edit page).
 */
export interface ItemQrLookupResult {
	id: string;
	name: string;
	assetId: string | null;
	thumbnailId: string | null;
	locationId: string | null;
	locationName: string | null;
}

export const items = {
	/**
	 * List items in a location (lightweight, for pickers).
	 * Unwraps the paginated envelope for backward-compatible callers.
	 */
	list: (locationId?: string, signal?: AbortSignal): Promise<ItemSummary[]> =>
		request<ItemListResponse>(`/items${locationId ? `?location_id=${locationId}` : ''}`, {
			signal,
		}).then((res) => res.items),

	/**
	 * Search items with free-text query, location/tag filters, and pagination.
	 * Used by the browse page. Returns the full paginated envelope.
	 */
	search: (options: SearchOptions = {}) => {
		const query = buildQueryString({
			q: options.q,
			location_id: options.locationId,
			tag_ids: options.tagIds?.length ? options.tagIds.join(',') : undefined,
			page: options.page,
			page_size: options.pageSize,
		});
		return request<ItemListResponse>(`/items${query}`, { signal: options.signal });
	},

	create: (data: BatchCreateRequest, options: CreateOptions = {}) =>
		request<BatchCreateResponse>('/items', {
			method: 'POST',
			body: JSON.stringify(data),
			signal: options.signal,
		}),

	/**
	 * Update an existing item.
	 * Used to set asset ID after creation (since asset ID cannot be set during creation).
	 */
	update: (itemId: string, data: ItemUpdateData, signal?: AbortSignal) => {
		log.debug(`Updating item ${itemId}:`, data);
		return request<unknown>(`/items/${itemId}`, {
			method: 'PUT',
			body: JSON.stringify(data),
			signal,
		});
	},

	uploadAttachment: (itemId: string, file: File, options: UploadOptions = {}) => {
		// Log file details for diagnostics - helps identify empty/corrupted uploads
		log.debug(`Uploading attachment: item=${itemId}, file="${file.name}", size=${file.size} bytes`);
		if (file.size === 0) {
			log.warn(`Empty file being uploaded to item ${itemId}: ${file.name}`);
		} else if (file.size < 1000) {
			log.warn(
				`Suspiciously small file being uploaded to item ${itemId}: ${file.name} (${file.size} bytes)`
			);
		}

		const formData = new FormData();
		formData.append('file', file);
		return requestFormData<unknown>(`/items/${itemId}/attachments`, formData, {
			errorMessage: 'Failed to upload attachment',
			signal: options.signal,
		});
	},

	/**
	 * Fetch a thumbnail image and return a blob URL with cleanup function.
	 *
	 * IMPORTANT: Call `result.revoke()` when done to avoid memory leaks.
	 *
	 * @throws {ApiError} When the server returns a non-OK response (e.g., 404 for missing thumbnail)
	 * @throws {NetworkError} When a network-level error occurs (connection, DNS, timeout)
	 */
	getThumbnail: (
		itemId: string,
		attachmentId: string,
		signal?: AbortSignal
	): Promise<BlobUrlResult> =>
		requestBlobUrl(`/items/${itemId}/attachments/${attachmentId}`, signal),

	/**
	 * Fetch a single item by its Homebox asset ID.
	 * Used by the Move Items feature to resolve scanned QR codes to item details.
	 */
	getByAssetId: (assetId: string, signal?: AbortSignal) =>
		request<ItemQrLookupResult>(`/items/by-asset-id/${encodeURIComponent(assetId)}`, { signal }),

	/**
	 * Fetch full item details for the item detail/edit page.
	 */
	get: (itemId: string, signal?: AbortSignal) =>
		request<ItemDetail>(`/items/${itemId}`, { signal }),

	/**
	 * Delete an item from Homebox.
	 * Used for cleanup when item creation succeeds but attachment upload fails.
	 */
	delete: (itemId: string, signal?: AbortSignal) => {
		log.debug(`Deleting item: ${itemId}`);
		return request<{ message: string }>(`/items/${itemId}`, {
			method: 'DELETE',
			signal,
		});
	},

	/**
	 * Set (or unset) an attachment as the item's primary photo, optionally renaming it.
	 */
	setPrimaryAttachment: (
		itemId: string,
		attachmentId: string,
		primary: boolean,
		title?: string,
		signal?: AbortSignal
	) =>
		request<unknown>(`/items/${itemId}/attachments/${attachmentId}`, {
			method: 'PUT',
			body: JSON.stringify({ primary, title }),
			signal,
		}),

	/**
	 * Delete an attachment from an item.
	 */
	deleteAttachment: (itemId: string, attachmentId: string, signal?: AbortSignal) => {
		log.debug(`Deleting attachment ${attachmentId} from item ${itemId}`);
		return request<{ message: string }>(`/items/${itemId}/attachments/${attachmentId}`, {
			method: 'DELETE',
			signal,
		});
	},

	/**
	 * Trigger server-side label printing for an item.
	 * Requires HBOX_LABEL_MAKER_PRINT_COMMAND to be configured on the Homebox server.
	 */
	printLabel: (itemId: string, signal?: AbortSignal) => {
		log.debug(`Printing label for item: ${itemId}`);
		return request<{ message: string }>(`/items/${itemId}/print-label`, {
			method: 'POST',
			signal,
		});
	},
};
