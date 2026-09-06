/**
 * Pure diffing helpers for the item detail/edit page.
 *
 * Extracted from the workflow service so they're testable without a DOM
 * (vitest runs `environment: 'node'`) and so the "send only changed keys"
 * behavior — which shrinks the clobber window on Homebox's fetch-then-merge
 * PUT, since there's no ETag/versioning to detect concurrent edits — is
 * exercised directly rather than only through the workflow's save() path.
 */
import type { CustomFieldDefinition } from '$lib/api/settings';
import type { ItemUpdateData } from '$lib/api/items';
import type { ItemDetail, ItemFieldValue } from '$lib/types';

/** Editable draft shape backing the detail page's edit-mode form components. */
export interface ItemDraft {
	name: string;
	quantity: number;
	description: string | null;
	assetId: string | null;
	/** '' means no location — matches LocationSelector's bindable `value` contract. */
	locationId: string;
	tagIds: string[];
	manufacturer: string | null;
	modelNumber: string | null;
	serialNumber: string | null;
	purchasePrice: number | null;
	purchaseFrom: string | null;
	notes: string | null;
	insured: boolean;
	archived: boolean;
	/** Custom fields keyed by display name, as bound to ItemCustomFields. */
	customFields: Record<string, string>;
}

/** Build an editable draft from a loaded ItemDetail + the app's custom field definitions. */
export function draftFromItem(
	item: ItemDetail,
	customFieldDefs: CustomFieldDefinition[]
): ItemDraft {
	return {
		name: item.name,
		quantity: item.quantity,
		description: item.description,
		assetId: item.assetId,
		locationId: item.parent?.isLocation ? item.parent.id : '',
		tagIds: item.tags.map((t) => t.id),
		manufacturer: item.manufacturer,
		modelNumber: item.modelNumber,
		serialNumber: item.serialNumber,
		purchasePrice: item.purchasePrice,
		purchaseFrom: item.purchaseFrom,
		notes: item.notes,
		insured: item.insured,
		archived: item.archived,
		customFields: buildCustomFieldRecord(customFieldDefs, item.fields),
	};
}

/**
 * Overlay custom field definitions (so every configured field gets an editable
 * slot, even with no value yet) with the item's actual field values (so the
 * item wins, and any field outside the app's known definitions — set by
 * Homebox directly or by another client — still shows up rather than being
 * silently invisible).
 */
export function buildCustomFieldRecord(
	defs: CustomFieldDefinition[],
	itemFields: ItemFieldValue[]
): Record<string, string> {
	const record: Record<string, string> = {};
	for (const def of defs) {
		record[def.name] = '';
	}
	for (const field of itemFields) {
		if (field.type !== 'text') continue; // non-text fields are preserved server-side, not edited here
		record[field.name] = field.textValue ?? '';
	}
	return record;
}

/** Treat '' and null/undefined as the same "empty" value for comparison purposes. */
function normalizeEmpty(value: string | null | undefined): string | null {
	return value === undefined || value === null || value === '' ? null : value;
}

function normalizeNumber(value: number | null | undefined): number | null {
	return value === undefined || value === null || Number.isNaN(value) ? null : value;
}

function sameTagSet(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	const sortedA = [...a].sort();
	const sortedB = [...b].sort();
	return sortedA.every((id, i) => id === sortedB[i]);
}

/**
 * Diff an edited draft against its loaded snapshot, returning only the keys
 * that actually changed — the payload PUT /items/{id} expects.
 */
export function diffItem(snapshot: ItemDetail, draft: ItemDraft): ItemUpdateData {
	const changes: ItemUpdateData = {};

	if (draft.name !== snapshot.name) changes.name = draft.name;
	if (draft.quantity !== snapshot.quantity) changes.quantity = draft.quantity;
	if (normalizeEmpty(draft.description) !== normalizeEmpty(snapshot.description)) {
		changes.description = draft.description ?? '';
	}
	if (normalizeEmpty(draft.assetId) !== normalizeEmpty(snapshot.assetId)) {
		changes.assetId = normalizeEmpty(draft.assetId);
	}

	const snapshotLocationId = snapshot.parent?.isLocation ? snapshot.parent.id : null;
	if (normalizeEmpty(draft.locationId) !== snapshotLocationId) {
		changes.locationId = normalizeEmpty(draft.locationId);
	}

	const snapshotTagIds = snapshot.tags.map((t) => t.id);
	if (!sameTagSet(draft.tagIds, snapshotTagIds)) {
		changes.tagIds = draft.tagIds;
	}

	if (normalizeEmpty(draft.manufacturer) !== normalizeEmpty(snapshot.manufacturer)) {
		changes.manufacturer = normalizeEmpty(draft.manufacturer);
	}
	if (normalizeEmpty(draft.modelNumber) !== normalizeEmpty(snapshot.modelNumber)) {
		changes.modelNumber = normalizeEmpty(draft.modelNumber);
	}
	if (normalizeEmpty(draft.serialNumber) !== normalizeEmpty(snapshot.serialNumber)) {
		changes.serialNumber = normalizeEmpty(draft.serialNumber);
	}
	if (normalizeNumber(draft.purchasePrice) !== normalizeNumber(snapshot.purchasePrice)) {
		changes.purchasePrice = normalizeNumber(draft.purchasePrice);
	}
	if (normalizeEmpty(draft.purchaseFrom) !== normalizeEmpty(snapshot.purchaseFrom)) {
		changes.purchaseFrom = normalizeEmpty(draft.purchaseFrom);
	}
	if (normalizeEmpty(draft.notes) !== normalizeEmpty(snapshot.notes)) {
		changes.notes = normalizeEmpty(draft.notes);
	}
	if (draft.insured !== snapshot.insured) changes.insured = draft.insured;
	if (draft.archived !== snapshot.archived) changes.archived = draft.archived;

	const snapshotCustomFields = buildCustomFieldRecord([], snapshot.fields);
	const fieldChanges: Record<string, string | null> = {};
	let hasFieldChanges = false;
	for (const [name, value] of Object.entries(draft.customFields)) {
		const previous = snapshotCustomFields[name] ?? '';
		if (value !== previous) {
			fieldChanges[name] = value;
			hasFieldChanges = true;
		}
	}
	if (hasFieldChanges) changes.fields = fieldChanges;

	return changes;
}
