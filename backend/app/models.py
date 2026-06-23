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
