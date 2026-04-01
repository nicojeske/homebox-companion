"""Tag request/response schemas."""

from pydantic import BaseModel, Field


class CreateTagRequest(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str = ""
    color: str = ""
