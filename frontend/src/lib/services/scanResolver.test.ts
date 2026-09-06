import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

vi.mock('$app/paths', () => ({
	resolve: vi.fn((route: string, params?: Record<string, string>) => {
		if (!params) return route;
		let out = route;
		for (const [key, value] of Object.entries(params)) out = out.replace(`[${key}]`, value);
		return out;
	}),
}));

vi.mock('$lib/api/items', () => ({ items: { getByAssetId: vi.fn() } }));

vi.mock('$lib/api/locations', () => ({ locations: { get: vi.fn() } }));

vi.mock('$lib/api/client', () => ({
	ApiError: class ApiError extends Error {
		status: number;
		constructor(status: number, message: string) {
			super(message);
			this.status = status;
			this.name = 'ApiError';
		}
	},
}));

vi.mock('$lib/workflows/browse.svelte', () => ({
	browseWorkflow: {
		reset: vi.fn(),
		setLocationFilter: vi.fn(),
		setQuery: vi.fn(),
		search: vi.fn(async () => {}),
	},
}));

vi.mock('$lib/stores/ui.svelte', () => ({ showToast: vi.fn() }));

vi.mock('$lib/utils/qrUrl', () => ({ resolveQrUrl: vi.fn(async (raw: string) => raw) }));

import { navigateToScannedCode, resolveScannedCode } from './scanResolver';
import { goto } from '$app/navigation';
import { items as itemsApi } from '$lib/api/items';
import { locations as locationsApi } from '$lib/api/locations';
import { ApiError } from '$lib/api/client';
import { browseWorkflow } from '$lib/workflows/browse.svelte';
import { showToast } from '$lib/stores/ui.svelte';
import { resolveQrUrl } from '$lib/utils/qrUrl';

beforeEach(() => {
	vi.clearAllMocks();
});

describe('resolveScannedCode', () => {
	it('resolves via resolveQrUrl before parsing', async () => {
		vi.mocked(resolveQrUrl).mockResolvedValue('https://homebox.example.com/a/000-042');

		const result = await resolveScannedCode('https://short.link/xyz');

		expect(resolveQrUrl).toHaveBeenCalledWith('https://short.link/xyz');
		expect(result).toEqual({ kind: 'asset', assetId: '000-042' });
	});

	it('never throws - falls through to unknown for unrecognised text', async () => {
		vi.mocked(resolveQrUrl).mockResolvedValue('some random barcode');

		await expect(resolveScannedCode('some random barcode')).resolves.toEqual({
			kind: 'unknown',
			raw: 'some random barcode',
		});
	});
});

describe('navigateToScannedCode', () => {
	it('asset: looks up by asset ID and navigates to the item detail page', async () => {
		vi.mocked(itemsApi.getByAssetId).mockResolvedValue({
			id: 'item-uuid-1',
			name: 'Drill',
			assetId: '123-123',
			thumbnailId: null,
			locationId: null,
			locationName: null,
		});

		await navigateToScannedCode({ kind: 'asset', assetId: '123-123' });

		expect(itemsApi.getByAssetId).toHaveBeenCalledWith('123-123');
		expect(goto).toHaveBeenCalledWith('/items/item-uuid-1');
		expect(showToast).not.toHaveBeenCalled();
	});

	it('asset: 404 shows a warning toast and does not navigate', async () => {
		vi.mocked(itemsApi.getByAssetId).mockRejectedValue(new ApiError(404, 'not found'));

		await navigateToScannedCode({ kind: 'asset', assetId: '999-999' });

		expect(showToast).toHaveBeenCalledWith(expect.stringContaining('999-999'), 'warning');
		expect(goto).not.toHaveBeenCalled();
	});

	it('asset: a non-404 error propagates instead of being swallowed', async () => {
		vi.mocked(itemsApi.getByAssetId).mockRejectedValue(new ApiError(500, 'server error'));

		await expect(navigateToScannedCode({ kind: 'asset', assetId: '123-123' })).rejects.toThrow(
			'server error'
		);
		expect(goto).not.toHaveBeenCalled();
	});

	it('location: seeds the browse filter (after reset) and navigates to /browse', async () => {
		vi.mocked(locationsApi.get).mockResolvedValue({
			id: 'loc-1',
			name: 'Garage',
			description: '',
			itemCount: 3,
			children: [],
		});

		await navigateToScannedCode({ kind: 'location', locationId: 'loc-1' });

		expect(locationsApi.get).toHaveBeenCalledWith('loc-1');
		expect(browseWorkflow.setLocationFilter).toHaveBeenCalledWith({ id: 'loc-1', name: 'Garage' });
		expect(browseWorkflow.search).toHaveBeenCalled();
		expect(goto).toHaveBeenCalledWith('/browse');

		// reset() must run before the filter is set, or reset()'s search-token bump
		// would invalidate the very search this navigation just kicked off.
		const resetOrder = vi.mocked(browseWorkflow.reset).mock.invocationCallOrder[0];
		const setFilterOrder = vi.mocked(browseWorkflow.setLocationFilter).mock.invocationCallOrder[0];
		expect(resetOrder).toBeLessThan(setFilterOrder);
	});

	it('location: 404 shows a warning toast and does not navigate', async () => {
		vi.mocked(locationsApi.get).mockRejectedValue(new ApiError(404, 'not found'));

		await navigateToScannedCode({ kind: 'location', locationId: 'missing-uuid' });

		expect(showToast).toHaveBeenCalledWith(expect.stringContaining('missing-uuid'), 'warning');
		expect(goto).not.toHaveBeenCalled();
	});

	it('unknown: seeds the browse query (after reset) and navigates to /browse', async () => {
		await navigateToScannedCode({ kind: 'unknown', raw: 'some barcode text' });

		expect(browseWorkflow.setQuery).toHaveBeenCalledWith('some barcode text');
		expect(browseWorkflow.search).toHaveBeenCalled();
		expect(goto).toHaveBeenCalledWith('/browse');

		const resetOrder = vi.mocked(browseWorkflow.reset).mock.invocationCallOrder[0];
		const setQueryOrder = vi.mocked(browseWorkflow.setQuery).mock.invocationCallOrder[0];
		expect(resetOrder).toBeLessThan(setQueryOrder);
	});
});
