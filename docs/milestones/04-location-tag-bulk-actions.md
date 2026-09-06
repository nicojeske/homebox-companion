# M4 — Location & Tag Pages + Bulk Actions

Status: 📋 Planned · Depends on: M1, M2 · Blocks: nothing

## Overview

Locations and tags become first-class destinations (not just filters), and the browse screen gains
multi-select for bulk move/tag/delete. Homebox has no native bulk endpoint, so bulk operations are
implemented client-side as a sequential loop with per-item progress, mirroring the pattern
`SubmissionService` already uses for batch item creation.

## Architecture

### Backend

| Change | File | Notes |
|--------|------|-------|
| New `GET /api/tags/{id}` | `server/api/tags.py` | Client method (`client.get_tag()`) already exists; route doesn't. |
| New `PUT /api/tags/{id}` | `server/api/tags.py` | Client method (`client.update_tag()`) already exists; route doesn't. |
| New `DELETE /api/tags/{id}` | `server/api/tags.py` | Client method (`client.delete_tag()`) already exists; route doesn't. |
| New `DELETE /api/locations/{id}` | `server/api/locations.py` | Client method (`client.delete_location()`) already exists; route doesn't. |

### Frontend

| File | Status | Notes |
|------|--------|-------|
| `frontend/src/routes/locations/[id]/+page.svelte` | Not started | Contents list (items with `parentIds=<id>`, via M1's widened `GET /api/items`), child locations, rename/edit via existing `PUT /api/locations/{id}`, breadcrumb from `client.get_location_tree()`. Reuse `locationNavigator` (`frontend/src/lib/services/locationNavigator.svelte.ts`) for tree/breadcrumb logic. |
| `frontend/src/routes/tags/[id]/+page.svelte` | Not started | Items carrying the tag (`GET /api/items?tag_ids=`, from M1), rename, delete, item count via `client.get_statistics_by_tag()`. |
| Bulk selection mode in `/browse` | Not started | Move to location / add-remove tag / delete, over multiple selected items. |

Bulk action implementation: sequential loop over the existing single-item endpoints
(`PUT /api/items/{id}`, `DELETE /api/items/{id}`) with a per-item progress list — mirror
`SubmissionService` (`frontend/src/lib/workflows/submission.svelte.ts`), which already models per-item
status + retry-failed for this exact shape of problem.

## Open Items / Known Limitations

- No Homebox bulk endpoint exists — bulk ops will be N sequential requests. For large selections this could
  be slow; consider a reasonable client-side concurrency cap (existing precedent: `MAX_CONCURRENT_REQUESTS
  = 30` in `frontend/src/lib/workflows/analysis.svelte.ts`, though that's for AI calls not Homebox writes —
  check Homebox's own rate tolerance before reusing that number).
- Bulk move shares the same undo problem the relocate move-log has today (in-memory only, cleared on
  refresh — see M2's "Superseded: Move Items feature" section). Consider persisting both the same way if
  either turns out to need durable undo in practice.
- Location delete needs confirmation UX that clearly states what happens to child items/locations —
  confirm Homebox's actual cascade behavior (does it block delete-with-children, reparent them, or cascade
  delete?) before wiring the button.

## Done When

Tapping a location or tag in browse results opens a usable page, and a multi-select move of 10 items
reports per-item success/failure with retry.
