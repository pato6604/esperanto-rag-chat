import asyncio
import json
import logging

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from openai import OpenAIError, RateLimitError

from app import rag_engine
from app.auth import get_current_user
from app.models import (
    ChatRequest,
    ChatResponse,
    DeleteSessionRequest,
    DeleteSessionResponse,
    UploadResponse,
)

router = APIRouter(prefix="/api", tags=["chat"])
logger = logging.getLogger(__name__)

RATE_LIMIT_MESSAGE = "Gemini esta recargando, espera 30 segundos y volve a preguntar"
TIMEOUT_MESSAGE = "La respuesta tardo demasiado. Espera unos segundos y volve a intentar."


def _raise_openai_http_error(exc: OpenAIError) -> None:
    logger.exception("Error de OpenAI/Gemini")
    if isinstance(exc, RateLimitError):
        raise HTTPException(status_code=429, detail=RATE_LIMIT_MESSAGE) from exc
    raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/chat", response_model=ChatResponse)
async def chat_endpoint(
    body: ChatRequest,
    user_id: str = Depends(get_current_user),
):
    if not body.message.strip():
        raise HTTPException(status_code=400, detail="El mensaje no puede estar vacio")
    try:
        response_text, sources, follow_ups = rag_engine.chat(
            body.message,
            body.session_id,
            user_id=user_id,
        )
    except ValueError as exc:
        logger.exception("Error de configuracion o datos en chat")
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OpenAIError as exc:
        _raise_openai_http_error(exc)
    rag_engine.append_session_message(
        body.session_id,
        "user",
        body.message,
        user_id=user_id,
    )
    rag_engine.append_session_message(
        body.session_id,
        "assistant",
        response_text,
        sources=sources,
        follow_ups=follow_ups,
        user_id=user_id,
    )
    return ChatResponse(response=response_text, sources=sources, follow_ups=follow_ups)


@router.get("/chat")
async def chat_get(
    message: str,
    session_id: str = "default",
    user_id: str = Depends(get_current_user),
):
    try:
        response_text, sources, follow_ups = rag_engine.chat(
            message,
            session_id,
            user_id=user_id,
        )
    except ValueError as exc:
        logger.exception("Error de configuracion o datos en chat")
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OpenAIError as exc:
        _raise_openai_http_error(exc)
    rag_engine.append_session_message(session_id, "user", message, user_id=user_id)
    rag_engine.append_session_message(
        session_id,
        "assistant",
        response_text,
        sources=sources,
        follow_ups=follow_ups,
        user_id=user_id,
    )
    return ChatResponse(response=response_text, sources=sources, follow_ups=follow_ups)


@router.get("/chat/stream")
async def chat_stream(
    message: str,
    session_id: str = "default",
    user_id: str = Depends(get_current_user),
):
    if not message.strip():
        raise HTTPException(status_code=400, detail="El mensaje no puede estar vacio")

    async def event_stream():
        try:
            async with asyncio.timeout(30):
                async for event in rag_engine.chat_stream(
                    message,
                    session_id,
                    user_id=user_id,
                ):
                    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except TimeoutError:
            logger.exception("Timeout en streaming de chat")
            yield (
                "data: "
                f"{json.dumps({'type': 'error', 'message': TIMEOUT_MESSAGE}, ensure_ascii=False)}"
                "\n\n"
            )
        except OpenAIError as exc:
            status_message = str(exc)
            if isinstance(exc, RateLimitError):
                status_message = RATE_LIMIT_MESSAGE
            logger.exception("Error de OpenAI/Gemini en streaming")
            yield (
                "data: "
                f"{json.dumps({'type': 'error', 'message': status_message}, ensure_ascii=False)}"
                "\n\n"
            )
        except Exception:
            logger.exception("Error inesperado en streaming de chat")
            status_message = "Ocurrio un error procesando la consulta. Volve a intentar."
            yield (
                "data: "
                f"{json.dumps({'type': 'error', 'message': status_message}, ensure_ascii=False)}"
                "\n\n"
            )

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/upload", response_model=UploadResponse)
async def upload_file(
    file: UploadFile,
    session_id: str = "default",
    user_id: str = Depends(get_current_user),
):
    if not file.filename:
        raise HTTPException(status_code=400, detail="No se recibio ningun archivo")
    data = await file.read()
    try:
        chunks = rag_engine.ingest_bytes(
            data,
            file.filename,
            session_id,
            user_id=user_id,
        )
    except ValueError as exc:
        logger.exception("Error al subir documento")
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OpenAIError as exc:
        _raise_openai_http_error(exc)
    return UploadResponse(filename=file.filename, chunks=chunks, status="indexed")


@router.post("/sessions/delete", response_model=DeleteSessionResponse)
async def delete_session(
    body: DeleteSessionRequest,
    user_id: str = Depends(get_current_user),
):
    deleted = rag_engine.delete_session_chunks(body.session_id, user_id=user_id)
    return DeleteSessionResponse(deleted_chunks=deleted, session_id=body.session_id)
