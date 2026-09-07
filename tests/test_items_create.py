"""Tests for POST /items (create_items) — specifically the custom asset ID path.

Homebox's create endpoint can't accept `assetId` at all (confirmed against the
upstream Go source: `EntityCreate.AssetID` is tagged `json:"-"`), so a custom
asset ID can only ever be applied via the follow-up PUT that `create_items`
already does for extended fields. Two things this must get right:

1. A supplied asset ID must actually reach that follow-up PUT (it used to be
   silently dropped — `ItemInput` had no `asset_id` field at all).
2. When no custom ID is supplied, the follow-up PUT must still echo back
   whatever asset ID Homebox auto-assigned at create time — Homebox's own
   update is a full replace (`SetAssetID` is unconditional), so an omitted
   `assetId` key would wipe it back to zero.

There was previously no test at all for POST /items.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


class _StubHomeboxClient:
    """Minimal stand-in for HomeboxClient recording create/update/ensure calls."""

    def __init__(self, *, created_asset_id: str = "") -> None:
        self._next_id = 1
        self._created_asset_id = created_asset_id
        self._items: dict[str, dict[str, Any]] = {}
        self.create_calls: list[Any] = []
        self.update_calls: list[dict[str, Any]] = []
        self.ensure_asset_ids_calls = 0

    async def create_item(self, token: str, item: Any) -> dict[str, Any]:
        self.create_calls.append(item)
        item_id = f"item-{self._next_id}"
        self._next_id += 1
        created = {
            "id": item_id,
            "name": item.name,
            "quantity": item.quantity,
            "description": item.description,
            "assetId": self._created_asset_id,
            "parent": {},
            "tags": [],
        }
        self._items[item_id] = created
        return created

    async def get_item(self, token: str, item_id: str) -> dict[str, Any]:
        return self._items[item_id]

    async def update_item(self, token: str, item_id: str, item_data: dict[str, Any]) -> dict[str, Any]:
        self.update_calls.append(item_data)
        self._items[item_id] = {**self._items[item_id], **item_data}
        return self._items[item_id]

    async def delete_item(self, token: str, item_id: str) -> None:
        del self._items[item_id]

    async def ensure_asset_ids(self, token: str) -> int:
        self.ensure_asset_ids_calls += 1
        return 0

    async def list_tags(self, token: str) -> list[dict[str, Any]]:
        return []


def _make_client(**stub_kwargs: Any) -> tuple[TestClient, _StubHomeboxClient]:
    from server.api import items as items_module
    from server.dependencies import get_client, get_token

    stub = _StubHomeboxClient(**stub_kwargs)
    app = FastAPI()
    app.include_router(items_module.router)
    app.dependency_overrides[get_client] = lambda: stub
    app.dependency_overrides[get_token] = lambda: "fake-token"
    return TestClient(app), stub


def test_create_with_custom_asset_id_applies_it_and_skips_ensure() -> None:
    """The headline bug: a user-supplied asset ID must reach the follow-up PUT
    (overriding whatever Homebox auto-assigned at create time), and since the
    item now has an asset ID, the group-wide ensure-asset-ids sweep must not run."""
    client, stub = _make_client(created_asset_id="000-005")

    response = client.post(
        "/items",
        json={"items": [{"name": "Drill", "asset_id": "a1110"}]},
    )

    assert response.status_code == 200
    assert len(stub.update_calls) == 1
    assert stub.update_calls[0]["assetId"] == "001-110"
    assert stub.ensure_asset_ids_calls == 0
    assert response.json()["created"][0]["assetId"] == "001-110"


def test_create_without_custom_asset_id_preserves_auto_assigned_one() -> None:
    """Regression test for the wipe bug: the extended-fields PUT must echo back
    the asset ID Homebox already auto-assigned, not omit the key entirely."""
    client, stub = _make_client(created_asset_id="000-007")

    response = client.post(
        "/items",
        json={"items": [{"name": "Drill", "manufacturer": "Acme"}]},
    )

    assert response.status_code == 200
    assert len(stub.update_calls) == 1
    assert stub.update_calls[0]["assetId"] == "000-007"
    assert stub.ensure_asset_ids_calls == 0


def test_create_with_no_extended_fields_and_no_asset_id_skips_the_update() -> None:
    """No asset ID, no extended/custom fields → no follow-up PUT should happen at all."""
    client, stub = _make_client(created_asset_id="000-009")

    response = client.post("/items", json={"items": [{"name": "Drill"}]})

    assert response.status_code == 200
    assert stub.update_calls == []
    assert stub.ensure_asset_ids_calls == 0


def test_create_calls_ensure_asset_ids_when_created_item_still_lacks_one() -> None:
    """If the Homebox instance doesn't auto-increment (assetId comes back empty)
    and nothing set a custom one, the batch-wide ensure-asset-ids sweep must still
    run - unlike the unconditional call this replaces, it should only fire when
    something in the batch actually needs it."""
    client, stub = _make_client(created_asset_id="")

    response = client.post("/items", json={"items": [{"name": "Drill"}]})

    assert response.status_code == 200
    assert stub.ensure_asset_ids_calls == 1


def test_create_rejects_malformed_asset_id() -> None:
    client, _ = _make_client()

    response = client.post(
        "/items",
        json={"items": [{"name": "Drill", "asset_id": "not-an-asset-id"}]},
    )

    assert response.status_code == 422


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("a1110", "001-110"),
        ("1110", "001-110"),
        ("001-110", "001-110"),
    ],
)
def test_create_normalizes_various_asset_id_shapes(raw: str, expected: str) -> None:
    client, stub = _make_client(created_asset_id="000-001")

    response = client.post("/items", json={"items": [{"name": "Drill", "asset_id": raw}]})

    assert response.status_code == 200
    assert stub.update_calls[0]["assetId"] == expected
