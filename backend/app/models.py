from pydantic import BaseModel


class ChatRequest(BaseModel):
    message: str
    session_id: str = "default"


class ChatResponse(BaseModel):
    response: str
    sources: list[str] = []


class UploadResponse(BaseModel):
    filename: str
    chunks: int
    status: str


class DeleteSessionRequest(BaseModel):
    session_id: str


class DeleteSessionResponse(BaseModel):
    deleted_chunks: int
    session_id: str
