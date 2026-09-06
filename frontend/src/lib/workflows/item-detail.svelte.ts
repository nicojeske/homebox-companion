/**
 * ItemDetailWorkflow — state management for the /items/[id] detail/edit page.
 *
 * Owns the loaded item snapshot, its custom field definitions, and the
 * view/edit mode. The editable draft itself is page-local `$state` (synced
 * from `item` + `customFieldDefs` via `draftFromItem()` when edit mode
 * starts) — the same pattern the review page uses for `editedItem` — so the
 * shared form components' `bind:` props never mutate workflow state
 * directly; `save()` takes the draft as a parameter and diffs it itself.
 *
 * `save()` sends only the fields that actually changed (`diffItem`). With no
 * ETag/versioning support in Homebox, the fetch-then-merge PUT means two open
 * edit sessions on the same item can still clobber each other, but diffing
 * shrinks the window to genuinely conflicting fields rather than the whole
 * record.
 */
import { items as itemsApi } from '$lib/api/items';
import { customFields as customFieldsApi, type CustomFieldDefinition } from '$lib/api/settings';
import { showToast } from '$lib/stores/ui.svelte';
import { createLogger } from '$lib/utils/logger';
import { diffItem, type ItemDraft } from '$lib/utils/itemDiff';
import type { ItemDetail } from '$lib/types';

const log = createLogger({ prefix: 'ItemDetailWorkflow' });

export type ItemDetailMode = 'view' | 'edit';

class ItemDetailWorkflow {
	// =========================================================================
	// STATE
	// =========================================================================

	private _item = $state<ItemDetail | null>(null);
	private _customFieldDefs = $state<CustomFieldDefinition[]>([]);
	private _mode = $state<ItemDetailMode>('view');

	private _isLoading = $state(false);
	private _isSaving = $state(false);
	private _error = $state<string | null>(null);

	/** Monotonic token to discard stale responses from superseded loads (e.g. rapid back/forward). */
	private _loadToken = 0;

	// =========================================================================
	// GETTERS
	// =========================================================================

	get item(): ItemDetail | null {
		return this._item;
	}

	get customFieldDefs(): CustomFieldDefinition[] {
		return this._customFieldDefs;
	}

	get mode(): ItemDetailMode {
		return this._mode;
	}

	get isLoading(): boolean {
		return this._isLoading;
	}

	get isSaving(): boolean {
		return this._isSaving;
	}

	get error(): string | null {
		return this._error;
	}

	// =========================================================================
	// LOAD
	// =========================================================================

	async load(itemId: string): Promise<void> {
		const token = ++this._loadToken;
		this._isLoading = true;
		this._error = null;

		try {
			const [item, defs] = await Promise.all([
				itemsApi.get(itemId),
				customFieldsApi.list().catch((error) => {
					log.warn(
						'Failed to load custom field definitions, editor will show item fields only',
						error
					);
					return [] as CustomFieldDefinition[];
				}),
			]);

			if (token !== this._loadToken) return; // A newer load superseded this one

			this._item = item;
			this._customFieldDefs = defs;
			this._mode = 'view';
		} catch (error) {
			if (token !== this._loadToken) return;
			log.error('Failed to load item', error);
			this._error = 'Failed to load item';
		} finally {
			if (token === this._loadToken) this._isLoading = false;
		}
	}

	/** Re-fetch the current item after a mutation (save/move/attachment change). */
	private async refresh(): Promise<void> {
		if (!this._item) return;
		this._item = await itemsApi.get(this._item.id);
	}

	// =========================================================================
	// EDIT MODE
	// =========================================================================

	startEdit(): void {
		if (!this._item) return;
		this._mode = 'edit';
	}

	cancelEdit(): void {
		this._mode = 'view';
	}

	/** Diff `draft` against the loaded snapshot and PUT only what changed. */
	async save(draft: ItemDraft): Promise<boolean> {
		if (!this._item) return false;

		const changes = diffItem(this._item, draft);
		if (Object.keys(changes).length === 0) {
			this._mode = 'view';
			return true;
		}

		this._isSaving = true;
		this._error = null;
		try {
			await itemsApi.update(this._item.id, changes);
			await this.refresh();
			this._mode = 'view';
			showToast('Item saved', 'success');
			return true;
		} catch (error) {
			log.error('Failed to save item', error);
			this._error = 'Failed to save item';
			showToast('Failed to save item', 'error');
			return false;
		} finally {
			this._isSaving = false;
		}
	}

	// =========================================================================
	// ACTIONS
	// =========================================================================

	/** Move to a different location — the same single-field PUT relocateWorkflow makes. */
	async moveTo(locationId: string | null, locationName?: string): Promise<boolean> {
		if (!this._item) return false;

		this._isSaving = true;
		this._error = null;
		try {
			await itemsApi.update(this._item.id, { locationId });
			await this.refresh();
			showToast(locationName ? `Moved to ${locationName}` : 'Item moved', 'success');
			return true;
		} catch (error) {
			log.error('Failed to move item', error);
			showToast('Failed to move item', 'error');
			return false;
		} finally {
			this._isSaving = false;
		}
	}

	async printLabel(): Promise<boolean> {
		if (!this._item) return false;
		try {
			await itemsApi.printLabel(this._item.id);
			showToast('Label sent to printer', 'success');
			return true;
		} catch (error) {
			log.error('Failed to print label', error);
			showToast('Failed to print label', 'error');
			return false;
		}
	}

	/** Delete the item permanently. Caller is responsible for navigating away on success. */
	async deleteItemPermanently(): Promise<boolean> {
		if (!this._item) return false;
		try {
			await itemsApi.delete(this._item.id);
			showToast('Item deleted', 'success');
			return true;
		} catch (error) {
			log.error('Failed to delete item', error);
			showToast('Failed to delete item', 'error');
			return false;
		}
	}

	// =========================================================================
	// ATTACHMENTS
	// =========================================================================

	async uploadAttachment(file: File): Promise<boolean> {
		if (!this._item) return false;
		try {
			await itemsApi.uploadAttachment(this._item.id, file);
			await this.refresh();
			return true;
		} catch (error) {
			log.error('Failed to upload attachment', error);
			showToast('Failed to upload photo', 'error');
			return false;
		}
	}

	async setPrimaryAttachment(attachmentId: string): Promise<boolean> {
		if (!this._item) return false;
		try {
			await itemsApi.setPrimaryAttachment(this._item.id, attachmentId, true);
			await this.refresh();
			return true;
		} catch (error) {
			log.error('Failed to set primary attachment', error);
			showToast('Failed to set primary photo', 'error');
			return false;
		}
	}

	async deleteAttachment(attachmentId: string): Promise<boolean> {
		if (!this._item) return false;
		try {
			await itemsApi.deleteAttachment(this._item.id, attachmentId);
			await this.refresh();
			return true;
		} catch (error) {
			log.error('Failed to delete attachment', error);
			showToast('Failed to delete photo', 'error');
			return false;
		}
	}

	// =========================================================================
	// RESET
	// =========================================================================

	/** Clear all state — call when leaving the detail page. */
	reset(): void {
		this._loadToken++; // Invalidate any in-flight load
		this._item = null;
		this._customFieldDefs = [];
		this._mode = 'view';
		this._isLoading = false;
		this._isSaving = false;
		this._error = null;
	}
}

// =============================================================================
// SINGLETON EXPORT
// =============================================================================

export const itemDetailWorkflow = new ItemDetailWorkflow();
