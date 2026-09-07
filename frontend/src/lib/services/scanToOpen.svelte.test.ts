import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('$lib/services/scanResolver', () => ({
	resolveScannedCode: vi.fn(async (raw: string) => ({ kind: 'unknown', raw })),
	navigateToScannedCode: vi.fn(async () => {}),
}));

vi.mock('$lib/stores/ui.svelte', () => ({ showToast: vi.fn() }));

import { scanToOpen } from './scanToOpen.svelte';
import { resolveScannedCode, navigateToScannedCode } from '$lib/services/scanResolver';
import { showToast } from '$lib/stores/ui.svelte';

beforeEach(() => {
	vi.clearAllMocks();
	scanToOpen.processing = false;
});

describe('scanToOpen.handle', () => {
	it('resolves then navigates, flipping processing true -> false', async () => {
		let sawProcessingDuring = false;
		vi.mocked(navigateToScannedCode).mockImplementation(async () => {
			sawProcessingDuring = scanToOpen.processing;
		});

		const promise = scanToOpen.handle('a123123');
		expect(scanToOpen.processing).toBe(true);
		await promise;

		expect(resolveScannedCode).toHaveBeenCalledWith('a123123');
		expect(navigateToScannedCode).toHaveBeenCalled();
		expect(sawProcessingDuring).toBe(true);
		expect(scanToOpen.processing).toBe(false);
	});

	it('drops a second call while one is still in flight', async () => {
		let resolveFirst!: () => void;
		vi.mocked(navigateToScannedCode).mockImplementation(
			() =>
				new Promise<void>((res) => {
					resolveFirst = res;
				})
		);

		const first = scanToOpen.handle('a111111');
		// Let `first` run past its `await resolveScannedCode(...)` so it reaches
		// `navigateToScannedCode` (and captures `resolveFirst`) before the
		// second call and the `processing` guard are checked.
		await Promise.resolve();
		await Promise.resolve();

		const second = scanToOpen.handle('a222222');

		resolveFirst();
		await Promise.all([first, second]);

		expect(resolveScannedCode).toHaveBeenCalledTimes(1);
		expect(resolveScannedCode).toHaveBeenCalledWith('a111111');
	});

	it('toasts and resets processing instead of throwing when navigation rejects', async () => {
		vi.mocked(navigateToScannedCode).mockRejectedValue(new Error('server error'));

		await expect(scanToOpen.handle('a123123')).resolves.toBeUndefined();

		expect(showToast).toHaveBeenCalledWith(expect.stringContaining('server error'), 'error');
		expect(scanToOpen.processing).toBe(false);
	});

	it('toasts and resets processing when resolution itself rejects', async () => {
		vi.mocked(resolveScannedCode).mockRejectedValue(new Error('boom'));

		await expect(scanToOpen.handle('garbage')).resolves.toBeUndefined();

		expect(showToast).toHaveBeenCalledWith(expect.stringContaining('boom'), 'error');
		expect(navigateToScannedCode).not.toHaveBeenCalled();
		expect(scanToOpen.processing).toBe(false);
	});
});
