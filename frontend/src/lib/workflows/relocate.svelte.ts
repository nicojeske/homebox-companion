/**
 * Relocate Workflow — state management for the Move Items feature.
 *
 * Flow:
 *   1. User scans a location QR → setTargetLocation() stores destination
 *   2. User scans an item QR   → processItemScan() fetches item, updates locationId,
 *                                 prepends a MoveLogEntry with previous location
 *   3. User taps Undo          → undoMove() reverts item to its previous location
 */

import { items } from '$lib/api/items';
import { showToast } from '$lib/stores/ui.svelte';
import { createLogger } from '$lib/utils/logger';

const log = createLogger({ prefix: 'RelocateWorkflow' });

// =============================================================================
// TYPES
// =============================================================================

export interface MoveLogEntry {
	/** Homebox item UUID */
	itemId: string;
	itemName: string;
	/** Homebox asset ID string, e.g. "000-042" */
	assetId: string;
	/** Attachment ID of the item's thumbnail, or null */
	thumbnailId: string | null;
	previousLocationId: string | null;
	previousLocationName: string | null;
	targetLocationId: string;
	targetLocationName: string;
	movedAt: Date;
	/** True after a successful undo */
	undone: boolean;
}

// =============================================================================
// WORKFLOW CLASS
// =============================================================================

class RelocateWorkflow {
	/** The destination location for the next item scan(s). Null until a location is scanned. */
	targetLocation = $state<{ id: string; name: string } | null>(null);

	/** Ancestor names for the target location, ordered from root to immediate parent. */
	targetLocationPath = $state<string[]>([]);

	/** Session move log, newest entry first. */
	moveLog = $state<MoveLogEntry[]>([]);

	/** True while an item fetch/update API call is in flight. */
	processing = $state(false);

	/** Last error message, cleared on the next successful operation. */
	error = $state<string | null>(null);

	// ---------------------------------------------------------------------------
	// LOCATION
	// ---------------------------------------------------------------------------

	setTargetLocation(id: string, name: string, path: string[] = []): void {
		this.targetLocation = { id, name };
		this.targetLocationPath = path;
		this.error = null;
		log.info(`Target location set: ${name} (${id})`);
	}

	clearTargetLocation(): void {
		this.targetLocation = null;
		this.targetLocationPath = [];
	}

	// ---------------------------------------------------------------------------
	// ITEM SCAN → MOVE
	// ---------------------------------------------------------------------------

	/**
	 * Look up the item by asset ID, update its location, and append a log entry.
	 * Shows a success or error toast.
	 */
	async processItemScan(assetId: string): Promise<void> {
		if (!this.targetLocation) {
			showToast('Scan a location QR code first to set the destination.', 'warning');
			return;
		}

		if (this.processing) return;

		this.processing = true;
		this.error = null;

		try {
			log.info(`Processing item scan: assetId=${assetId}`);

			// 1. Fetch item details (includes current location for undo)
			const item = await items.getByAssetId(assetId);

			// 2. Guard: skip if already at the target location
			if (item.locationId === this.targetLocation.id) {
				showToast(`"${item.name}" is already in ${this.targetLocation.name}.`, 'info');
				return;
			}

			// 3. Update location
			await items.update(item.id, { locationId: this.targetLocation.id });

			// 4. Prepend to log (newest first)
			const entry: MoveLogEntry = {
				itemId: item.id,
				itemName: item.name,
				assetId: item.assetId ?? assetId,
				thumbnailId: item.thumbnailId,
				previousLocationId: item.locationId,
				previousLocationName: item.locationName,
				targetLocationId: this.targetLocation.id,
				targetLocationName: this.targetLocation.name,
				movedAt: new Date(),
				undone: false,
			};
			this.moveLog = [entry, ...this.moveLog];

			showToast(`Moved "${item.name}" to ${this.targetLocation.name}.`, 'success');
			log.info(`Moved ${item.name} (${item.id}) → ${this.targetLocation.name}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.error('Failed to process item scan:', err);
			this.error = msg;
			showToast(`Failed to move item: ${msg}`, 'error');
		} finally {
			this.processing = false;
		}
	}

	// ---------------------------------------------------------------------------
	// UNDO
	// ---------------------------------------------------------------------------

	/**
	 * Revert a move by restoring the item's previous location.
	 * @param index Index into `moveLog` (0 = most recent).
	 */
	async undoMove(index: number): Promise<void> {
		const entry = this.moveLog[index];
		if (!entry || entry.undone) return;

		this.processing = true;
		this.error = null;

		try {
			log.info(`Undoing move for ${entry.itemName} (${entry.itemId})`);
			await items.update(entry.itemId, { locationId: entry.previousLocationId ?? null });

			// Mark as undone (immutable update)
			this.moveLog = this.moveLog.map((e, i) => (i === index ? { ...e, undone: true } : e));

			const dest = entry.previousLocationName ?? 'original location';
			showToast(`Moved "${entry.itemName}" back to ${dest}.`, 'success');
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.error('Undo failed:', err);
			this.error = msg;
			showToast(`Undo failed: ${msg}`, 'error');
		} finally {
			this.processing = false;
		}
	}

	// ---------------------------------------------------------------------------
	// RESET
	// ---------------------------------------------------------------------------

	clearLog(): void {
		this.moveLog = [];
	}

	/** Reset everything (location + log). */
	clearAll(): void {
		this.targetLocation = null;
		this.moveLog = [];
		this.error = null;
	}
}

// =============================================================================
// SINGLETON EXPORT
// =============================================================================

export const relocateWorkflow = new RelocateWorkflow();
