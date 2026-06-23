from fastapi import APIRouter, HTTPException, UploadFile
from app.models import ChatRequest, ChatResponse, UploadResponse
from app import rag_engine

router = APIRouter(prefix="/api", tags=["chat"])


@router.post("/chat", response_model=ChatResponse)
async def chat_endpoint(body: ChatRequest):
    if not body.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty")
    response_text, sources = rag_engine.chat(body.message, body.session_id)
    return ChatResponse(response=response_text, sources=sources)


@router.get("/chat")
async def chat_get(message: str, session_id: str = "default"):
    response_text, sources = rag_engine.chat(message, session_id)
    return ChatResponse(response=response_text, sources=sources)


@router.post("/upload", response_model=UploadResponse)
async def upload_file(file: UploadFile):
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")
    data = await file.read()
    chunks = rag_engine.ingest_bytes(data, file.filename)
    return UploadResponse(filename=file.filename, chunks=chunks, status="indexed")
