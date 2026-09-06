"""Item-related request/response schemas."""

from pydantic import BaseModel


class ItemInput(BaseModel):
    """Item data for creation with all Homebox fields.

    Note: In Homebox 0.26+, both ``location_id`` and ``parent_id`` map to the
    API's ``parentId`` field. ``location_id`` is the primary field (container
    selection from the UI), while ``parent_id`` is a legacy alias kept for
    backward compatibility.
    """

    name: str
    quantity: int = 1
    description: str | None = None
    location_id: str | None = None  # Container (location) to place the item in
    tag_ids: list[str] | None = None
    parent_id: str | None = None  # Legacy alias for location_id (both map to parentId)
    # Advanced fields
    serial_number: str | None = None
    model_number: str | None = None
    manufacturer: str | None = None
    purchase_price: float | None = None
    purchase_from: str | None = None
    notes: str | None = None
    insured: bool = False
    # Custom fields: map of display name → text value
    custom_fields: dict[str, str] | None = None


class ItemDetailResponse(BaseModel):
    """Simple item details for QR code lookups (Move Items feature)."""

    id: str
    name: str
    assetId: str | None
    thumbnailId: str | None
    locationId: str | None
    locationName: str | None


class BatchCreateRequest(BaseModel):
    """Batch item creation request."""

    items: list[ItemInput]
    location_id: str | None = None


class ItemLocationRef(BaseModel):
    """Minimal location reference embedded in a search result."""

    id: str
    name: str


class ItemTagRef(BaseModel):
    """Minimal tag reference embedded in a search result."""

    id: str
    name: str


class ItemSearchResult(BaseModel):
    """Item projection returned by the browse/search endpoint.

    Richer than the legacy bare-list shape (adds assetId, description,
    location, tags, updatedAt) so the browse UI can render useful context
    without a follow-up fetch per item.
    """

    id: str
    name: str
    description: str | None = None
    quantity: int = 1
    assetId: str | None = None
    thumbnailId: str | None = None
    location: ItemLocationRef | None = None
    tags: list[ItemTagRef] = []
    updatedAt: str | None = None


class ItemListResponse(BaseModel):
    """Paginated envelope for GET /items, mirroring Homebox's own list shape."""

    items: list[ItemSearchResult]
    page: int
    pageSize: int
    total: int
