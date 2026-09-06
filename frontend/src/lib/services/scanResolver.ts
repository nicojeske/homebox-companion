/**
 * Shared scan resolution and routing.
 *
 * `resolveScannedCode()` is the `resolveQrUrl() -> parseScannedCode()` chain
 * extracted from `/relocate`, `/location`, and `AssetIdInput.svelte`, which
 * each inlined it separately. It never throws - both underlying calls already
 * degrade gracefully (`resolveQrUrl` falls back to the raw text on a failed
 * redirect lookup; `parseScannedCode` falls back to `{kind: 'unknown'}`) - so
 * this makes "always resolve before parsing" impossible to get wrong instead
 * of just less repetitive.
 *
 * `navigateToScannedCode()` is the routing decision used only by `/scan`
 * (open an item's detail page for an asset tag, or a filtered `/browse` for a
 * location tag or unrecognised text). The other three callers each have their
 * own narrower handling of a `ScannedCode` and don't use this.
 */

import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { items as itemsApi } from '$lib/api/items';
import { locations as locationsApi } from '$lib/api/locations';
import { ApiError } from '$lib/api/client';
import { browseWorkflow } from '$lib/workflows/browse.svelte';
import { showToast } from '$lib/stores/ui.svelte';
import { resolveQrUrl } from '$lib/utils/qrUrl';
import { parseScannedCode, type ScannedCode } from '$lib/utils/scanCode';
import { createLogger } from '$lib/utils/logger';

const log = createLogger({ prefix: 'ScanResolver' });

/**
 * Resolve raw scanned text (from BLE, camera, or manual entry) into a
 * structured `ScannedCode`. Follows redirects first via `resolveQrUrl()`,
 * then parses the result via `parseScannedCode()`. Never throws.
 */
export async function resolveScannedCode(rawText: string): Promise<ScannedCode> {
	const resolved = await resolveQrUrl(rawText);
	log.debug(`Resolved scan: ${resolved}`);
	return parseScannedCode(resolved);
}

/**
 * Navigate to the destination a scanned code identifies:
 * - `asset` -> that item's detail page (`/items/[id]`)
 * - `location` -> `/browse` filtered to that location
 * - `unknown` -> `/browse` with the raw text as a free-text search
 *
 * A 404 (unknown asset/location ID) shows a warning toast and does not
 * navigate, leaving the caller on the scan page to try again.
 */
export async function navigateToScannedCode(code: ScannedCode): Promise<void> {
	if (code.kind === 'asset') {
		let item: { id: string };
		try {
			item = await itemsApi.getByAssetId(code.assetId);
		} catch (err) {
			if (err instanceof ApiError && err.status === 404) {
				showToast(`No item found with tag ${code.assetId}`, 'warning');
				return;
			}
			throw err;
		}
		await goto(resolve('/items/[id]', { id: item.id }));
		return;
	}

	if (code.kind === 'location') {
		let location: { id: string; name: string };
		try {
			location = await locationsApi.get(code.locationId);
		} catch (err) {
			if (err instanceof ApiError && err.status === 404) {
				showToast(`No location found for tag ${code.locationId}`, 'warning');
				return;
			}
			throw err;
		}
		browseWorkflow.reset();
		browseWorkflow.setLocationFilter({ id: location.id, name: location.name });
		await browseWorkflow.search();
		await goto(resolve('/browse'));
		return;
	}

	// unknown - fall back to a free-text search of the raw scanned string
	browseWorkflow.reset();
	browseWorkflow.setQuery(code.raw);
	await browseWorkflow.search();
	await goto(resolve('/browse'));
}
