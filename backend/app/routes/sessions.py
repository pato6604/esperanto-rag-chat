from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import rag_engine
from app.auth import get_current_user


router = APIRouter(prefix="/api/sessions", tags=["sessions"])


class RenameSessionRequest(BaseModel):
    title: str


@router.get("")
async def list_sessions(user_id: str = Depends(get_current_user)):
    """
    Escanea Qdrant y agrupa puntos por session_id.
    Devuelve sesiones con documentos, chunks y fecha de actualizacion.
    """
    return rag_engine.get_all_sessions(user_id)


def _check_session_ownership(session_id: str, user_id: str) -> None:
    """Lanza 403 si la sesion no pertenece al usuario.
    Las sesiones legacy con user_id='anonymous' son accesibles por cualquier usuario autenticado."""
    if user_id == "anonymous":
        return
    sessions_data = rag_engine._load_sessions_data()
    session_data = sessions_data.get(session_id)
    if isinstance(session_data, dict):
        session_user_id = session_data.get("user_id")
        if not rag_engine._session_belongs_to_user(session_user_id, user_id):
            raise HTTPException(status_code=403, detail="La sesion no pertenece al usuario")


@router.get("/{session_id}")
async def get_session_detail(
    session_id: str,
    user_id: str = Depends(get_current_user),
):
    """
    Devuelve informacion detallada de una sesion: documentos y chunks.
    """
    _check_session_ownership(session_id, user_id)
    documents_data = rag_engine.get_session_documents(session_id, user_id)
    return {
        "id": session_id,
        "title": rag_engine.get_session_title(session_id, user_id),
        **documents_data,
    }


@router.get("/{session_id}/messages")
async def get_messages(
    session_id: str,
    user_id: str = Depends(get_current_user),
):
    _check_session_ownership(session_id, user_id)
    messages = rag_engine.get_session_messages(session_id, user_id)
    return {"session_id": session_id, "messages": messages}


@router.put("/{session_id}/title")
async def rename_session(
    session_id: str,
    body: RenameSessionRequest,
    user_id: str = Depends(get_current_user),
):
    """
    Actualiza el titulo de una sesion en sessions_data.json.
    """
    title = body.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="El titulo no puede estar vacio")

    try:
        rag_engine.set_session_title(session_id, title, user_id)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    return {"id": session_id, "title": title}
