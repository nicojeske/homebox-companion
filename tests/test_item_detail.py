"""Tests for the new GET /api/items/{item_id} endpoint (M2, deferred from M1).

Covers parent-is-location vs. parent-is-item discrimination, path-fetch failure
degrading to an empty breadcrumb, attachment/thumbnail projection, and the
route-ordering regression that a new {item_id} catch-all must not swallow.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


class _StubHomeboxClient:
    """Minimal stand-in for HomeboxClient recording get_item/get_item_path calls."""

    def __init__(
        self,
        item: dict[str, Any],
        path: list[dict[str, Any]] | None = None,
        path_error: Exception | None = None,
        asset_lookup: dict[str, Any] | None = None,
    ) -> None:
        self.item = item
        self.path = path if path is not None else []
        self.path_error = path_error
        self.asset_lookup = asset_lookup

    async def get_item(self, token: str, item_id: str) -> dict[str, Any]:
        return self.item

    async def get_item_path(self, token: str, item_id: str) -> list[dict[str, Any]]:
        if self.path_error is not None:
            raise self.path_error
        return self.path

    async def get_item_by_asset_id(self, token: str, asset_id: str) -> dict[str, Any]:
        if self.asset_lookup is None:
            raise ValueError(f"No item found with asset ID: {asset_id}")
        return self.asset_lookup


def _make_client(stub: _StubHomeboxClient) -> TestClient:
    from server.api import items as items_module
    from server.dependencies import get_client, get_token

    app = FastAPI()
    app.include_router(items_module.router)
    app.dependency_overrides[get_client] = lambda: stub
    app.dependency_overrides[get_token] = lambda: "fake-token"
    return TestClient(app)


BASE_ITEM: dict[str, Any] = {
    "id": "item-1",
    "name": "Cordless Drill",
    "description": "18V drill",
    "quantity": 2,
    "assetId": "000-001",
    "insured": False,
    "archived": False,
    "manufacturer": "Acme",
    "modelNumber": "M-100",
    "serialNumber": "SN-42",
    "purchasePrice": 99.5,
    "purchaseFrom": "Hardware Store",
    "notes": "Original notes",
    "tags": [{"id": "tag-1", "name": "Power Tools"}],
    "fields": [{"id": "f1", "type": "text", "name": "Condition", "textValue": "New"}],
    "attachments": [
        {
            "id": "att-1",
            "title": "photo.jpg",
            "type": "photo",
            "primary": True,
            "mimeType": "image/jpeg",
            "createdAt": "2026-01-01T00:00:00Z",
        }
    ],
    # Confirmed live: the primary attachment's id is the item's top-level 'imageId' —
    # attachments[].thumbnail.id doesn't exist on a real Homebox 0.26.1 response.
    "imageId": "att-1",
    "createdAt": "2026-01-01T00:00:00Z",
    "updatedAt": "2026-01-02T00:00:00Z",
}


def test_detail_parent_is_location() -> None:
    item = {**BASE_ITEM, "parent": {"id": "loc-1", "name": "Garage", "entityType": {"isLocation": True}}}
    client = _make_client(_StubHomeboxClient(item))

    response = client.get("/items/item-1")

    assert response.status_code == 200
    data = response.json()
    assert data["parent"] == {"id": "loc-1", "name": "Garage", "isLocation": True}
    assert data["thumbnailId"] == "att-1"
    assert data["attachments"][0]["primary"] is True
    assert data["fields"][0] == {"name": "Condition", "type": "text", "textValue": "New"}


def test_detail_parent_is_another_item() -> None:
    item = {**BASE_ITEM, "parent": {"id": "item-0", "name": "Toolbox", "entityType": {"isLocation": False}}}
    client = _make_client(_StubHomeboxClient(item))

    response = client.get("/items/item-1")

    assert response.status_code == 200
    assert response.json()["parent"] == {"id": "item-0", "name": "Toolbox", "isLocation": False}


def test_detail_parent_entity_type_absent_defaults_to_location() -> None:
    item = {**BASE_ITEM, "parent": {"id": "loc-1", "name": "Garage"}}
    client = _make_client(_StubHomeboxClient(item))

    response = client.get("/items/item-1")

    assert response.json()["parent"]["isLocation"] is True


def test_detail_path_failure_degrades_to_empty_breadcrumb() -> None:
    item = {**BASE_ITEM, "parent": None}
    client = _make_client(_StubHomeboxClient(item, path_error=RuntimeError("path endpoint down")))

    response = client.get("/items/item-1")

    assert response.status_code == 200
    assert response.json()["path"] == []


def test_detail_path_drops_the_items_own_trailing_segment() -> None:
    """get_item_path includes the item itself as its last entry (confirmed live), mislabeled
    'location' same as its ancestors — the breadcrumb must drop it unconditionally."""
    item = {**BASE_ITEM, "parent": {"id": "loc-2", "name": "Attic"}}
    raw_path = [
        {"type": "location", "id": "loc-1", "name": "House"},
        {"type": "location", "id": "loc-2", "name": "Attic"},
        {"type": "location", "id": "item-1", "name": "Cordless Drill"},  # the item itself
    ]
    client = _make_client(_StubHomeboxClient(item, path=raw_path))

    response = client.get("/items/item-1")

    assert response.json()["path"] == [
        {"id": "loc-1", "name": "House"},
        {"id": "loc-2", "name": "Attic"},
    ]


def test_detail_missing_attachments_and_fields() -> None:
    item = {"id": "item-2", "name": "Bare Item", "parent": None}
    client = _make_client(_StubHomeboxClient(item))

    response = client.get("/items/item-2")

    assert response.status_code == 200
    data = response.json()
    assert data["parent"] is None
    assert data["tags"] == []
    assert data["fields"] == []
    assert data["attachments"] == []
    assert data["thumbnailId"] is None


@pytest.mark.parametrize("asset_id", ["000-001", "by-asset-id-lookalike"])
def test_get_item_route_ordering_does_not_swallow_by_asset_id(asset_id: str) -> None:
    """A new GET /items/{item_id} must not shadow GET /items/by-asset-id/{asset_id}."""
    stub = _StubHomeboxClient(
        BASE_ITEM,
        asset_lookup={"id": "item-1", "name": "Cordless Drill", "assetId": asset_id},
    )
    client = _make_client(stub)

    response = client.get(f"/items/by-asset-id/{asset_id}")

    assert response.status_code == 200
    assert response.json()["id"] == "item-1"


def test_by_asset_id_location_populated_from_full_item_parent() -> None:
    """Regression for bug #3: GET /assets/{assetId} returns 'parent', not 'location'
    (confirmed live), so location must be derived from the full-item fetch, not from
    the asset-search result itself — this is what made relocateWorkflow's undo always
    move items to root."""
    item = {**BASE_ITEM, "parent": {"id": "loc-9", "name": "Basement"}}
    stub = _StubHomeboxClient(
        item,
        asset_lookup={"id": "item-1", "name": "Cordless Drill", "assetId": "000-001"},
    )
    client = _make_client(stub)

    response = client.get("/items/by-asset-id/000-001")

    assert response.status_code == 200
    data = response.json()
    assert data["locationId"] == "loc-9"
    assert data["locationName"] == "Basement"
