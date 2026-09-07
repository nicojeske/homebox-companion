/**
 * Scanned code parser.
 *
 * Handles both printed Homebox QR/barcode tag formats:
 * - Legacy URL tags: `https://homebox.example.com/a/{asset_id}`,
 *   `https://homebox.example.com/location/{uuid}`
 * - Compact tags: `a{digits}` for assets, `l{uuid}` for locations
 * - The bare printed asset ID itself, `%03d-%03d` (e.g. `001-110`) - what a
 *   keyboard-wedge scanner or manual entry produces when it's just reading
 *   the human-readable label under the QR code rather than the tag payload.
 *
 * `resolveQrUrl` (see `qrUrl.ts`) should be called first to follow any
 * shortened-URL redirects; its output (or the raw scanned text for
 * non-URL codes) is what this module expects.
 */

export type ScannedCode =
	| { kind: 'location'; locationId: string }
	| { kind: 'asset'; assetId: string }
	| { kind: 'unknown'; raw: string };

const LEGACY_LOCATION_RE = /\/location\/([0-9a-f-]+)(?:[/?#]|$)/i;
const LEGACY_ASSET_RE = /\/a\/([^\s/?#]+)/;
const COMPACT_LOCATION_RE =
	/^l[-\s]?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const COMPACT_ASSET_RE = /^a[-\s]?(\d[\d-]*)$/i;
// The printed `%03d-%03d` form with no leading "a" - 1-3 digits per side so a
// bare year range like "2024-2025" (4 digits per side) doesn't get mistaken
// for an asset tag. A bare number with no dash at all (e.g. "1110") is left
// as a plain text search - only the dash (or the "a" prefix above) signals
// "this is an asset ID".
const DASHED_ASSET_RE = /^(\d{1,3})\s*-\s*(\d{1,3})$/;

/**
 * Format a numeric asset ID the same way Homebox does: `%03d-%03d` on
 * `id / 1000` and `id % 1000` (e.g. 85 -> "000-085", 123123 -> "123-123").
 */
function formatAssetId(digits: string): string {
	const id = parseInt(digits, 10);
	if (Number.isNaN(id)) return digits;
	const high = Math.floor(id / 1000);
	const low = id % 1000;
	return `${String(high).padStart(3, '0')}-${String(low).padStart(3, '0')}`;
}

/**
 * Parse scanned text (a resolved QR URL, a compact tag, or raw text from a
 * 1D barcode / manual entry) into a structured result.
 */
export function parseScannedCode(text: string): ScannedCode {
	const trimmed = text.trim();

	const legacyLocation = LEGACY_LOCATION_RE.exec(trimmed);
	if (legacyLocation) {
		return { kind: 'location', locationId: legacyLocation[1] };
	}

	const legacyAsset = LEGACY_ASSET_RE.exec(trimmed);
	if (legacyAsset) {
		return { kind: 'asset', assetId: legacyAsset[1] };
	}

	const compactLocation = COMPACT_LOCATION_RE.exec(trimmed);
	if (compactLocation) {
		return { kind: 'location', locationId: compactLocation[1] };
	}

	const compactAsset = COMPACT_ASSET_RE.exec(trimmed);
	if (compactAsset) {
		const digits = compactAsset[1].replace(/-/g, '');
		return { kind: 'asset', assetId: formatAssetId(digits) };
	}

	const dashedAsset = DASHED_ASSET_RE.exec(trimmed);
	if (dashedAsset) {
		return { kind: 'asset', assetId: formatAssetId(dashedAsset[1] + dashedAsset[2]) };
	}

	return { kind: 'unknown', raw: trimmed };
}
