from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app import rag_engine


router = APIRouter(prefix="/api/sessions", tags=["sessions"])


class RenameSessionRequest(BaseModel):
    title: str


@router.get("")
async def list_sessions():
    """
    Escanea Qdrant y agrupa puntos por session_id.
    Devuelve sesiones con documentos, chunks y fecha de actualizacion.
    """
    return rag_engine.get_all_sessions()


@router.get("/{session_id}")
async def get_session_detail(session_id: str):
    """
    Devuelve informacion detallada de una sesion: documentos y chunks.
    """
    documents_data = rag_engine.get_session_documents(session_id)
    return {
        "id": session_id,
        "title": rag_engine.get_session_title(session_id),
        **documents_data,
    }


@router.put("/{session_id}/title")
async def rename_session(session_id: str, body: RenameSessionRequest):
    """
    Actualiza el titulo de una sesion en sessions_data.json.
    """
    title = body.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="El titulo no puede estar vacio")

    rag_engine.set_session_title(session_id, title)
    return {"id": session_id, "title": title}
