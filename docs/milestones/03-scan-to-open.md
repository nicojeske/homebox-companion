# M3 — Scan-to-Open

Status: ✅ Done · Depends on: M2 · Blocks: nothing

## Overview

Scan any Homebox QR tag from the browse screen and land directly on the right page — the item detail page
(M2) for an asset tag, or a filtered browse view (M1) for a location tag. Built entirely on existing
scanning and parsing infrastructure; no new detection logic was needed.

**Scope decisions made during planning:**
- `/scan` is a full route (needed for the `?code=` deep link), reached via a scan button in the `/browse`
  header — not a sixth bottom-nav tab. The existing "Scan" nav tab means the photo-capture workflow and was
  left alone.
- BLE + camera listen only while `/scan` is mounted, not globally — a global listener would collide with
  `AssetIdInput.svelte`, which already subscribes to BLE app-wide while the review page is open.

## Correction to the original plan

The original plan described `scanResolver.ts` as a single `resolveQrUrl() → parseScannedCode() → route
decision` chain shared by `/scan` and `/relocate`. That didn't hold once `/relocate` was traced: it never
routes — it sets a move destination or moves an item. Neither does `/location` or `AssetIdInput.svelte`,
the other two places that inlined the same resolve+parse chain. The module ended up as two separate
exports instead:

| Export | Used by |
|---|---|
| `resolveScannedCode(raw)` — resolve + parse, never throws | `/scan`, `/relocate`, `/location`, `AssetIdInput.svelte` |
| `navigateToScannedCode(code)` — the route decision | `/scan` only |

## Architecture

### New Files

| File | Notes |
|------|-------|
| `frontend/src/lib/services/scanResolver.ts` | `resolveScannedCode()` wraps `resolveQrUrl()` → `parseScannedCode()`; `navigateToScannedCode()` does the asset/location/unknown routing described below. Neither throws on a not-found lookup — a 404 shows a warning toast and simply doesn't navigate. |
| `frontend/src/routes/scan/+page.svelte` | Dual BLE + camera input, same pattern as `/relocate`. Supports the deep link `/scan?code=<raw>` (read once in `onMount` via `$app/state`, then stripped with `replaceState` so a refresh doesn't replay it — the first `searchParams` read in the codebase). |
| `frontend/src/lib/services/scanResolver.test.ts` | 8 vitest cases (asset found/404/other-error, location found/404, unknown text, and the `reset()`-before-filter-set ordering for both location and unknown paths). |

### Modified Files

| File | Change |
|------|--------|
| `frontend/src/routes/relocate/+page.svelte` | Swapped the inlined `resolveQrUrl`+`parseScannedCode` pair for `resolveScannedCode`. Behavior unchanged. |
| `frontend/src/routes/location/+page.svelte` | Same swap, **plus two bug fixes found while tracing it** (see below). |
| `frontend/src/lib/components/form/AssetIdInput.svelte` | Same swap; simplified its `unknown`-kind fallback to use `parsed.raw` directly instead of re-deriving it from the resolved URL string. |
| `frontend/src/lib/utils/routeGuard.ts` | Added `routeGuards.scan` (auth-only, same shape as `browse`/`relocate`/`itemDetail`). |
| `frontend/src/lib/navigation/config.ts` | Added `/scan` to the Browse nav item's `activeRoutes` so the tab stays highlighted; no new nav entry. |
| `frontend/src/routes/browse/+page.svelte` | Added a scan button in the header linking to `/scan`. |

### Bugs fixed along the way

Found while tracing the three existing call sites during planning; fixed as part of the refactor rather
than filed separately.

1. **`/location` had no re-entrancy guard.** It set `isProcessingQr = true` but never checked it on entry,
   so two fast BLE scans both ran to completion concurrently. `/relocate` already guarded correctly; copied
   that shape (`if (isProcessingQr) return;` at the top of `handleScan`).
2. **`bleScanner` ignores async callback rejections** (`bleScanner.svelte.ts` calls each subscriber
   synchronously and drops the returned promise). `resolveScannedCode` itself never throws — both
   `resolveQrUrl` and `parseScannedCode` already degrade gracefully — so this is now moot for the resolve
   step; each caller's own `try/catch` still covers its follow-up work.
3. **The new `/scan` page deliberately does *not* repeat a third bug found in `/relocate`**: its camera
   `onError` handler sets `showQrScanner = false`, unmounting `QrScanner` before the user can see the
   file-upload fallback it renders on non-HTTPS origins. `/scan` follows `/location`'s pattern instead
   (log + toast only, scanner stays mounted) — this matters directly since the app normally runs over plain
   HTTP on `localhost:8000`, where the camera path is unavailable and the file-upload fallback is the only
   way to test scanning without a real device. `/relocate` itself was left as-is (out of scope).

### Data Flow

```
BLE scan / Camera scan / ?code= deep link
  ↓
resolveScannedCode()   — resolveQrUrl() then parseScannedCode(), never throws
  ↓
navigateToScannedCode()   [/scan only; /relocate, /location, AssetIdInput each do their own thing]
  ├── 'asset'    → GET /api/items/by-asset-id/{id} → goto /items/{uuid}; 404 → warning toast, no navigation
  ├── 'location' → GET /api/locations/{id} → browseWorkflow.reset() → setLocationFilter() → search() → goto /browse
  └── 'unknown'  → browseWorkflow.reset() → setQuery(raw) → search() → goto /browse
```

`reset()` must run before the filter/query setter — it bumps `browseWorkflow`'s internal search token, so
running it after would invalidate the very search this navigation just kicked off. `browseWorkflow` is a
singleton never reset on `/browse`'s own mount, so seeding it before navigating is what makes the filter/
query show up already applied when the page renders.

## Verification performed

- `uv run ruff check` / `uv run ty check` / `uv run vulture --min-confidence 70` / `uv run pytest` (225
  passed) — all clean. No backend changes were needed (the by-asset-id and location lookup endpoints
  already existed and already 404 cleanly), so there's no new pytest coverage this milestone.
- `npx vitest run` (41 passed, 8 new) / `npm run check` / `npm run lint` / `npm run format:check` / `npm run
  build` — all clean.
- **Also fixed, at the user's request, everything M1/M2 had flagged as pre-existing and out of scope**
  (all previously broken independently of this milestone's changes):
  - `npm run lint` couldn't run at all (`eslint-plugin-tailwindcss` failed with "Could not resolve
    tailwindcss"). Root cause: `eslint.config.js`'s `settings.tailwindcss.config` was a bare relative
    filename; `tailwind-api-utils` derives a `pwd` from `path.dirname()` of that string (`"."` for a bare
    filename) and hands it to `mlly`'s file-URL-based resolver, which throws on a non-absolute base. Fixed
    by pointing `config` at an absolute path built from `eslint.config.js`'s own `import.meta.url`. Once
    lint could actually run, it surfaced a handful of real (pre-existing, unrelated) findings, fixed
    alongside: two `svelte/prefer-svelte-reactivity` findings (`SuggestedTagChips.svelte` converted to a
    real `SvelteSet` since it's read reactively in the template; `review.svelte.ts`'s local scratch `Set` is
    genuinely local and got a disable-comment instead, since a `SvelteSet` there would add tracking overhead
    for no reactive consumer), an unused import and a missing `each`-block key in `relocate/+page.svelte`,
    and a missing `eslint-disable` on `review/+page.svelte`'s external "View in Homebox" link (the same
    pattern already used for other external links elsewhere in the app).
  - `npm run check` had 4 errors in `bleScanner.svelte.ts` — the Web Bluetooth API types
    (`BluetoothDevice`, `navigator.bluetooth`, etc.) were never declared. Added `@types/web-bluetooth` as a
    dev dependency; it also needed adding to `tsconfig.json`'s `compilerOptions.types` alongside `"node"`,
    since SvelteKit's generated tsconfig sets that array explicitly, which (per TypeScript's rules) turns
    off automatic inclusion of every other `@types/*` package.
  - `uv run pytest`'s one failure (`test_prompts.py::TestBuildTagPrompt::test_with_no_tags_says_none_available`)
    was a stale assertion from an earlier, unrelated commit (`5eb0b84`) that intentionally changed
    `build_tag_prompt`'s no-tags message from "omit tagIds" to "Suggest relevant new tag names in
    suggestedTags" without updating this test. Updated the assertion to match.
  - `uv run ty check` had 5 warnings in `mcp/executor.py` (unrelated to this milestone): an unannotated
    `all_schemas: list = []` let `ty` infer the loop body's heterogeneous dict-literal type instead of
    matching `_schema_cache`'s declared `list[dict[str, Any]]`, which made `s["function"]["name"]` look
    like indexing into a `str`. Fixed with an explicit annotation.

## Open Items / Known Limitations

- BLE scanning is Chrome/Chromium-on-Android + HTTPS only; Firefox/Safari unsupported — same constraint as
  `/relocate`.
- Camera QR detection requires HTTPS; falls back to file-upload photo capture on HTTP, per `QrScanner.svelte`.
- `{kind: 'location'}` routing goes to filtered `/browse`; switch to `/locations/[id]` once M4 lands.
- **Not verified end-to-end against a live device**: no HTTPS origin or Android/Chromium device was
  available in this environment, so the BLE and camera-viewfinder paths were verified by code
  read-through and the unit suite only, not by an actual scan. The `?code=` deep link, the 404 paths, and
  the three refactored call sites' existing behavior were the parts practical to verify directly (build
  output confirms `/scan` is present in the compiled app).

## Done When

One scan from the browse screen opens the item's detail page, with both BLE and camera working. **Code
complete and unit-verified**; live-device verification (BLE scanner, camera viewfinder over HTTPS) is still
outstanding per the note above.

## Follow-up: live scan on Browse and Item Detail

The scoping decision above ("BLE + camera listen only while `/scan` is mounted, not globally - a global
listener would collide with `AssetIdInput.svelte`") was revisited once the actual friction became clear:
with the scanner already connected, requiring a trip through `/scan` to open an item is an unnecessary
extra step. The collision concern doesn't actually block listening on `/browse` or `/items/[id]` in view
mode - `AssetIdInput` was never mounted on either.

- `frontend/src/lib/services/scanToOpen.svelte.ts` - the shared `resolveScannedCode` -> `navigateToScannedCode`
  handler (lifted out of `/scan`'s own `handleScan`) with one module-level re-entrancy guard, so `/scan`,
  `/browse`, and `/items/[id]` can't double-handle the same scan.
- `frontend/src/lib/components/BleScannerChip.svelte` - a header-sized connect/status control, added to
  both `/browse` and `/items/[id]` so a scanner can be connected without visiting `/scan` first (Web
  Bluetooth's `requestDevice()` needs a user gesture, so this couldn't be automatic).
- `/browse` now subscribes to `bleScanner` for its whole mounted lifetime, same shape as `/scan`.
- `/items/[id]` subscribes too, but only acts on a scan while `itemDetailWorkflow.mode !== 'edit'` -
  `AssetIdInput` is rendered exclusively inside the edit-mode branch of that page, so the two listeners
  are never simultaneously live for the same scan: edit mode fills the asset ID field (unchanged
  behavior), view mode navigates to the newly scanned item.
- A **global** (root-layout) listener is still rejected - it would still collide with `AssetIdInput` on
  `/review` and `/capture`, which are not part of this change.
