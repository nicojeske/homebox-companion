# Move Items / Move Locations — Implementation Tracker

Tracks the implementation of the "Move" feature (`/relocate`) across multiple sessions. It has two
modes, toggled at the top of the page: **Items** (move items into a location) and **Locations**
(reparent a location under another location).

## Overview

Allows users to relocate Homebox inventory items, or reparent locations themselves, by scanning QR
codes with the Inateck BCST-47 barcode scanner (SPP/BLE mode) or the phone camera.

- **Items mode**: scan a destination location QR first, then scan item QR codes to move them.
- **Locations mode**: scan a destination location QR first (sticky), then scan another location QR
  to reparent it under that destination. Scanning further locations moves each into the same
  destination without rescanning it.

Each mode keeps its own session log with per-entry undo support.

## BLE Integration

The BCST-47 in SPP mode exposes a GATT service that the Web Bluetooth API (Chrome/Android) can use:
- **Service UUID**: `0000ff00-0000-1000-8000-00805f9b34fb`
- **Notify Characteristic UUID**: `0000ff01-0000-1000-8000-00805f9b34fb`
- **Payload parsing**: Strip first byte (control char) and last byte (checksum), decode rest as UTF-8.

Requirements: HTTPS, Chrome/Chromium on Android, user grants BLE permission once per device.
Camera QR scanning via `QrScanner.svelte` serves as a fallback.

## QR Code Formats

| Type | Format | Example |
|------|--------|---------|
| Location (legacy URL) | `https://<host>/location/<uuid>` | `https://homebox.example.com/location/abc-123` |
| Item (legacy URL) | `https://<host>/a/<assetId>` | `https://homebox.example.com/a/000-042` |
| Location (compact tag) | `l<uuid>` | `labc-12300-4500-6700-89000abcdef1` |
| Item (compact tag) | `a<digits>` | `a123123` → asset ID `123-123` |

Legacy URL formats are unwrapped by `resolveQrUrl()` (`frontend/src/lib/utils/qrUrl.ts`);
all four formats are then parsed into a `{kind, id}` result by `parseScannedCode()`
(`frontend/src/lib/utils/scanCode.ts`). Compact asset tags carry a bare numeric ID that
`parseScannedCode()` reformats to Homebox's printed `%03d-%03d` asset ID (`id / 1000` -
`id % 1000`), matching what Homebox itself prints on labels.

## Architecture

### New Files

| File | Status | Notes |
|------|--------|-------|
| `frontend/src/lib/services/bleScanner.svelte.ts` | ✅ Done | Singleton BLE service |
| `frontend/src/lib/workflows/relocate.svelte.ts` | ✅ Done | Items workflow state + move log |
| `frontend/src/lib/workflows/relocateLocation.svelte.ts` | ✅ Done | Locations workflow state + move log + cycle guard |
| `frontend/src/lib/services/relocateLocationPersistence.ts` | ✅ Done | IndexedDB persistence for the Locations mode session (own DB, `hbc-relocate-location`) |
| `frontend/src/routes/relocate/+page.svelte` | ✅ Done | Move page, with an Items/Locations mode toggle |

### Modified Files

| File | Status | Change |
|------|--------|--------|
| `server/api/items.py` | ✅ Done | Added `GET /api/items/by-asset-id/{asset_id}`; `locationId` support in PUT |
| `frontend/src/lib/api/items.ts` | ✅ Done | `getByAssetId()` method + `locationId` in `ItemUpdateData` |
| `frontend/src/lib/navigation/config.ts` | ✅ Done | Added `'move'` icon type + `/relocate` nav item |
| `frontend/src/lib/components/NavIcon.svelte` | ✅ Done | `ArrowRightLeft` icon for `'move'` |
| `src/homebox_companion/homebox/client.py` | ✅ Done | `update_location()` now always sends `parentId` (including explicit `null`), so undoing a location move back to top-level actually clears the parent |

## Move Locations Mode

Both scans in this mode are `kind === 'location'` (there's no separate QR kind for "the location to
move" vs. "the destination"), so the role is decided by state rather than scan kind — the same
"set once, then feed it repeatedly" shape the Items mode already uses:

- No destination set yet → the scanned location becomes the (sticky) destination.
- Destination already set → the scanned location is reparented under it immediately.

`relocateLocation.svelte.ts`'s `processLocationScan()`:
1. Cycle guard — fetches `locations.tree()` and rejects the move if the destination lives inside
   the subtree of the location being moved (would make a location its own ancestor).
2. Fetches the scanned location (`locations.get`) for its current name/description (to resend
   unchanged on the PUT). The location's **current parent** is derived by walking the tree
   (`findParentId()`) rather than trusting a `parentId`-shaped field on the raw `GET` response —
   items expose their parent as a nested `{"parent": {"id", "name"}}` object elsewhere in this
   codebase, so the shape for a location's own parent isn't safe to assume; the tree is the
   reliable source of truth.
3. Skips as a no-op if it's already under the destination.
4. `locations.update(id, { name, description, parent_id: destinationId })` — Homebox's update is a
   full replace, so name/description must be resent unchanged.
5. Logs the move (previous parent id/name) for undo, and refreshes the shared `locationStore` tree
   cache so other screens don't show a stale hierarchy.

Undo re-fetches the location's current name/description (rather than trusting a stale snapshot) and
calls `locations.update` with the previous `parent_id`, including `null` for a location that was
originally top-level — this is exactly the case the `client.py` `update_location` fix exists for.

## Data Flow

```
BLE scan / Camera scan
  ↓
resolveQrUrl()         — follows redirects if needed
  ↓
URL pattern match
  ├── /location/<uuid> → locations.get(uuid) → setTargetLocation()
  └── /a/<assetId>     → items.getByAssetId(assetId)
                            → items.update(id, { locationId })
                            → prepend MoveLogEntry (with previousLocationId for undo)
```

## Open Items / Known Limitations

- BLE notifications may stop if the Android screen locks or the browser goes to background.
  User must reconnect; the page will show a "disconnected" state automatically.
- Web Bluetooth is not available in Firefox or Safari.
- Both modes' move logs are persisted to their own IndexedDB database (7-day TTL on the log,
  1-hour re-arm window on the destination) so a reload doesn't lose an in-progress session — see
  `relocatePersistence.ts` / `relocateLocationPersistence.ts`.
- The `PUT /api/items/{item_id}` endpoint now accepts `locationId` in the request body.
  The frontend `ItemUpdateData` type was updated accordingly.
- Locations mode always opens defaulted to Items mode on page load/reload (the toggle itself isn't
  persisted, only each mode's own session).
