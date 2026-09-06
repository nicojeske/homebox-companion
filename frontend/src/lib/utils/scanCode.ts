/**
 * Scanned code parser.
 *
 * Handles both printed Homebox QR/barcode tag formats:
 * - Legacy URL tags: `https://homebox.example.com/a/{asset_id}`,
 *   `https://homebox.example.com/location/{uuid}`
 * - Compact tags: `a{digits}` for assets, `l{uuid}` for locations
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

	return { kind: 'unknown', raw: trimmed };
}
