/**
 * Relocate Location Persistence Service
 *
 * IndexedDB-based persistence for the Move Locations move log, so it survives a
 * page reload instead of being lost. Mirrors `relocatePersistence.ts` (Move Items)
 * exactly, but as a SEPARATE database (`hbc-relocate-location`) rather than a
 * second object store in `hbc-relocate`: that database's `upgrade` handler deletes
 * and recreates its store on every version bump, which would wipe an in-flight
 * item-move session the next time either schema needs to change.
 *
 * Key design decisions (mirrors `relocatePersistence.ts`):
 * - Uses IndexedDB (via idb) - single-session pattern, one key only.
 * - TTL-based cleanup for the move log: entries older than 7 days are dropped.
 * - The target location is restored more conservatively (see `restore()`):
 *   a destination scanned long ago and silently re-armed on reload is a
 *   footgun - the next location scan would reparent something into a forgotten place.
 * - Explicit persistence: no $effect watchers, manual save() calls only,
 *   fired from the relocate-location workflow's own mutators.
 */

import { browser } from '$app/environment';
import { openDB, type IDBPDatabase } from 'idb';
import { createLogger } from '$lib/utils/logger';

const log = createLogger({ prefix: 'RelocateLocationPersistence' });

// =============================================================================
// CONSTANTS
// =============================================================================

const DB_NAME = 'hbc-relocate-location';
const DB_VERSION = 1;
const STORE_NAME = 'session';
const SESSION_KEY = 'current';

/** Move log TTL in milliseconds (7 days) - consistent with relocatePersistence.ts. */
const LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** How long a scanned destination stays armed for restoration (1 hour). */
const TARGET_LOCATION_TTL_MS = 60 * 60 * 1000;

// =============================================================================
// TYPES
// =============================================================================

/** Serializable version of LocationMoveLogEntry (Date -> epoch ms). */
export interface StoredLocationMoveLogEntry {
	locationId: string;
	locationName: string;
	locationDescription: string;
	previousParentId: string | null;
	previousParentName: string | null;
	targetLocationId: string;
	targetLocationName: string;
	/** Epoch ms - Date objects aren't structured-cloneable through the JSON round-trip used to unwrap $state proxies. */
	movedAt: number;
	undone: boolean;
}

export interface StoredRelocateLocationSession {
	/** When the log was first started - drives the 7-day TTL. */
	createdAt: number;
	/** When this record was last saved. */
	updatedAt: number;
	moveLog: StoredLocationMoveLogEntry[];
	targetLocation: { id: string; name: string } | null;
	targetLocationPath: string[];
	/** When `targetLocation` was set - drives the 1-hour restore window. */
	targetLocationSetAt: number | null;
}

// =============================================================================
// DATABASE INITIALIZATION
// =============================================================================

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
	if (!browser) {
		return Promise.reject(new Error('IndexedDB not available in SSR'));
	}

	if (!dbPromise) {
		dbPromise = openDB(DB_NAME, DB_VERSION, {
			upgrade(db, oldVersion) {
				log.info(`Upgrading database from version ${oldVersion} to ${DB_VERSION}`);
				if (db.objectStoreNames.contains(STORE_NAME)) {
					db.deleteObjectStore(STORE_NAME);
				}
				db.createObjectStore(STORE_NAME);
			},
			blocked() {
				log.warn('Database upgrade blocked by another tab');
			},
			blocking() {
				log.warn('This tab is blocking a database upgrade');
			},
		});
	}

	return dbPromise;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/** Result of restoring a persisted session, after TTL rules are applied. */
export interface RestoredRelocateLocationSession {
	moveLog: StoredLocationMoveLogEntry[];
	/** Null if there was nothing stored, or the destination fell outside its 1-hour restore window. */
	targetLocation: { id: string; name: string } | null;
	targetLocationPath: string[];
	/**
	 * The original timestamp `targetLocation` was set at (null if not restored).
	 * Callers should carry this through on subsequent saves rather than
	 * substituting `Date.now()`, or every reload would silently re-arm the
	 * destination for another hour.
	 */
	targetLocationSetAt: number | null;
}

/**
 * Load the persisted session and apply TTL rules.
 * Returns null if nothing is stored or the whole log has expired.
 */
export async function restore(): Promise<RestoredRelocateLocationSession | null> {
	if (!browser) return null;

	try {
		const db = await getDb();
		const session: StoredRelocateLocationSession | undefined = await db.get(
			STORE_NAME,
			SESSION_KEY
		);

		if (!session) {
			log.debug('No persisted relocate-location session found');
			return null;
		}

		const logAge = Date.now() - session.createdAt;
		if (logAge > LOG_TTL_MS) {
			log.info(
				`Persisted move log expired (${Math.floor(logAge / 86_400_000)} days old), clearing`
			);
			await clear();
			return null;
		}

		// Restore the destination only if it was scanned recently - a stale
		// destination re-armed after a long gap is more dangerous than helpful.
		const targetIsFresh =
			session.targetLocationSetAt !== null &&
			Date.now() - session.targetLocationSetAt <= TARGET_LOCATION_TTL_MS;

		if (session.targetLocation && !targetIsFresh) {
			log.info('Persisted destination is stale (>1h old), not restoring it');
		}

		log.info(
			`Restored relocate-location session: ${session.moveLog.length} log entries, destination ${
				targetIsFresh ? 'restored' : 'not restored'
			}`
		);

		return {
			moveLog: session.moveLog,
			targetLocation: targetIsFresh ? session.targetLocation : null,
			targetLocationPath: targetIsFresh ? session.targetLocationPath : [],
			targetLocationSetAt: targetIsFresh ? session.targetLocationSetAt : null,
		};
	} catch (error) {
		log.error('Error restoring relocate-location session:', error);
		try {
			await clear();
		} catch (clearError) {
			log.warn('Failed to clear corrupted relocate-location session during recovery:', clearError);
		}
		return null;
	}
}

/**
 * Save the current relocate-location session state. Overwrites any existing session
 * (single-session guarantee), preserving the original `createdAt`.
 */
export async function save(
	session: Omit<StoredRelocateLocationSession, 'createdAt' | 'updatedAt'>
): Promise<void> {
	if (!browser) return;

	try {
		const db = await getDb();
		const existing: StoredRelocateLocationSession | undefined = await db.get(
			STORE_NAME,
			SESSION_KEY
		);

		const toStore: StoredRelocateLocationSession = {
			...session,
			createdAt: existing?.createdAt ?? Date.now(),
			updatedAt: Date.now(),
		};

		await db.put(STORE_NAME, toStore, SESSION_KEY);
		log.debug(`Saved relocate-location session: ${toStore.moveLog.length} log entries`);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		const errorName = error instanceof Error ? error.name : 'Unknown';
		log.error(`Error saving relocate-location session: [${errorName}] ${errorMessage}`);
		// Don't throw - persistence failures shouldn't break the workflow
	}
}

/** Clear the stored session (e.g. "Clear log"). */
export async function clear(): Promise<void> {
	if (!browser) return;

	try {
		const db = await getDb();
		await db.delete(STORE_NAME, SESSION_KEY);
		log.info('Relocate-location session cleared');
	} catch (error) {
		log.warn('Error clearing relocate-location session:', error);
	}
}
