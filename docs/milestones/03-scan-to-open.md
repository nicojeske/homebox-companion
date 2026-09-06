# M3 — Scan-to-Open

Status: 📋 Planned · Depends on: M2 · Blocks: nothing

## Overview

Scan any Homebox QR tag from anywhere in the app and land directly on the right page — the item detail
page (M2) for an asset tag, or a filtered browse view (M1) for a location tag. Builds entirely on existing
scanning and parsing infrastructure; no new detection logic needed.

## Architecture

### New Files

| File | Status | Notes |
|------|--------|-------|
| `frontend/src/routes/scan/+page.svelte` | Not started | Runs `QrScanner.svelte` and `bleScanner` simultaneously — same dual-input pattern as `frontend/src/routes/relocate/+page.svelte`. Supports deep link `/scan?code=<raw>` for external scanners/shortcuts. |
| `frontend/src/lib/services/scanResolver.ts` | Not started | Extracted shared resolve logic: `resolveQrUrl()` → `parseScannedCode()` → route decision. Both `/scan` and `/relocate` should call this instead of each having their own copy. |

### Modified Files

| File | Change |
|------|--------|
| `frontend/src/routes/relocate/+page.svelte` | Refactor its scan-resolve logic to call the new `scanResolver.ts` instead of inline duplication. |

### Data Flow

```
BLE scan / Camera scan
  ↓
resolveQrUrl()         — follows redirects if needed (lib/utils/qrUrl.ts)
  ↓
parseScannedCode()     — legacy URL + compact tag parsing (lib/utils/scanCode.ts, unchanged)
  ↓
route on {kind}
  ├── 'asset'    → GET /api/items/by-asset-id/{id} (exists) → navigate to /items/{uuid}
  ├── 'location' → navigate to /browse filtered to that location (or /locations/{id} once M4 lands)
  └── 'unknown'  → fall back to a text search of the raw scanned string on /browse
```

## Open Items / Known Limitations

- BLE scanning is Chrome/Chromium-on-Android + HTTPS only; Firefox/Safari unsupported — same constraint as
  `/relocate` today.
- Camera QR detection requires HTTPS; falls back to file-upload photo capture on HTTP, per
  `QrScanner.svelte`.
- Decide whether `/scan` is a full route (with its own back button, nav entry) or a modal/sheet launched
  from the browse page's scan button — affects whether it needs its own `routeGuard.ts` exclusion.
- `{kind: 'location'}` routing depends on whether M4's `/locations/[id]` page has landed yet; until then it
  falls back to filtered `/browse`.

## Done When

One scan from the browse screen opens the item's detail page, with both BLE and camera working.
