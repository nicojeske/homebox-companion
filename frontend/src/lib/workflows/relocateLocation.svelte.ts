/**
 * Relocate Location Workflow — state management for the Move Locations feature.
 *
 * Flow:
 *   1. User scans a location QR → setTargetLocation() stores destination (sticky)
 *   2. User scans another location QR → processLocationScan() fetches the location,
 *                                        reparents it under the destination, and
 *                                        prepends a LocationMoveLogEntry with the
 *                                        previous parent for undo
 *   3. User taps Undo               → undoMove() reverts the location to its
 *                                        previous parent
 *
 * The move log and destination are persisted to IndexedDB after every mutation
 * (see `relocateLocationPersistence.ts`) so a reload doesn't lose the session -
 * call `restoreSession()` once on page mount to load it back in.
 */

import { locations } from '$lib/api/locations';
import { locationStore } from '$lib/stores/locations.svelte';
import { showToast } from '$lib/stores/ui.svelte';
import { createLogger } from '$lib/utils/logger';
import type { LocationTreeNode } from '$lib/types';
import * as relocateLocationPersistence from '$lib/services/relocateLocationPersistence';

const log = createLogger({ prefix: 'RelocateLocationWorkflow' });

// =============================================================================
// TYPES
// =============================================================================

export interface LocationMoveLogEntry {
	locationId: string;
	locationName: string;
	previousParentId: string | null;
	previousParentName: string | null;
	targetLocationId: string;
	targetLocationName: string;
	movedAt: Date;
	/** True after a successful undo */
	undone: boolean;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Does `candidateId` appear anywhere in the subtree rooted at `ancestorId`
 * (including `ancestorId` itself)? Used to reject moving a location under one
 * of its own descendants (a cycle) before calling the API.
 */
function isDescendantOf(
	nodes: LocationTreeNode[],
	ancestorId: string,
	candidateId: string
): boolean {
	function containsId(node: LocationTreeNode, id: string): boolean {
		if (node.id === id) return true;
		return ((node.children ?? []) as LocationTreeNode[]).some((child) => containsId(child, id));
	}

	function findNode(list: LocationTreeNode[], id: string): LocationTreeNode | null {
		for (const node of list) {
			if (node.id === id) return node;
			const found = findNode((node.children ?? []) as LocationTreeNode[], id);
			if (found) return found;
		}
		return null;
	}

	const ancestor = findNode(nodes, ancestorId);
	if (!ancestor) return false;
	return containsId(ancestor, candidateId);
}

// =============================================================================
// WORKFLOW CLASS
// =============================================================================

class RelocateLocationWorkflow {
	/** The destination location for the next location scan(s). Null until a location is scanned. */
	targetLocation = $state<{ id: string; name: string } | null>(null);

	/** Ancestor names for the target location, ordered from root to immediate parent. */
	targetLocationPath = $state<string[]>([]);

	/** Session move log, newest entry first. */
	moveLog = $state<LocationMoveLogEntry[]>([]);

	/** True while a location fetch/update API call is in flight. */
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
		await relocateLocationPersistence.save({
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
		const restored = await relocateLocationPersistence.restore();
		if (!restored) return;

		this.moveLog = restored.moveLog.map((e) => ({ ...e, movedAt: new Date(e.movedAt) }));

		if (restored.targetLocation) {
			this.targetLocation = restored.targetLocation;
			this.targetLocationPath = restored.targetLocationPath;
			// Preserve the original set time - substituting Date.now() here would
			// silently re-arm the destination for another hour on every reload.
			this.targetLocationSetAt = restored.targetLocationSetAt;
		}

		log.info(`Restored relocate-location session: ${this.moveLog.length} log entries`);
	}

	// ---------------------------------------------------------------------------
	// DESTINATION
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
	// LOCATION SCAN → REPARENT
	// ---------------------------------------------------------------------------

	/**
	 * Look up the scanned location, reparent it under the current destination,
	 * and append a log entry. Shows a success or error toast.
	 */
	async processLocationScan(locationId: string): Promise<void> {
		if (!this.targetLocation) {
			showToast('Scan a location QR code first to set the destination.', 'warning');
			return;
		}

		if (locationId === this.targetLocation.id) {
			showToast('A location can\'t be moved into itself.', 'warning');
			return;
		}

		if (this.processing) return;

		this.processing = true;
		this.error = null;

		try {
			log.info(`Processing location scan: locationId=${locationId}`);

			// 1. Cycle guard: reject if the destination lives inside the location
			//    being moved (would make the location its own ancestor).
			const tree = (await locations.tree()) as LocationTreeNode[];
			if (isDescendantOf(tree, locationId, this.targetLocation.id)) {
				showToast(
					"Can't move a location into one of its own children.",
					'warning'
				);
				return;
			}

			// 2. Fetch location details (for name/description to resend on the PUT)
			const loc = await locations.get(locationId);

			// The tree, not the GET response, is the source of truth for "current
			// parent" - Homebox's raw entity JSON shape for a location's own parent
			// field isn't reliable to depend on, but the tree structure is.
			const previousParentId = findParentId(tree, locationId);

			// 3. Guard: skip if already under the target location
			if (previousParentId === this.targetLocation.id) {
				showToast(`"${loc.name}" is already in ${this.targetLocation.name}.`, 'info');
				return;
			}

			const previousParentName = previousParentId
				? (findNodeName(tree, previousParentId) ?? null)
				: null;

			// 4. Update parent
			await locations.update(locationId, {
				name: loc.name,
				description: loc.description,
				parent_id: this.targetLocation.id,
			});

			// 5. Prepend to log (newest first)
			const entry: LocationMoveLogEntry = {
				locationId: loc.id,
				locationName: loc.name,
				previousParentId,
				previousParentName,
				targetLocationId: this.targetLocation.id,
				targetLocationName: this.targetLocation.name,
				movedAt: new Date(),
				undone: false,
			};
			this.moveLog = [entry, ...this.moveLog];
			void this.persist();

			// 6. Refresh the shared location tree cache so other screens
			//    (location picker, browse) don't show a stale hierarchy.
			await this.refreshLocationStore();

			showToast(`Moved "${loc.name}" to ${this.targetLocation.name}.`, 'success');
			log.info(`Moved location ${loc.name} (${loc.id}) → ${this.targetLocation.name}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.error('Failed to process location scan:', err);
			this.error = msg;
			showToast(`Failed to move location: ${msg}`, 'error');
		} finally {
			this.processing = false;
		}
	}

	// ---------------------------------------------------------------------------
	// UNDO
	// ---------------------------------------------------------------------------

	/**
	 * Revert a move by restoring the location's previous parent.
	 * @param index Index into `moveLog` (0 = most recent).
	 */
	async undoMove(index: number): Promise<void> {
		const entry = this.moveLog[index];
		if (!entry || entry.undone) return;

		this.processing = true;
		this.error = null;

		try {
			log.info(`Undoing move for ${entry.locationName} (${entry.locationId})`);

			// Homebox's update is a full replace, so re-fetch current name/description
			// rather than trusting a stale snapshot from when the move happened.
			const loc = await locations.get(entry.locationId);
			await locations.update(entry.locationId, {
				name: loc.name,
				description: loc.description,
				parent_id: entry.previousParentId,
			});

			// Mark as undone (immutable update)
			this.moveLog = this.moveLog.map((e, i) => (i === index ? { ...e, undone: true } : e));
			void this.persist();

			await this.refreshLocationStore();

			const dest = entry.previousParentName ?? 'top level';
			showToast(`Moved "${entry.locationName}" back to ${dest}.`, 'success');
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
	// CACHE INVALIDATION
	// ---------------------------------------------------------------------------

	private async refreshLocationStore(): Promise<void> {
		try {
			const tree = (await locations.tree()) as LocationTreeNode[];
			locationStore.setTree(tree);
			locationStore.setFlatList(tree);
		} catch (err) {
			log.warn('Failed to refresh location tree cache after move:', err);
		}
	}

	// ---------------------------------------------------------------------------
	// RESET
	// ---------------------------------------------------------------------------

	clearLog(): void {
		this.moveLog = [];
		void this.persist();
	}

	/** Reset everything (destination + log). */
	clearAll(): void {
		this.targetLocation = null;
		this.targetLocationPath = [];
		this.targetLocationSetAt = null;
		this.moveLog = [];
		this.error = null;
		void relocateLocationPersistence.clear();
	}
}

/** Find a node's name by id anywhere in the tree (used to label the previous parent). */
function findNodeName(nodes: LocationTreeNode[], id: string): string | null {
	for (const node of nodes) {
		if (node.id === id) return node.name;
		const found = findNodeName((node.children ?? []) as LocationTreeNode[], id);
		if (found !== null) return found;
	}
	return null;
}

/**
 * Find the id of the node whose children contain `id` (null if `id` is top-level
 * or not found). Used instead of trusting a `parentId`-shaped field on the raw
 * `locations.get()` response, since the tree structure is the reliable source
 * of truth for "current parent".
 */
function findParentId(nodes: LocationTreeNode[], id: string, parentId: string | null = null): string | null {
	for (const node of nodes) {
		if (node.id === id) return parentId;
		const found = findParentId((node.children ?? []) as LocationTreeNode[], id, node.id);
		if (found !== null) return found;
	}
	return null;
}

// =============================================================================
// SINGLETON EXPORT
// =============================================================================

export const relocateLocationWorkflow = new RelocateLocationWorkflow();
