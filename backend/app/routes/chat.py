from fastapi import APIRouter, HTTPException, UploadFile
from openai import OpenAIError, RateLimitError

from app.models import ChatRequest, ChatResponse, UploadResponse
from app import rag_engine

router = APIRouter(prefix="/api", tags=["chat"])


def _raise_openai_http_error(exc: OpenAIError) -> None:
    if isinstance(exc, RateLimitError):
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/chat", response_model=ChatResponse)
async def chat_endpoint(body: ChatRequest):
    if not body.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty")
    try:
        response_text, sources = rag_engine.chat(body.message, body.session_id)
    except OpenAIError as exc:
        _raise_openai_http_error(exc)
    return ChatResponse(response=response_text, sources=sources)


@router.get("/chat")
async def chat_get(message: str, session_id: str = "default"):
    try:
        response_text, sources = rag_engine.chat(message, session_id)
    except OpenAIError as exc:
        _raise_openai_http_error(exc)
    return ChatResponse(response=response_text, sources=sources)


@router.post("/upload", response_model=UploadResponse)
async def upload_file(file: UploadFile):
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")
    data = await file.read()
    try:
        chunks = rag_engine.ingest_bytes(data, file.filename)
    except OpenAIError as exc:
        _raise_openai_http_error(exc)
    return UploadResponse(filename=file.filename, chunks=chunks, status="indexed")
