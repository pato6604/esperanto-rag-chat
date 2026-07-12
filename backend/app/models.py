from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    message: str
    session_id: str = "default"


class SourceInfo(BaseModel):
    filename: str
    snippet: str


class ChatResponse(BaseModel):
    response: str
    sources: list[SourceInfo] = Field(default_factory=list)
    follow_ups: list[str] = Field(default_factory=list)


class UploadResponse(BaseModel):
    filename: str
    chunks: int
    status: str


class DeleteSessionRequest(BaseModel):
    session_id: str


class DeleteSessionResponse(BaseModel):
    deleted_chunks: int
    session_id: str
