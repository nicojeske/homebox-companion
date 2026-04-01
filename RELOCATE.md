# Move Items Feature — Implementation Tracker

Tracks the implementation of the "Move Items" feature across multiple sessions.

## Overview

Allows users to relocate Homebox inventory items by scanning QR codes with the Inateck BCST-47
barcode scanner (SPP/BLE mode) or the phone camera. The user scans a destination location QR first,
then scans item QR codes to move them. Each session keeps a log with per-item undo support.

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
| Location | `https://<host>/location/<uuid>` | `https://homebox.example.com/location/abc-123` |
| Item | `https://<host>/a/<assetId>` | `https://homebox.example.com/a/000-042` |

Both formats are already handled by the existing `resolveQrUrl()` utility
(`frontend/src/lib/utils/qrUrl.ts`).

## Architecture

### New Files

| File | Status | Notes |
|------|--------|-------|
| `frontend/src/lib/services/bleScanner.svelte.ts` | ✅ Done | Singleton BLE service |
| `frontend/src/lib/workflows/relocate.svelte.ts` | ✅ Done | Workflow state + move log |
| `frontend/src/routes/relocate/+page.svelte` | ✅ Done | Move items page |

### Modified Files

| File | Status | Change |
|------|--------|--------|
| `server/api/items.py` | ✅ Done | Added `GET /api/items/by-asset-id/{asset_id}`; `locationId` support in PUT |
| `frontend/src/lib/api/items.ts` | ✅ Done | `getByAssetId()` method + `locationId` in `ItemUpdateData` |
| `frontend/src/lib/navigation/config.ts` | ✅ Done | Added `'move'` icon type + `/relocate` nav item |
| `frontend/src/lib/components/NavIcon.svelte` | ✅ Done | `ArrowRightLeft` icon for `'move'` |

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
- Move log is in-memory only; cleared on page refresh. No persistence planned.
- The `PUT /api/items/{item_id}` endpoint now accepts `locationId` in the request body.
  The frontend `ItemUpdateData` type was updated accordingly.
