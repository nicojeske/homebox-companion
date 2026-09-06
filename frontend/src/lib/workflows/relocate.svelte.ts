/**
 * Relocate Workflow — state management for the Move Items feature.
 *
 * Flow:
 *   1. User scans a location QR → setTargetLocation() stores destination
 *   2. User scans an item QR   → processItemScan() fetches item, updates locationId,
 *                                 prepends a MoveLogEntry with previous location
 *   3. User taps Undo          → undoMove() reverts item to its previous location
 *
 * The move log and destination are persisted to IndexedDB after every mutation
 * (see `relocatePersistence.ts`) so a reload doesn't lose the session - call
 * `restoreSession()` once on page mount to load it back in.
 */

import { items } from '$lib/api/items';
import { showToast } from '$lib/stores/ui.svelte';
import { createLogger } from '$lib/utils/logger';
import * as relocatePersistence from '$lib/services/relocatePersistence';

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

	/** When `targetLocation` was last set - drives the 1-hour restore window (not reactive UI state). */
	private targetLocationSetAt: number | null = null;

	// ---------------------------------------------------------------------------
	// PERSISTENCE
	// ---------------------------------------------------------------------------

	/** Persist the current state. Never throws - failures are logged and ignored. */
	private async persist(): Promise<void> {
		await relocatePersistence.save({
			// Deep-unwrap $state proxies (not structured-cloneable by IndexedDB directly)
			moveLog: JSON.parse(
				JSON.stringify(this.moveLog.map((e) => ({ ...e, movedAt: e.movedAt.getTime() })))
			),
			targetLocation: this.targetLocation ? { ...this.targetLocation } : null,
			targetLocationPath: [...this.targetLocationPath],
			targetLocationSetAt: this.targetLocationSetAt,
		});
	}

	/**
	 * Load a previously-persisted session (move log + possibly the destination).
	 * Call once, on page mount - calling it after scans have already happened
	 * this page-lifetime would overwrite them, since it replaces rather than merges.
	 */
	async restoreSession(): Promise<void> {
		const restored = await relocatePersistence.restore();
		if (!restored) return;

		this.moveLog = restored.moveLog.map((e) => ({ ...e, movedAt: new Date(e.movedAt) }));

		if (restored.targetLocation) {
			this.targetLocation = restored.targetLocation;
			this.targetLocationPath = restored.targetLocationPath;
			// Preserve the original set time - substituting Date.now() here would
			// silently re-arm the destination for another hour on every reload.
			this.targetLocationSetAt = restored.targetLocationSetAt;
		}

		log.info(`Restored relocate session: ${this.moveLog.length} log entries`);
	}

	// ---------------------------------------------------------------------------
	// LOCATION
	// ---------------------------------------------------------------------------

	setTargetLocation(id: string, name: string, path: string[] = []): void {
		this.targetLocation = { id, name };
		this.targetLocationPath = path;
		this.targetLocationSetAt = Date.now();
		this.error = null;
		log.info(`Target location set: ${name} (${id})`);
		void this.persist();
	}

	clearTargetLocation(): void {
		this.targetLocation = null;
		this.targetLocationPath = [];
		this.targetLocationSetAt = null;
		void this.persist();
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
			void this.persist();

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
			void this.persist();

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
		void this.persist();
	}

	/** Reset everything (location + log). */
	clearAll(): void {
		this.targetLocation = null;
		this.targetLocationPath = [];
		this.targetLocationSetAt = null;
		this.moveLog = [];
		this.error = null;
		void relocatePersistence.clear();
	}
}

// =============================================================================
// SINGLETON EXPORT
// =============================================================================

export const relocateWorkflow = new RelocateWorkflow();
