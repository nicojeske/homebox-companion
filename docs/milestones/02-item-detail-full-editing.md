# M2 — Item Detail & Full Editing

Status: 📋 Planned · Depends on: M1 · Blocks: M3, M4, M5

## Overview

`/items/[id]` — view and edit every field of an existing Homebox item. Today `PUT /api/items/{item_id}`
(`server/api/items.py:305`) silently drops every field except `assetId`, `name`, `description`,
`locationId` — anything else sent is discarded on the fetch-then-merge. This milestone widens that endpoint
to the full field set and builds a detail/edit page on top of it, reusing the existing shared form
components built for the review page and chat approval panel.

## Architecture

### Backend

| Change | File | Notes |
|--------|------|-------|
| Widen `PUT /api/items/{item_id}` | `server/api/items.py` | Accept `quantity`, `tagIds`, `manufacturer`, `modelNumber`, `serialNumber`, `purchasePrice`, `purchaseFrom`, `notes`, `insured`, `parentId`, custom `fields`. Keep the fetch-then-merge pattern (Homebox PUT is a full replace), but drive it from an explicit `ItemUpdateRequest` pydantic schema instead of `dict[str, Any]` so unknown keys are rejected rather than silently dropped. |
| New `GET /api/items/{item_id}` | `server/api/items.py` | **Picked up from M1** (deferred there — nothing consumed it yet). Wraps `client.get_item()` + `client.get_item_path()` for breadcrumb. Build the response schema here, once the detail page's actual needs (attachments, custom fields, path) are known — don't reuse M1's `ItemSearchResult`, it's a lighter projection for list rows. |
| New client methods | `src/homebox_companion/homebox/client.py` | `delete_attachment()`, `update_attachment()` (`DELETE`/`PUT /entities/{id}/attachments/{aid}`) — currently only upload + get are wrapped. |
| New routes | `server/api/items.py` | `DELETE /api/items/{id}/attachments/{aid}`; a "set primary" PUT for attachments. |

Note: `server/api/items.py`'s existing `update_item()` reads `full_item.get("location", {}).get("id")` when
rebuilding the update payload — but M1 confirmed (against a live Homebox 0.26.1) that the full-item fetch
(`GET /entities/{id}`) returns the field as `parent`, not `location` (see `homebox/views.py`'s
`ItemView.from_dict`, which already handles both). This looks like a latent bug that silently drops
`locationId` on every PUT today. Worth checking and fixing as part of widening this same route.

Reuse: `HomeboxItemField` (`src/homebox_companion/tools/vision/models.py`) for custom-field payloads;
`get_valid_tag_ids()` (`server/dependencies.py`) to filter stale tag IDs, exactly as `POST /items` already
does in the batch-create path.

### Frontend

| File | Status | Notes |
|------|--------|-------|
| `frontend/src/routes/items/[id]/+page.svelte` | Not started | Detail view with inline edit. |
| `frontend/src/lib/workflows/item-detail.svelte.ts` | Not started | New singleton/service for load/dirty/save state. |

**Reuse wholesale** — no new field components needed, all are `$bindable` with a `size: 'sm' | 'md'`
variant (`frontend/src/lib/components/form/`):
- `ItemCoreFields.svelte` (name, quantity, description)
- `ItemExtendedFields.svelte` (manufacturer, model, serial, purchase price/from, notes)
- `ItemCustomFields.svelte`
- `TagSelector.svelte`
- `LocationSelector.svelte`
- `AssetIdInput.svelte`

Attachment gallery: list, upload (existing `POST /items/{id}/attachments`), set primary, delete. Try reusing
`ImagesPanel.svelte` / `ThumbnailEditor.svelte` first; fall back to a thin new gallery component if their
props don't fit an "existing item" context (they were built for in-progress capture sessions).

Actions row:
- **Move** — existing `locationId` support in PUT, same call `relocateWorkflow` already makes.
- **Print label** — existing `POST /items/{id}/print-label`, gated on `print_enabled` from `/api/config`.
- **Delete** — existing `DELETE /items/{id}`, behind `ConfirmDialog.svelte`.
- **Open in Homebox** — deep link using `homebox_url` from `/api/config`, same pattern as
  `frontend/src/routes/relocate/+page.svelte:182`.

## Open Items / Known Limitations

- ⚠️ Check `frontend/src/lib/utils/routeGuard.ts` — `/items/*` and `/browse` must be excluded from the scan
  workflow's `STATUS_TO_ROUTE` guards, the way `/relocate` already is, or the guard will redirect away from
  the detail page mid-session.
- Concurrent edit conflicts aren't handled: the fetch-then-merge PUT pattern means two open edit sessions on
  the same item can clobber each other. Not fixing this now (no versioning/ETag support in Homebox's API),
  but the delete/save flow should at least surface a stale-data error clearly if Homebox itself rejects it.
- Attachment set-primary/delete depends on unwrapped Homebox endpoints (`update_attachment`,
  `delete_attachment`) that haven't been verified against a live Homebox instance yet — confirm the exact
  request/response shape before implementing.
- Decide demo-mode behavior for Delete (chat already disables destructive actions in demo mode).

## Superseded: Move Items feature (formerly RELOCATE.md)

The standalone `/relocate` page predates this milestone and stays as-is; M2 doesn't replace it, but the
**Move** action added here should call the same underlying update as `relocateWorkflow` for consistency.
Original tracker content, preserved for reference:

### BLE Integration

The BCST-47 in SPP mode exposes a GATT service the Web Bluetooth API (Chrome/Android) can use:
- **Service UUID**: `0000ff00-0000-1000-8000-00805f9b34fb`
- **Notify Characteristic UUID**: `0000ff01-0000-1000-8000-00805f9b34fb`
- **Payload parsing**: Strip first byte (control char) and last byte (checksum), decode rest as UTF-8.

Requirements: HTTPS, Chrome/Chromium on Android, user grants BLE permission once per device. Camera QR
scanning via `QrScanner.svelte` serves as a fallback.

### QR Code Formats

| Type | Format | Example |
|------|--------|---------|
| Location (legacy URL) | `https://<host>/location/<uuid>` | `https://homebox.example.com/location/abc-123` |
| Item (legacy URL) | `https://<host>/a/<assetId>` | `https://homebox.example.com/a/000-042` |
| Location (compact tag) | `l<uuid>` | `labc-12300-4500-6700-89000abcdef1` |
| Item (compact tag) | `a<digits>` | `a123123` → asset ID `123-123` |

Legacy URL formats are unwrapped by `resolveQrUrl()` (`frontend/src/lib/utils/qrUrl.ts`); all four formats
are then parsed into a `{kind, id}` result by `parseScannedCode()` (`frontend/src/lib/utils/scanCode.ts`).
M3 (Scan-to-open) extracts and reuses this same resolution chain.

### Known Limitations (still open)

- BLE notifications may stop if the Android screen locks or the browser goes to background. User must
  reconnect; the page shows a "disconnected" state automatically.
- Web Bluetooth is not available in Firefox or Safari.
- Move log is in-memory only; cleared on page refresh. M4 considers persisting it the same way
  `SubmissionService` tracks per-item status, if bulk-move undo turns out to need it too.

## Done When

Every field visible in Homebox is editable here and round-trips correctly, including custom fields and
tags; attachments can be added/removed/re-primaried.
