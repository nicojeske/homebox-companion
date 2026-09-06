"""Tests for attachment mutation endpoints (M2 Step 3): set-primary and delete.

The exact Homebox body/status shapes were confirmed live (tests/test_items_live.py)
before these routes were implemented: PUT requires the full {title, type, primary}
body (a partial body 500s), and DELETE returns 204 with no body.
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient


class _StubHomeboxClient:
    """Minimal stand-in for HomeboxClient recording attachment mutation calls."""

    def __init__(
        self,
        item: dict[str, Any] | None = None,
        delete_error: Exception | None = None,
    ) -> None:
        self.item = item or {"id": "item-1", "attachments": []}
        self.delete_error = delete_error
        self.update_attachment_calls: list[dict[str, Any]] = []
        self.delete_attachment_calls: list[tuple[str, str]] = []

    async def get_item(self, token: str, item_id: str) -> dict[str, Any]:
        return self.item

    async def update_attachment(
        self,
        token: str,
        item_id: str,
        attachment_id: str,
        *,
        title: str,
        primary: bool,
        attachment_type: str = "photo",
    ) -> dict[str, Any]:
        call = {
            "item_id": item_id,
            "attachment_id": attachment_id,
            "title": title,
            "primary": primary,
            "attachment_type": attachment_type,
        }
        self.update_attachment_calls.append(call)
        return {**self.item, "attachments": [{"id": attachment_id, "title": title, "primary": primary}]}

    async def delete_attachment(self, token: str, item_id: str, attachment_id: str) -> None:
        self.delete_attachment_calls.append((item_id, attachment_id))
        if self.delete_error is not None:
            raise self.delete_error


def _make_client(stub: _StubHomeboxClient) -> TestClient:
    from server.api import items as items_module
    from server.dependencies import get_client, get_token

    app = FastAPI()
    app.include_router(items_module.router)
    app.dependency_overrides[get_client] = lambda: stub
    app.dependency_overrides[get_token] = lambda: "fake-token"
    return TestClient(app)


ITEM_WITH_ATTACHMENT: dict[str, Any] = {
    "id": "item-1",
    "attachments": [{"id": "att-1", "title": "photo.jpg", "type": "photo", "primary": False}],
}


def test_set_primary_forwards_title_and_type() -> None:
    """The route must send the full {title, type, primary} body — Homebox 500s on a
    partial body (confirmed live)."""
    stub = _StubHomeboxClient(ITEM_WITH_ATTACHMENT)
    client = _make_client(stub)

    response = client.put("/items/item-1/attachments/att-1", json={"primary": True})

    assert response.status_code == 200
    call = stub.update_attachment_calls[0]
    assert call == {
        "item_id": "item-1",
        "attachment_id": "att-1",
        "title": "photo.jpg",  # filled in from the attachment's current title
        "primary": True,
        "attachment_type": "photo",
    }


def test_set_primary_uses_provided_title_when_given() -> None:
    stub = _StubHomeboxClient(ITEM_WITH_ATTACHMENT)
    client = _make_client(stub)

    response = client.put("/items/item-1/attachments/att-1", json={"primary": True, "title": "renamed.jpg"})

    assert response.status_code == 200
    assert stub.update_attachment_calls[0]["title"] == "renamed.jpg"


def test_set_primary_404s_for_unknown_attachment() -> None:
    stub = _StubHomeboxClient(ITEM_WITH_ATTACHMENT)
    client = _make_client(stub)

    response = client.put("/items/item-1/attachments/does-not-exist", json={"primary": True})

    assert response.status_code == 404
    assert stub.update_attachment_calls == []


def test_delete_attachment_forwards_and_returns_200() -> None:
    stub = _StubHomeboxClient(ITEM_WITH_ATTACHMENT)
    client = _make_client(stub)

    response = client.delete("/items/item-1/attachments/att-1")

    assert response.status_code == 200
    assert stub.delete_attachment_calls == [("item-1", "att-1")]


def test_delete_attachment_maps_not_found_to_404() -> None:
    stub = _StubHomeboxClient(ITEM_WITH_ATTACHMENT, delete_error=FileNotFoundError("gone"))
    client = _make_client(stub)

    response = client.delete("/items/item-1/attachments/att-1")

    assert response.status_code == 404
