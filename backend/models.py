"""
pydantic models for the api. nothing fancy, just request/response shapes.
"""

from pydantic import BaseModel
from typing import Optional, List


class RegisterResponse(BaseModel):
    signature: str
    role: str  # "student" or "teacher"
    name: Optional[str] = None
    classroom_code: Optional[str] = None


class UploadResponse(BaseModel):
    success: bool
    file_id: Optional[str] = None
    download_url: Optional[str] = None
    tagged_name: Optional[str] = None
    error: Optional[str] = None


class PolledFile(BaseModel):
    signature: str
    filename: str
    content: str
    tagged_name: Optional[str] = None
    download_url: Optional[str] = None
    uploaded_at: Optional[str] = None


class PollResponse(BaseModel):
    files: List[PolledFile] = []


class RosterEntry(BaseModel):
    signature: str
    name: Optional[str] = None
    last_seen: Optional[str] = None
    file_count: int = 0


class RosterResponse(BaseModel):
    students: List[RosterEntry] = []
