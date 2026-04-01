"""Item-related request/response schemas."""

from pydantic import BaseModel


class ItemInput(BaseModel):
    """Item data for creation with all Homebox fields."""

    name: str
    quantity: int = 1
    description: str | None = None
    location_id: str | None = None
    tag_ids: list[str] | None = None
    parent_id: str | None = None  # For sub-item relationships
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
