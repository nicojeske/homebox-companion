"""Live probe for M2 (Item Detail & Full Editing) — resolves risk before writing production code.

Answers, against a real Homebox 0.26.1 container (the ``homebox_container`` session fixture):

1. Does ``PUT /entities/{id}`` honor ``locationId``, or only ``parentId``?
2. Does a PUT that omits ``fields`` wipe an item's custom fields?
3. What body does ``PUT /entities/{id}/attachments/{aid}`` need to set ``primary``?
4. What does ``DELETE /entities/{id}/attachments/{aid}`` do/return?
5. What shape does ``GET /entities/{id}/path`` return?
6. Does ``GET /assets/{assetId}`` return ``parent`` or ``location`` per item?

Run with: uv run pytest -m live tests/test_items_live.py
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from homebox_companion import HomeboxClient, ItemCreate

pytestmark = pytest.mark.live


async def _login(client: HomeboxClient, credentials: tuple[str, str]) -> str:
    username, password = credentials
    response = await client.login(username, password)
    return response["token"]


@pytest.mark.asyncio
async def test_put_entities_location_field_behavior(
    homebox_api_url: str,
    homebox_credentials: tuple[str, str],
    cleanup_items: list[str],
    cleanup_locations: list[str],
) -> None:
    """Q1: create in location A, PUT with both locationId=B and parentId=A set — see which wins."""
    async with HomeboxClient(base_url=homebox_api_url) as client:
        token = await _login(client, homebox_credentials)

        timestamp = datetime.now(UTC).isoformat(timespec="seconds")
        loc_a = await client.create_location(token, name=f"M2 Probe A {timestamp}")
        loc_b = await client.create_location(token, name=f"M2 Probe B {timestamp}")
        cleanup_locations.append(loc_a["id"])
        cleanup_locations.append(loc_b["id"])

        created = await client.create_item(
            token,
            ItemCreate(name=f"M2 Probe Item {timestamp}", parent_id=loc_a["id"]),  # ty: ignore[unknown-argument]
        )
        item_id = created["id"]
        cleanup_items.append(item_id)

        full_item = await client.get_item(token, item_id)
        parent_before = full_item.get("parent") or full_item.get("location") or {}
        print(f"\n[Q1] Item created; parent/location before update: {parent_before}")

        # Send BOTH keys, deliberately contradictory, mirroring today's buggy update_item payload.
        update_payload = {
            "name": full_item.get("name"),
            "description": full_item.get("description", ""),
            "quantity": full_item.get("quantity", 1),
            "assetId": full_item.get("assetId"),
            "locationId": loc_b["id"],
            "parentId": loc_a["id"],
            "tagIds": [],
        }
        await client.update_item(token, item_id, update_payload)

        refetched = await client.get_item(token, item_id)
        parent_after = refetched.get("parent") or refetched.get("location") or {}
        print(f"[Q1] parent/location after locationId={loc_b['id']!r}, parentId={loc_a['id']!r}: {parent_after}")
        print(f"[Q1] Landed in loc_b (locationId wins)? {parent_after.get('id') == loc_b['id']}")
        print(f"[Q1] Landed in loc_a (parentId wins)?   {parent_after.get('id') == loc_a['id']}")
        print(f"[Q1] No-op (neither applied)?           {parent_after.get('id') == parent_before.get('id')}")


@pytest.mark.asyncio
async def test_put_entities_omitting_fields_effect_on_custom_fields(
    homebox_api_url: str,
    homebox_credentials: tuple[str, str],
    cleanup_items: list[str],
) -> None:
    """Q2: set a custom field via PUT, then PUT again without 'fields' — does it survive?"""
    async with HomeboxClient(base_url=homebox_api_url) as client:
        token = await _login(client, homebox_credentials)

        timestamp = datetime.now(UTC).isoformat(timespec="seconds")
        locations = await client.list_locations(token)
        assert locations
        location_id = locations[0]["id"]

        created = await client.create_item(
            token,
            ItemCreate(name=f"M2 Fields Probe {timestamp}", parent_id=location_id),  # ty: ignore[unknown-argument]
        )
        item_id = created["id"]
        cleanup_items.append(item_id)

        full_item = await client.get_item(token, item_id)

        # Step 1: PUT with a custom field set.
        payload_with_field = {
            "name": full_item.get("name"),
            "description": full_item.get("description", ""),
            "quantity": full_item.get("quantity", 1),
            "assetId": full_item.get("assetId"),
            "parentId": location_id,
            "tagIds": [],
            "fields": [{"name": "Probe Field", "textValue": "probe-value", "type": "text"}],
        }
        after_set = await client.update_item(token, item_id, payload_with_field)
        print(f"\n[Q2] After setting custom field, item.get('fields'): {after_set.get('fields')}")
        assert after_set.get("fields"), "Custom field was not set — check payload shape before proceeding"

        # Step 2: PUT again, omitting 'fields' entirely (today's actual behavior).
        payload_without_fields = {
            "name": full_item.get("name"),
            "description": "changed via probe",
            "quantity": full_item.get("quantity", 1),
            "assetId": full_item.get("assetId"),
            "parentId": location_id,
            "tagIds": [],
        }
        after_omit = await client.update_item(token, item_id, payload_without_fields)
        print(f"[Q2] After PUT omitting 'fields', item.get('fields'): {after_omit.get('fields')}")
        print(f"[Q2] Custom field wiped by omission? {not after_omit.get('fields')}")


@pytest.mark.asyncio
async def test_attachment_update_and_delete_shapes(
    homebox_api_url: str,
    homebox_credentials: tuple[str, str],
    cleanup_items: list[str],
    single_item_single_image_path,
) -> None:
    """Q3/Q4: exact body PUT /attachments/{aid} needs, and DELETE's status/effect."""
    async with HomeboxClient(base_url=homebox_api_url) as client:
        token = await _login(client, homebox_credentials)

        timestamp = datetime.now(UTC).isoformat(timespec="seconds")
        locations = await client.list_locations(token)
        assert locations
        location_id = locations[0]["id"]

        created = await client.create_item(
            token,
            ItemCreate(name=f"M2 Attachment Probe {timestamp}", parent_id=location_id),  # ty: ignore[unknown-argument]
        )
        item_id = created["id"]
        cleanup_items.append(item_id)

        image_bytes = single_item_single_image_path.read_bytes()
        upload_response = await client.upload_attachment(
            token=token,
            item_id=item_id,
            file_bytes=image_bytes,
            filename="probe.jpg",
            mime_type="image/jpeg",
            attachment_type="photo",
        )
        print(f"\n[Q3/Q4] Upload response (this is the whole ITEM, not a bare attachment object): {upload_response}")
        # NOTE: upload_attachment's raw response is the full updated item, with the new
        # attachment nested under 'attachments' — the top-level 'id' is the item's id, not
        # the attachment's. client.upload_attachment_typed's assumption of a 'document' key
        # does not match this shape either; that path looks unused/stale (separate from M2).
        attachments = upload_response.get("attachments", [])
        assert attachments, f"No attachments on upload response: {upload_response}"
        attachment_id = attachments[-1]["id"]
        print(f"[Q3/Q4] Actual attachment id: {attachment_id}")

        # Probe several candidate bodies for PUT — report what each does, don't assert (exploratory).
        candidate_bodies = [
            {"primary": True},
            {"title": "probe.jpg", "type": "photo", "primary": True},
        ]
        for body in candidate_bodies:
            response = await client.client.put(
                f"{client.base_url}/entities/{item_id}/attachments/{attachment_id}",
                headers=client._auth_headers(token, content_type="application/json"),
                json=body,
            )
            print(f"[Q3] PUT body={body} -> status={response.status_code}, text={response.text[:300]!r}")

        refetched = await client.get_item(token, item_id)
        print(f"[Q3] Attachments after PUT probes: {refetched.get('attachments')}")

        delete_response = await client.client.delete(
            f"{client.base_url}/entities/{item_id}/attachments/{attachment_id}",
            headers=client._auth_headers(token),
        )
        print(f"[Q4] DELETE -> status={delete_response.status_code}, text={delete_response.text[:300]!r}")

        refetched_after_delete = await client.get_item(token, item_id)
        print(f"[Q4] Attachments after DELETE: {refetched_after_delete.get('attachments')}")


@pytest.mark.asyncio
async def test_get_item_path_shape(
    homebox_api_url: str,
    homebox_credentials: tuple[str, str],
    cleanup_items: list[str],
    cleanup_locations: list[str],
) -> None:
    """Q5: what does GET /entities/{id}/path return, and does it include the item itself?"""
    async with HomeboxClient(base_url=homebox_api_url) as client:
        token = await _login(client, homebox_credentials)

        timestamp = datetime.now(UTC).isoformat(timespec="seconds")
        parent_loc = await client.create_location(token, name=f"M2 Path Probe Parent {timestamp}")
        cleanup_locations.append(parent_loc["id"])
        child_loc = await client.create_location(
            token, name=f"M2 Path Probe Child {timestamp}", parent_id=parent_loc["id"]
        )
        cleanup_locations.append(child_loc["id"])

        created = await client.create_item(
            token,
            ItemCreate(name=f"M2 Path Probe Item {timestamp}", parent_id=child_loc["id"]),  # ty: ignore[unknown-argument]
        )
        item_id = created["id"]
        cleanup_items.append(item_id)

        path = await client.get_item_path(token, item_id)
        print(f"\n[Q5] GET /entities/{{id}}/path returned: {path}")


@pytest.mark.asyncio
async def test_get_item_by_asset_id_parent_field_shape(
    homebox_api_url: str,
    homebox_credentials: tuple[str, str],
    cleanup_items: list[str],
) -> None:
    """Q6: does GET /assets/{assetId} return 'parent' or 'location' per item?"""
    async with HomeboxClient(base_url=homebox_api_url) as client:
        token = await _login(client, homebox_credentials)

        locations = await client.list_locations(token)
        assert locations
        location_id = locations[0]["id"]

        timestamp = datetime.now(UTC).isoformat(timespec="seconds")
        created = await client.create_item(
            token,
            ItemCreate(name=f"M2 AssetId Probe {timestamp}", parent_id=location_id),  # ty: ignore[unknown-argument]
        )
        item_id = created["id"]
        cleanup_items.append(item_id)

        # Ensure it has an asset ID assigned before looking it up by asset ID.
        await client.ensure_asset_ids(token)
        full_item = await client.get_item(token, item_id)
        asset_id = full_item.get("assetId")
        assert asset_id, "Item has no assetId after ensure_asset_ids — cannot probe by-asset-id lookup"

        by_asset = await client.get_item_by_asset_id(token, asset_id)
        print(f"\n[Q6] GET /assets/{{assetId}} item keys: {sorted(by_asset.keys())}")
        print(f"[Q6] 'parent' present: {'parent' in by_asset}, value: {by_asset.get('parent')}")
        print(f"[Q6] 'location' present: {'location' in by_asset}, value: {by_asset.get('location')}")
