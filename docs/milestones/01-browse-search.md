# M1 — Browse & Unified Search

Status: ✅ Done · Depends on: nothing · Blocks: M2, M3, M4

## Overview

A `/browse` route with a single search box that returns matching items, locations, and tags. Today
`GET /api/items` (`server/api/items.py:19`) only returns `id/name/quantity/thumbnailId` and filters solely
by `location_id`, even though `HomeboxClient.list_items()`
(`src/homebox_companion/homebox/client.py:908`) already supports `q`, `tag_ids`, `page`, `page_size`. This
milestone exposes that existing capability through the REST layer and builds a UI on top of it.

## Architecture

### Backend

| Change | File | Status |
|--------|------|--------|
| Widen `GET /api/items` | `server/api/items.py` | ✅ Done — `q`, `tag_ids`, `page`, `page_size` query params pass through to `client.list_items()`. Returns full paginated envelope (`items`, `page`, `pageSize`, `total`). Item projection now includes `assetId`, `description`, `location`, `tags`, `updatedAt` via a new `_build_search_result()` helper that resolves Homebox 0.26's `parent`/`location` field rename the same way `homebox_companion.homebox.views` does. |
| New `ItemSearchResult`/`ItemListResponse` schemas | `server/schemas/items.py` | ✅ Done |
| `GET /api/items/{item_id}` (full detail) | — | **Deferred to M2.** Nothing in M1 consumes it yet (no detail page exists), and M2 needs a superset shape (attachments, custom fields, path) anyway — building it once there avoids a schema guess-then-refactor. |

**Breaking change, resolved:** `GET /api/items` now always returns the paginated envelope instead of a bare
array. The one existing caller (`frontend/src/lib/api/items.ts` `list()`, used by `ItemPickerModal.svelte`)
was updated to unwrap `.items` — its own return type (`ItemSummary[]`) is unchanged, so `ItemPickerModal`
needed no changes at all.

Pytest coverage: `tests/test_items_search.py` (9 tests — envelope shape, location/tag projection incl. the
`parent`/`location` fallback, missing-field handling, filter passthrough, pagination).

**Also fixed:** `server/dependencies.py` `get_token()` referenced an undefined `client` name (a pre-existing
bug, unrelated to this milestone, caught by `ty check` and confirmed live — it broke every authenticated
request once the token-validation cache went cold). One-line fix: resolve the client via `get_client()`
before use. This was blocking end-to-end verification of M1 itself, so it was fixed in place rather than
filed separately.

### Frontend

| File | Status | Notes |
|------|--------|-------|
| `frontend/src/lib/types/index.ts` | ✅ Done | `ItemLocationRef`, `ItemTagRef`, `ItemSearchResult`, `ItemListResponse`. |
| `frontend/src/lib/api/items.ts` | ✅ Done | `search(options)` returns the full envelope; `list()` unwraps `.items` for backward compatibility. |
| `frontend/src/lib/workflows/browse.svelte.ts` | ✅ Done | New singleton `browseWorkflow` (plain getter-based class, not the `scanWorkflow` Proxy pattern): `query`, `locationFilter`, `tagFilter`, `items`, `total`, paging via `search()`/`loadMore()`, plus `matchingLocations`/`matchingTags` derived from `locationStore.flatList`/`tagStore.tags` (populated by `ensureAuxData()`). |
| `frontend/src/routes/browse/+page.svelte` | ✅ Done | Debounced (300ms) search input, active-filter chips, location/tag match chips (tapping one sets it as a filter — see below), item list with thumbnails (reusing the same blob-URL pattern as `ItemPickerModal`), Load More pagination, `PullToRefresh` for refresh. |
| `frontend/src/lib/navigation/config.ts` + `NavIcon.svelte` | ✅ Done | Added `browse` nav item (lucide `Search` icon) between Scan and Settings. |
| `frontend/src/lib/utils/routeGuard.ts` | ✅ Done | Added `routeGuards.browse` (auth-only, same shape as `routeGuards.relocate`). |

Reuse confirmed: `locationStore.flatList` (populated via `locationNavigator.loadTree()`) and `tagStore.tags`
(via `tagStore.fetchTags()`) are used as-is for the location/tag match lanes — no new endpoints or
duplicated disambiguation logic.

**Design decision — no dead links:** Since `/items/[id]` (M2) and `/locations/[id]`/`/tags/[id]` (M4) don't
exist yet, browse results don't try to navigate to pages that aren't built:
- Tapping a location or tag chip (in the match lanes, or on an item's own tag chips) **sets it as a search
  filter** rather than navigating anywhere.
- Tapping an item's name opens it directly in Homebox itself (`{homebox_url}/item/{id}`, new tab) — reusing
  the exact deep-link pattern `relocate/+page.svelte` already uses for its move log, gated on `homebox_url`
  from `/api/config` being available.

This gives the milestone real standalone value without building throwaway navigation that M2 will replace.

## Verification performed

- `uv run ruff check` / `uv run ty check` / `uv run pytest` — all clean (one pre-existing unrelated failure
  in `test_prompts.py`, confirmed present on `main` before this work).
- `npm run check` — clean (pre-existing unrelated errors only in `bleScanner.svelte.ts`, confirmed present
  on `main`).
- `npm run format:check` — clean for all files touched by this milestone.
- `npm run lint` could not run — pre-existing, unrelated environment issue (`eslint-plugin-tailwindcss`
  fails to resolve `tailwindcss`), reproduced identically on a clean `main` checkout.
- `npm run build` succeeds; `/browse` is present in the compiled output.
- **End-to-end against a real Homebox 0.26.1** (spun up via `docker run ... ghcr.io/sysadminsmedia/homebox:0.26.1`
  with `HBOX_DEMO=true`, since the public demo server rejected the documented demo credentials at test
  time): verified `GET /api/items` with `q`, `tag_ids`, `location_id`, and `page`/`page_size` all filter
  correctly, and that `location`/`tags` are populated correctly per item.
- **Not verified:** the `/browse` page's UI in an actual browser (no browser-automation tool was available
  in this environment) — verified instead via the SPA build output, a manual code read-through, and the
  passing type-check.

## Open Items / Known Limitations

- Adding a `browse` nav item makes 5 bottom-nav entries; `BottomNav.svelte` handles this fine (`flex-1`
  items), just narrower touch targets on small screens. Not folding `move` under browse for now.
- Homebox's `/entities` `q` search matched broadly on a single-letter query in manual testing (likely a
  substring match across name/description) — no ranking or highlighting was added; revisit if search
  quality becomes a real complaint.
- Pagination uses an explicit "Load more" button, not infinite scroll, to avoid interaction with
  `PullToRefresh` at the top of the same scroll container.
- `GET /api/items/{item_id}` (full detail) is deferred to M2, where it's actually consumed.

## Done When

Typing a term returns matching items, locations, and tags; filtering by location or tag works; paging works
past 50 results. **All satisfied**, verified against a real Homebox instance.
