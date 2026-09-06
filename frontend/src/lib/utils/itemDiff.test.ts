import { describe, expect, it } from 'vitest';
import { buildCustomFieldRecord, diffItem, draftFromItem, type ItemDraft } from './itemDiff';
import type { ItemDetail } from '$lib/types';

const BASE_ITEM: ItemDetail = {
	id: 'item-1',
	name: 'Cordless Drill',
	description: '18V drill',
	quantity: 2,
	assetId: '000-001',
	insured: false,
	archived: false,
	manufacturer: 'Acme',
	modelNumber: 'M-100',
	serialNumber: 'SN-42',
	purchasePrice: 99.5,
	purchaseFrom: 'Hardware Store',
	notes: 'Original notes',
	parent: { id: 'loc-a', name: 'Garage', isLocation: true },
	tags: [{ id: 'tag-1', name: 'Power Tools' }],
	fields: [
		{ name: 'Condition', type: 'text', textValue: 'New' },
		{ name: 'Weight', type: 'number', textValue: null },
	],
	attachments: [],
	thumbnailId: null,
	path: [],
	createdAt: '2026-01-01T00:00:00Z',
	updatedAt: '2026-01-02T00:00:00Z',
};

function draft(): ItemDraft {
	return draftFromItem(BASE_ITEM, []);
}

describe('draftFromItem / buildCustomFieldRecord', () => {
	it('builds a draft with definitions first, item values overriding, extras retained', () => {
		const defs = [
			{ name: 'Condition', ai_instruction: '' },
			{ name: 'Warranty', ai_instruction: '' },
		];
		const record = buildCustomFieldRecord(defs, BASE_ITEM.fields);

		expect(record).toEqual({
			Condition: 'New', // item value overrides the empty definition slot
			Warranty: '', // unfilled definition still gets a slot
			// 'Weight' is excluded: it's a non-text field, preserved server-side but not edited here
		});
	});

	it('resolves locationId only when the parent is a location, not another item', () => {
		const itemParent = {
			...BASE_ITEM,
			parent: { id: 'item-0', name: 'Toolbox', isLocation: false },
		};
		expect(draftFromItem(itemParent, []).locationId).toBe('');
		expect(draftFromItem(BASE_ITEM, []).locationId).toBe('loc-a');
	});
});

describe('diffItem', () => {
	it('returns no changes for an untouched draft', () => {
		expect(diffItem(BASE_ITEM, draft())).toEqual({});
	});

	it('diffs only the changed scalar field', () => {
		const d = draft();
		d.name = 'New Name';
		expect(diffItem(BASE_ITEM, d)).toEqual({ name: 'New Name' });
	});

	it('treats empty string and null as equivalent for clearable text fields', () => {
		const item = { ...BASE_ITEM, notes: '' };
		const d = draftFromItem(item, []);
		d.notes = null;
		expect(diffItem(item, d)).toEqual({});
	});

	it('diffs locationId as null when cleared', () => {
		const d = draft();
		d.locationId = '';
		expect(diffItem(BASE_ITEM, d)).toEqual({ locationId: null });
	});

	it('diffs locationId when changed to another location', () => {
		const d = draft();
		d.locationId = 'loc-b';
		expect(diffItem(BASE_ITEM, d)).toEqual({ locationId: 'loc-b' });
	});

	it('does not diff tagIds when the same set is reordered', () => {
		const item = {
			...BASE_ITEM,
			tags: [
				{ id: 'a', name: 'A' },
				{ id: 'b', name: 'B' },
			],
		};
		const d = draftFromItem(item, []);
		d.tagIds = ['b', 'a'];
		expect(diffItem(item, d)).toEqual({});
	});

	it('diffs tagIds when the set actually changes', () => {
		const d = draft();
		d.tagIds = ['tag-1', 'tag-2'];
		expect(diffItem(BASE_ITEM, d)).toEqual({ tagIds: ['tag-1', 'tag-2'] });
	});

	it('diffs purchasePrice, treating NaN/undefined as null', () => {
		const d = draft();
		d.purchasePrice = null;
		expect(diffItem(BASE_ITEM, d)).toEqual({ purchasePrice: null });
	});

	it('diffs boolean flags', () => {
		const d = draft();
		d.insured = true;
		expect(diffItem(BASE_ITEM, d)).toEqual({ insured: true });
	});

	it('sends only the changed custom field, leaving others out of the payload', () => {
		const d = draftFromItem(BASE_ITEM, [{ name: 'Condition', ai_instruction: '' }]);
		d.customFields.Condition = 'Used';
		expect(diffItem(BASE_ITEM, d)).toEqual({ fields: { Condition: 'Used' } });
	});

	it('sends an empty string for a cleared custom field', () => {
		const d = draftFromItem(BASE_ITEM, [{ name: 'Condition', ai_instruction: '' }]);
		d.customFields.Condition = '';
		expect(diffItem(BASE_ITEM, d)).toEqual({ fields: { Condition: '' } });
	});

	it('does not diff fields when a new empty definition slot stays empty', () => {
		const d = draftFromItem(BASE_ITEM, [{ name: 'Warranty', ai_instruction: '' }]);
		expect(diffItem(BASE_ITEM, d)).toEqual({});
	});
});
