# M2 — Item Detail & Full Editing

Status: ✅ Done · Depends on: M1 · Blocks: M3, M4, M5

## Overview

`/items/[id]` — view and edit every field of an existing Homebox item. `PUT /api/items/{item_id}`
(`server/api/items.py`, previously line 305, now the widened handler) used to silently drop every field
except `assetId`, `name`, `description`, `locationId` — anything else sent was discarded on the
fetch-then-merge. This milestone widened that endpoint to the full field set and built a detail/edit page
on top of it, reusing the shared form components built for the review page and chat approval panel.

Tracing the old PUT handler surfaced **three latent bugs** in the same code family — all variations of the
Homebox 0.26 `location` → `parent` field rename that M1 handled on the read path (`_build_search_result`)
but that had never been applied to the update or asset-lookup paths:

1. **`locationId` never reached Homebox.** The handler set `locationId` in the outbound payload but left
   `parentId` pointing at the old parent. Homebox 0.26 moves items via `parentId` only — confirmed live: a
   PUT with both keys set to different locations landed at the `parentId` value, `locationId` fully ignored.
   Every move through this endpoint (including every `relocateWorkflow` move) was a silent no-op.
2. **The PUT wiped custom fields.** The outbound payload never included `fields`. Confirmed live: setting a
   custom field, then PUTting again without `fields`, wiped it (`fields: []` on re-fetch).
3. **Asset-ID lookup always reported no location.** `GET /items/by-asset-id/{asset_id}` read
   `item.get("location")`, but Homebox 0.26's `/assets/{assetId}` returns `parent`, not `location` (confirmed
   live) — so `locationId`/`locationName` were always `null`. Since bug #1 was silently swallowing moves
   anyway, this masked a second failure: `relocateWorkflow`'s undo reads `previousLocationId` from this same
   response, so **fixing bug #1 without also fixing bug #3 would have made Undo start actively moving items
   to root** instead of a no-op. Both shipped in the same change.

A fourth bug was found during end-to-end verification, unrelated to the three above: **item thumbnails never
loaded**, on this page or on M1's `/browse`. `_build_search_result` (and the by-asset-id/detail routes) read
`item.get("thumbnailId")`, but Homebox 0.26.1 returns the primary attachment's id as a top-level `imageId` —
`thumbnailId` never existed on a real response. Fixed in all three read sites; M1's `test_items_search.py`
fixture had fabricated a `thumbnailId` key that was never verified against live Homebox for this field
specifically (only the `parent`/`location` rename was).

## Architecture

### Backend

| Change | File | Status |
|--------|------|--------|
| Live probe of every Homebox-side unknown before writing code | `tests/test_items_live.py` | ✅ Done — confirmed all 4 bugs above, plus the exact attachment PUT body Homebox requires and the shape of `GET /entities/{id}/path` |
| Widen `PUT /api/items/{item_id}` | `server/api/items.py` | ✅ Done — typed `ItemUpdateRequest` (`server/schemas/items.py`) replaces the untyped `dict[str, Any]`; `extra="forbid"` rejects unknown keys instead of silently dropping them; `locationId`/`parentId` collapse to one field via `AliasChoices` so the bug class is structurally impossible, not just patched |
| New `GET /api/items/{item_id}` | `server/api/items.py` | ✅ Done — new `ItemDetailResponse` (the old QR-lookup response of that name was renamed `ItemQrLookupResponse`); fetches the item and its breadcrumb path concurrently via `asyncio.gather`, degrading to an empty breadcrumb on path-fetch failure |
| Fix asset-ID lookup's location (bug #3) | `server/api/items.py` | ✅ Done — shares the same `_resolve_parent_ref()` helper as every other read site now |
| New client methods | `src/homebox_companion/homebox/client.py` | ✅ Done — `delete_attachment()`, `update_attachment()` (`DELETE`/`PUT /entities/{id}/attachments/{aid}`) |
| New routes | `server/api/items.py` | ✅ Done — `DELETE /api/items/{id}/attachments/{aid}`; `PUT /api/items/{id}/attachments/{aid}` (set/unset primary) |

`_build_item_update_payload()` and `_merge_custom_fields()` are extracted as pure, HTTP-free functions for
unit testing. Custom fields are echoed from Homebox's raw `fields` list **verbatim** (not rebuilt through
`HomeboxItemField`, which would downgrade a number/boolean-typed field to `type="text"` and drop its id) —
only the display names present in the request's `fields` dict are touched; every other field, including ones
outside the app's known `CustomFieldDefinition` list, survives untouched.

Reused as planned: `HomeboxItemField` for appending brand-new custom fields; `get_valid_tag_ids()` to filter
stale tag IDs, exactly as `POST /items` already does.

### Frontend

| File | Status | Notes |
|------|--------|-------|
| `frontend/src/routes/items/[id]/+page.svelte` | ✅ Done | Read-only detail view with an explicit **Edit** toggle (not always-editable) — Save/Cancel exits edit mode. |
| `frontend/src/lib/workflows/item-detail.svelte.ts` | ✅ Done | Singleton `itemDetailWorkflow`: owns the loaded item + custom field defs + view/edit mode; `save()` diffs against the loaded snapshot and PUTs only the changed keys. |
| `frontend/src/lib/utils/itemDiff.ts` | ✅ Done | Pure `diffItem()`/`draftFromItem()`/`buildCustomFieldRecord()`, unit tested (`itemDiff.test.ts`, 14 cases) since vitest runs `environment: 'node'`. |
| `frontend/src/lib/components/AttachmentGallery.svelte` | ✅ Done | New thin component — `ImagesPanel.svelte` binds local pre-upload `File[]` and doesn't fit server-side attachments with real IDs, so it was not reused. |

**Reused wholesale, as planned** (all `$bindable` with a `size` variant, except two corrections found in
review — `AssetIdInput` has neither a `size` prop nor a bindable value (it's `onChange`-driven), and
`TagSelector` is `onToggle`-driven, not bindable):
- `ItemCoreFields.svelte`, `ItemExtendedFields.svelte`, `ItemCustomFields.svelte`, `TagSelector.svelte`,
  `LocationSelector.svelte`, `AssetIdInput.svelte`.

`insured`/`archived` render as a small standalone "Flags" row on the page rather than extending
`ItemExtendedFields` — that component is shared with the review page and chat approval panel, and
`archived` has no natural home in it.

Actions row: **Move** (a `LocationSelector` inside a `Modal`, calling the same single-field `{locationId}`
PUT `relocateWorkflow` makes), **Print label** (gated on `print_enabled`), **Delete** (behind
`ConfirmDialog.svelte`), **Open in Homebox** (`homebox_url` deep link). `frontend/src/routes/browse/+page.svelte`
now links item names to `/items/[id]` instead of opening Homebox directly, resolving M1's deliberate
"no dead links" placeholder; "Open in Homebox" moved onto the detail page as its own action.

## Verification performed

- `uv run ruff check` / `uv run ty check` / `uv run vulture --min-confidence 70` / `uv run pytest` — all
  clean (one pre-existing unrelated failure in `test_prompts.py`, confirmed present on `main` before this
  work, same as M1 found).
- `uv run pytest -m live` — the new `tests/test_items_live.py` (6 probes) plus the full existing live suite
  pass against a real `ghcr.io/sysadminsmedia/homebox:0.26.1` container (via the `homebox_container` session
  fixture already in `tests/conftest.py` — no hand-rolled `docker run` needed this time).
- New pytest coverage: `test_items_update.py` (16 cases — the locationId/parentId alias fix, absent-key
  preservation, explicit-null clearing, unknown-key rejection, tag filtering, custom-field merge rules,
  null-safety), `test_item_detail.py` (9 cases — parent-is-location vs. parent-is-item, path-fetch failure
  degradation, route-ordering regression, the bug #3 fix), `test_item_attachments.py` (5 cases).
- `npm run check` / `npm run format:check` / `npx vitest run` (33 tests, incl. 14 new `itemDiff.test.ts`) —
  all clean (pre-existing unrelated errors only in `bleScanner.svelte.ts`/`SuggestedTagChips.svelte`,
  confirmed present on `main`).
- `npm run lint` could not run — pre-existing, unrelated environment issue (`eslint-plugin-tailwindcss`
  fails to resolve `tailwindcss`), same as M1 found.
- `npm run build` succeeds; `/items/[id]` is present in the compiled output.
- **Full end-to-end against a real Homebox 0.26.1**, through the actual running FastAPI app (not just unit
  stubs): created an item, set a custom field, moved it via `{locationId}` and confirmed it landed at the new
  `parentId` with the custom field intact; fetched `GET /items/{id}` and confirmed breadcrumb/attachments/
  parent projection; uploaded two attachments, set the second as primary, deleted the first, and confirmed
  the thumbnail proxy serves the correct image; confirmed `GET /items/by-asset-id/{assetId}` now reports the
  real location before and after a move (the bug #1/#3 interaction fix); deleted an item. Also confirmed the
  three "bug" scenarios reproduce on a stub of the *old* code and are fixed by the new code.

## Open Items / Known Limitations

- **Concurrent edit conflicts remain unhandled.** Homebox has no ETag/versioning, so two open edit sessions
  on the same item can still clobber each other. Mitigated, not solved: `itemDetailWorkflow.save()` sends
  only the fields that actually changed (`diffItem`), which shrinks the clobber window to genuinely
  conflicting fields rather than the whole record. A Homebox-side rejection surfaces as a toast + inline
  error, not a silent failure.
- **`extra="forbid"` on `ItemUpdateRequest` is technically a breaking change** for any client sending unknown
  keys. Only two callers exist (`submission.svelte.ts`, `relocate.svelte.ts`) and both were updated/verified
  compatible — but a stale cached PWA bundle sending a since-removed field will get a 422 instead of a
  silent drop. Considered the correct trade.
- **MCP's `UpdateItemTool` (`src/homebox_companion/mcp/tools.py`) has the same custom-fields-wiping bug as #2
  above** — it never sends `fields` either. Out of scope for this milestone; `_build_item_update_payload` is
  the natural fix for a follow-up.
- `upload_attachment_typed()`'s assumption of a nested `document` key on the upload response doesn't match
  Homebox 0.26.1's actual shape (the whole updated item, attachment nested under `attachments`) — found
  during Step 0 verification, looks pre-existing and unused by any current caller. Not fixed here.
- No demo-mode gating on the detail page's destructive actions (per product decision for this milestone) —
  unlike chat, which disables destructive actions in demo mode.

## Superseded: Move Items feature (formerly RELOCATE.md)

The standalone `/relocate` page predates this milestone and stays as-is; M2 didn't replace it, but the
**Move** action added here calls the same underlying update as `relocateWorkflow` for consistency.
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
tags; attachments can be added/removed/re-primaried. **All satisfied**, verified against a real Homebox
instance end-to-end.
