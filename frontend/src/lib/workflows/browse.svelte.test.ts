import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('$lib/api', () => ({ items: { search: vi.fn() } }));

vi.mock('$lib/services/locationNavigator.svelte', () => ({
	locationNavigator: { loadTree: vi.fn(async () => {}) },
}));

vi.mock('$lib/stores/locations.svelte', () => ({ locationStore: { flatList: [] } }));

vi.mock('$lib/stores/tags.svelte', () => ({
	tagStore: { tags: [], fetchTags: vi.fn(async () => {}) },
}));

vi.mock('$lib/stores/ui.svelte', () => ({ showToast: vi.fn() }));

import { items as itemsApi } from '$lib/api';
import { browseWorkflow } from './browse.svelte';

const emptyPage = { items: [], page: 1, pageSize: 30, total: 0 };
const onePage = (n: number) => ({
	items: Array.from({ length: n }, (_, i) => ({ id: `item-${i}`, name: `Item ${i}` })),
	page: 1,
	pageSize: 30,
	total: n,
});

beforeEach(() => {
	vi.clearAllMocks();
	browseWorkflow.reset();
});

describe('BrowseWorkflow.search - asset-tag recognition', () => {
	it('rewrites a compact asset tag to Homebox\'s "#assetId" search syntax', async () => {
		vi.mocked(itemsApi.search).mockResolvedValue(onePage(1) as never);

		browseWorkflow.setQuery('a1110');
		await browseWorkflow.search();

		expect(itemsApi.search).toHaveBeenCalledTimes(1);
		expect(itemsApi.search).toHaveBeenCalledWith(
			expect.objectContaining({ q: '#001-110', page: 1 })
		);
		expect(browseWorkflow.total).toBe(1);
	});

	it('recognizes the bare printed %03d-%03d form the same way', async () => {
		vi.mocked(itemsApi.search).mockResolvedValue(onePage(1) as never);

		browseWorkflow.setQuery('001-110');
		await browseWorkflow.search();

		expect(itemsApi.search).toHaveBeenCalledWith(
			expect.objectContaining({ q: '#001-110', page: 1 })
		);
	});

	it('falls back to a plain text search when the asset lookup finds nothing', async () => {
		vi.mocked(itemsApi.search)
			.mockResolvedValueOnce(emptyPage as never)
			.mockResolvedValueOnce(onePage(2) as never);

		browseWorkflow.setQuery('a9999');
		await browseWorkflow.search();

		expect(itemsApi.search).toHaveBeenCalledTimes(2);
		expect(itemsApi.search).toHaveBeenNthCalledWith(1, expect.objectContaining({ q: '#009-999' }));
		expect(itemsApi.search).toHaveBeenNthCalledWith(2, expect.objectContaining({ q: 'a9999' }));
		expect(browseWorkflow.total).toBe(2);
	});

	it('does not retry when the asset lookup already found results', async () => {
		vi.mocked(itemsApi.search).mockResolvedValue(onePage(1) as never);

		browseWorkflow.setQuery('a1110');
		await browseWorkflow.search();

		expect(itemsApi.search).toHaveBeenCalledTimes(1);
	});

	it('leaves a bare number with no dash as a plain text search', async () => {
		vi.mocked(itemsApi.search).mockResolvedValue(emptyPage as never);

		browseWorkflow.setQuery('1110');
		await browseWorkflow.search();

		expect(itemsApi.search).toHaveBeenCalledTimes(1);
		expect(itemsApi.search).toHaveBeenCalledWith(expect.objectContaining({ q: '1110' }));
	});

	it('loadMore() pages with the query search() actually matched on', async () => {
		vi.mocked(itemsApi.search)
			.mockResolvedValueOnce({
				items: onePage(30).items,
				page: 1,
				pageSize: 30,
				total: 40,
			} as never)
			.mockResolvedValueOnce({
				items: onePage(10).items,
				page: 2,
				pageSize: 30,
				total: 40,
			} as never);

		browseWorkflow.setQuery('a1110');
		await browseWorkflow.search();
		await browseWorkflow.loadMore();

		expect(itemsApi.search).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ q: '#001-110', page: 2 })
		);
	});
});
