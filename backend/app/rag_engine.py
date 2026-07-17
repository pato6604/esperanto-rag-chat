import json
import tempfile
import os
import threading
import time
from pathlib import Path
from datetime import datetime
from collections.abc import AsyncGenerator
from uuid import uuid4

from openai import OpenAI, RateLimitError
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    FieldCondition,
    Filter,
    FilterSelector,
    Fusion,
    FusionQuery,
    KeywordIndexParams,
    KeywordIndexType,
    MatchText,
    MatchValue,
    PointStruct,
    Prefetch,
    TextIndexParams,
    TextIndexType,
    TokenizerType,
    VectorParams,
)
from sentence_transformers import CrossEncoder

from app.config import settings


# Ruta del archivo de metadata de sesiones, junto a la base local de Qdrant.
SESSIONS_DATA_PATH = Path(settings.qdrant_path) / "sessions_data.json"


def _call_with_retry(fn, max_retries=3, base_delay=5):
    """Ejecuta fn con backoff exponencial ante RateLimitError."""
    last_exc = None
    for attempt in range(max_retries):
        try:
            return fn()
        except RateLimitError as exc:
            last_exc = exc
            if attempt < max_retries - 1:
                delay = base_delay * (2 ** attempt)
                print(
                    f"[retry] Gemini alcanzó el límite de rate, reintentando en {delay}s "
                    f"(intento {attempt + 1}/{max_retries})..."
                )
                time.sleep(delay)
    raise last_exc

# ── Clients ──────────────────────────────────────────────────────────

_client: QdrantClient | None = None
_openai: OpenAI | None = None
_reranker = None
_reranker_lock = threading.Lock()


def _get_reranker() -> CrossEncoder | None:
    global _reranker
    if not settings.rerank_enabled:
        return None
    if _reranker is None:
        with _reranker_lock:
            if _reranker is None:
                try:
                    _reranker = CrossEncoder(
                        settings.rerank_model,
                        device="cpu",
                        max_length=512,
                    )
                except Exception:
                    print(f"[rerank] Error cargando modelo {settings.rerank_model}, deshabilitando re-ranking")
                    settings.rerank_enabled = False
                    return None
    return _reranker


def _get_qdrant() -> QdrantClient:
    global _client
    if _client is None:
        if settings.QDRANT_MODE == "cloud":
            if not settings.qdrant_url or not settings.qdrant_api_key:
                raise ValueError(
                    "QDRANT_URL y QDRANT_API_KEY son obligatorios cuando QDRANT_MODE=cloud"
                )
            _client = QdrantClient(
                url=settings.qdrant_url,
                api_key=settings.qdrant_api_key,
            )
        else:
            _client = QdrantClient(path=settings.qdrant_path)
    return _client


def _get_openai() -> OpenAI:
    global _openai
    if _openai is None:
        _openai = OpenAI(
            api_key=settings.gemini_api_key,
            base_url=settings.gemini_base_url,
        )
    return _openai


def _ensure_collection(client: QdrantClient) -> None:
    collections = [c.name for c in client.get_collections().collections]
    if settings.collection_name not in collections:
        client.create_collection(
            collection_name=settings.collection_name,
            vectors_config=VectorParams(size=settings.vector_dim, distance=Distance.COSINE),
            on_disk_payload=True,
        )
    collection_info = client.get_collection(settings.collection_name)
    payload_schema = collection_info.payload_schema or {}

    if "text" not in payload_schema:
        client.create_payload_index(
            collection_name=settings.collection_name,
            field_name="text",
            field_schema=TextIndexParams(
                type=TextIndexType.TEXT,
                tokenizer=TokenizerType.WORD,
                min_token_len=2,
                max_token_len=20,
                lowercase=True,
            ),
        )

    if "session_id" not in payload_schema:
        client.create_payload_index(
            collection_name=settings.collection_name,
            field_name="session_id",
            field_schema=KeywordIndexParams(type=KeywordIndexType.KEYWORD),
        )

    if "user_id" not in payload_schema:
        client.create_payload_index(
            collection_name=settings.collection_name,
            field_name="user_id",
            field_schema=KeywordIndexParams(type=KeywordIndexType.KEYWORD),
        )


def _session_filter(session_id: str) -> Filter:
    return Filter(
        must=[FieldCondition(key="session_id", match=MatchValue(value=session_id))]
    )


def _session_text_filter(session_id: str, text: str) -> Filter:
    return Filter(
        must=[
            FieldCondition(key="session_id", match=MatchValue(value=session_id)),
            FieldCondition(key="text", match=MatchText(text=text)),
        ]
    )


def _user_session_filter(user_id: str, session_id: str) -> Filter:
    return Filter(
        must=[
            FieldCondition(key="user_id", match=MatchValue(value=user_id)),
            FieldCondition(key="session_id", match=MatchValue(value=session_id)),
        ]
    )


def _user_session_text_filter(user_id: str, session_id: str, text: str) -> Filter:
    return Filter(
        must=[
            FieldCondition(key="user_id", match=MatchValue(value=user_id)),
            FieldCondition(key="session_id", match=MatchValue(value=session_id)),
            FieldCondition(key="text", match=MatchText(text=text)),
        ]
    )


def _user_scroll_filter(user_id: str) -> Filter:
    return Filter(
        must=[FieldCondition(key="user_id", match=MatchValue(value=user_id))]
    )


def _global_hybrid_search(
    client: QdrantClient,
    query_vector: list[float],
    message: str,
    user_id: str = "",
) -> list:
    """Busca contenido relevante en todas las sesiones."""
    user_filter = None
    text_filter = Filter(
        must=[FieldCondition(key="text", match=MatchText(text=message))]
    )
    if user_id:
        user_filter = Filter(
            must=[FieldCondition(key="user_id", match=MatchValue(value=user_id))]
        )
        text_filter = Filter(
            must=[
                FieldCondition(key="text", match=MatchText(text=message)),
                FieldCondition(key="user_id", match=MatchValue(value=user_id)),
            ]
        )
    vector_prefetch = Prefetch(
        query=query_vector,
        using="",
        limit=settings.top_k * 3,
    )
    if user_filter is not None:
        vector_prefetch = Prefetch(
            query=query_vector,
            using="",
            limit=settings.top_k * 3,
            filter=user_filter,
        )

    return client.query_points(
        collection_name=settings.collection_name,
        prefetch=[
            vector_prefetch,
            Prefetch(
                filter=text_filter,
                limit=settings.top_k * 3,
            ),
        ],
        query=FusionQuery(fusion=Fusion.RRF),
        limit=settings.top_k,
    ).points


def _cross_session_message(
    global_result: list,
    current_session_id: str,
    user_id: str = "",
) -> str | None:
    """Devuelve un aviso si los resultados pertenecen a otras sesiones."""
    session_ids: list[str] = []
    seen_session_ids: set[str] = set()

    for hit in global_result:
        payload = hit.payload or {}
        result_session_id = payload.get("session_id")
        if not result_session_id:
            continue

        result_session_id = str(result_session_id)
        if (
            result_session_id == current_session_id
            or result_session_id in seen_session_ids
        ):
            continue

        session_ids.append(result_session_id)
        seen_session_ids.add(result_session_id)

    if not session_ids:
        return None

    titles = [get_session_title(result_session_id, user_id) for result_session_id in session_ids]
    quoted_titles = ", ".join(f"'{title}'" for title in titles)

    if len(titles) == 1:
        return (
            f"Esa información está en la sesión {quoted_titles}. "
            "Cambiá de sesión para consultar esos documentos."
        )

    return (
        f"Esa información está en las sesiones: {quoted_titles}. "
        "Cambiá de sesión para consultar esos documentos."
    )


def _now_iso() -> str:
    """Devuelve la fecha actual en formato ISO sin zona horaria."""
    return datetime.now().isoformat(timespec="seconds")


def _load_sessions_data() -> dict:
    """Carga sessions_data.json, devuelve {} si no existe."""
    if not SESSIONS_DATA_PATH.exists():
        return {}

    try:
        return json.loads(SESSIONS_DATA_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _save_sessions_data(data: dict) -> None:
    """Guarda sessions_data.json."""
    SESSIONS_DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    SESSIONS_DATA_PATH.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _auto_session_title(session_id: str, documents: list[dict] | None = None) -> str:
    """Genera un titulo simple para una sesion."""
    if documents:
        first_filename = documents[0].get("filename")
        if first_filename:
            return str(first_filename)

    short_id = session_id[:8] if session_id else "default"
    return f"Sesion {short_id}"


def _scroll_all_points(scroll_filter: Filter | None = None) -> list:
    """Scrollea todos los puntos de Qdrant."""
    init_rag()
    client = _get_qdrant()
    points = []
    next_offset = None

    while True:
        batch, next_offset = client.scroll(
            collection_name=settings.collection_name,
            scroll_filter=scroll_filter,
            limit=10000,
            with_payload=True,
            with_vectors=False,
            offset=next_offset,
        )
        points.extend(batch)
        if next_offset is None:
            break

    return points


def _documents_from_points(points: list) -> tuple[list[dict], int]:
    """Agrupa puntos por archivo y cuenta chunks."""
    chunks_by_filename: dict[str, int] = {}

    for point in points:
        payload = point.payload or {}
        filename = payload.get("source") or "sin_nombre"
        chunks_by_filename[str(filename)] = chunks_by_filename.get(str(filename), 0) + 1

    documents = [
        {"filename": filename, "chunks": chunks}
        for filename, chunks in sorted(chunks_by_filename.items())
    ]
    return documents, len(points)


def _chunk_text(text: str) -> list[str]:
    """Simple chunking by character count with overlap."""
    chunks = []
    start = 0
    while start < len(text):
        end = start + settings.chunk_size
        chunks.append(text[start:end])
        start += settings.chunk_size - settings.chunk_overlap
    return chunks


def _extract_text(file_path: str) -> str:
    """Extract text from a file. Supports PDF, DOCX, CSV, JSON, HTML, TXT, MD.
    
    For .json files, returns a pretty-printed serialized representation.
    """
    ext = Path(file_path).suffix.lower()
    if ext == ".pdf":
        from pypdf import PdfReader
        try:
            reader = PdfReader(file_path)
            return "\n".join(page.extract_text() or "" for page in reader.pages)
        except Exception:
            return ""
    elif ext == ".docx":
        try:
            from docx import Document
            doc = Document(file_path)
            return "\n".join(p.text for p in doc.paragraphs)
        except Exception:
            return ""
    elif ext == ".csv":
        import csv
        try:
            with open(file_path, newline="", encoding="utf-8") as f:
                reader = csv.reader(f)
                rows = [", ".join(row) for row in reader]
            return "\n".join(rows)
        except (UnicodeDecodeError, csv.Error):
            return ""
    elif ext == ".json":
        import json
        try:
            with open(file_path, encoding="utf-8") as f:
                data = json.load(f)
            return json.dumps(data, indent=2, ensure_ascii=False)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return ""
    elif ext == ".html":
        from bs4 import BeautifulSoup
        try:
            html_content = Path(file_path).read_text(encoding="utf-8")
            soup = BeautifulSoup(html_content, "lxml")
            return soup.get_text(separator="\n", strip=True)
        except (UnicodeDecodeError, Exception):
            return ""
    else:
        try:
            return Path(file_path).read_text(encoding="utf-8")
        except UnicodeDecodeError:
            return ""


# ── Public API ───────────────────────────────────────────────────────


def init_rag() -> None:
    """Initialize Qdrant collection (idempotent)."""
    client = _get_qdrant()
    _ensure_collection(client)


def get_all_sessions(user_id: str = "anonymous") -> list[dict]:
    """
    Scrollea todos los puntos en Qdrant, agrupa por session_id y combina
    la informacion con sessions_data.json.
    """
    points = _scroll_all_points(_user_scroll_filter(user_id))
    grouped_points: dict[str, list] = {}

    for point in points:
        payload = point.payload or {}
        session_id = str(payload.get("session_id") or "default")
        grouped_points.setdefault(session_id, []).append(point)

    sessions_data = _load_sessions_data()
    now = _now_iso()
    sessions: list[dict] = []
    data_changed = False

    session_ids = set(grouped_points) | {
        str(session_id)
        for session_id, session_data in sessions_data.items()
        if isinstance(session_data, dict)
        and (
            session_data.get("user_id") == user_id
            or (user_id == "anonymous" and not session_data.get("user_id"))
        )
    }

    for session_id in session_ids:
        session_points = grouped_points.get(session_id, [])
        documents, total_chunks = _documents_from_points(session_points)
        current_data = sessions_data.get(session_id)

        if not isinstance(current_data, dict):
            current_data = {
                "title": _auto_session_title(session_id, documents),
                "created_at": now,
                "last_updated": now,
                "user_id": user_id,
            }
            sessions_data[session_id] = current_data
            data_changed = True
        else:
            if current_data.get("user_id") and current_data.get("user_id") != user_id:
                current_data = {
                    "title": _auto_session_title(session_id, documents),
                    "created_at": now,
                    "last_updated": now,
                    "user_id": user_id,
                    "messages": [],
                }
            if not current_data.get("user_id"):
                current_data["user_id"] = user_id
                data_changed = True
            if not current_data.get("title"):
                current_data["title"] = _auto_session_title(session_id, documents)
                data_changed = True
            if not current_data.get("created_at"):
                current_data["created_at"] = now
                data_changed = True
            if not current_data.get("last_updated"):
                current_data["last_updated"] = now
                data_changed = True

        sessions.append(
            {
                "id": session_id,
                "title": current_data["title"],
                "documents": documents,
                "total_chunks": total_chunks,
                "total_messages": len(current_data.get("messages", []))
                if isinstance(current_data.get("messages"), list)
                else 0,
                "last_updated": current_data["last_updated"],
            }
        )

    if data_changed:
        _save_sessions_data(sessions_data)

    return sorted(
        sessions,
        key=lambda session: session.get("last_updated", ""),
        reverse=True,
    )


def get_session_title(session_id: str, user_id: str = "") -> str:
    """Devuelve el titulo guardado o auto-genera uno."""
    sessions_data = _load_sessions_data()
    session_data = sessions_data.get(session_id)
    if isinstance(session_data, dict) and session_data.get("title"):
        session_user_id = session_data.get("user_id")
        if user_id and session_user_id and session_user_id != user_id:
            return _auto_session_title(session_id)
        if user_id and not session_user_id and user_id != "anonymous":
            return _auto_session_title(session_id)
        return str(session_data["title"])

    documents_data = get_session_documents(session_id, user_id or "anonymous")
    return _auto_session_title(session_id, documents_data["documents"])


def set_session_title(session_id: str, title: str, user_id: str = "anonymous") -> None:
    """Guarda el titulo en sessions_data.json."""
    sessions_data = _load_sessions_data()
    now = _now_iso()
    current_data = sessions_data.get(session_id)

    if not isinstance(current_data, dict):
        current_data = {
            "created_at": now,
            "user_id": user_id,
        }
    elif current_data.get("user_id") and current_data.get("user_id") != user_id:
        raise ValueError("La sesion no pertenece al usuario")
    elif not current_data.get("user_id") and user_id != "anonymous":
        raise ValueError("La sesion no pertenece al usuario")

    current_data["title"] = title
    current_data["user_id"] = user_id
    current_data["last_updated"] = now
    sessions_data[session_id] = current_data
    _save_sessions_data(sessions_data)


def get_session_messages(session_id: str, user_id: str = "anonymous") -> list[dict]:
    """Devuelve los mensajes guardados de una sesion."""
    data = _load_sessions_data()
    session_data = data.get(session_id, {})
    if not isinstance(session_data, dict):
        return []
    session_user_id = session_data.get("user_id")
    if session_user_id and session_user_id != user_id:
        return []
    if not session_user_id and user_id != "anonymous":
        return []
    messages = session_data.get("messages", [])
    if not isinstance(messages, list):
        return []

    normalized_messages = []
    for message in messages:
        if not isinstance(message, dict):
            continue

        normalized = dict(message)
        if "follow_ups" in normalized and "followUps" not in normalized:
            normalized["followUps"] = normalized.pop("follow_ups")
        if "sources" in normalized:
            normalized["sources"] = _normalize_sources(normalized["sources"])
        normalized_messages.append(normalized)

    return normalized_messages


def _normalize_sources(sources: object) -> list[dict]:
    """Normaliza sources legacy string[] al formato actual."""
    if not isinstance(sources, list):
        return []

    normalized_sources: list[dict] = []
    for source in sources:
        if isinstance(source, str):
            normalized_sources.append({"filename": source, "snippet": ""})
        elif isinstance(source, dict):
            filename = source.get("filename")
            if not filename:
                continue
            normalized_sources.append(
                {
                    "filename": str(filename),
                    "snippet": str(source.get("snippet") or ""),
                }
            )

    return normalized_sources


def append_session_message(
    session_id: str,
    role: str,
    content: str,
    sources: list[dict] | None = None,
    follow_ups: list[str] | None = None,
    user_id: str = "anonymous",
) -> None:
    """Agrega un mensaje al historial de la sesion."""
    data = _load_sessions_data()
    now = _now_iso()
    current_data = data.get(session_id)

    if not isinstance(current_data, dict):
        current_data = {
            "title": _auto_session_title(session_id),
            "created_at": now,
            "user_id": user_id,
        }
    elif current_data.get("user_id") and current_data.get("user_id") != user_id:
        raise ValueError("La sesion no pertenece al usuario")
    elif not current_data.get("user_id") and user_id != "anonymous":
        raise ValueError("La sesion no pertenece al usuario")

    if "messages" not in current_data:
        current_data["messages"] = []

    message_data = {
        "role": role,
        "content": content,
        "timestamp": datetime.now().isoformat(),
    }
    if sources:
        message_data["sources"] = _normalize_sources(sources)
    if follow_ups:
        message_data["followUps"] = follow_ups

    current_data["messages"].append(message_data)
    current_data["user_id"] = user_id
    current_data["last_updated"] = now
    data[session_id] = current_data
    _save_sessions_data(data)


def _touch_session(
    session_id: str,
    fallback_title: str | None = None,
    user_id: str = "anonymous",
) -> None:
    """Actualiza la metadata basica de una sesion."""
    sessions_data = _load_sessions_data()
    now = _now_iso()
    current_data = sessions_data.get(session_id)

    if not isinstance(current_data, dict):
        current_data = {
            "title": fallback_title or _auto_session_title(session_id),
            "created_at": now,
            "user_id": user_id,
        }
    elif current_data.get("user_id") and current_data.get("user_id") != user_id:
        raise ValueError("La sesion no pertenece al usuario")
    elif not current_data.get("user_id") and user_id != "anonymous":
        raise ValueError("La sesion no pertenece al usuario")

    if not current_data.get("title"):
        current_data["title"] = fallback_title or _auto_session_title(session_id)
    if not current_data.get("created_at"):
        current_data["created_at"] = now
    current_data["user_id"] = user_id
    current_data["last_updated"] = now
    sessions_data[session_id] = current_data
    _save_sessions_data(sessions_data)


def get_session_documents(session_id: str, user_id: str = "anonymous") -> dict:
    """
    Scrollea puntos de una sesion especifica.
    Devuelve: { documents: [{filename, chunks}], total_chunks }
    """
    points = _scroll_all_points(_user_session_filter(user_id, session_id))
    documents, total_chunks = _documents_from_points(points)
    return {"documents": documents, "total_chunks": total_chunks}


def ingest_bytes(
    data: bytes,
    filename: str,
    session_id: str = "default",
    user_id: str = "anonymous",
) -> int:
    """Ingest a document. Returns chunk count."""
    init_rag()
    client = _get_qdrant()
    oai = _get_openai()

    # Save to temp file, extract text
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=Path(filename).suffix)
    tmp.write(data)
    tmp.close()
    try:
        try:
            text = _extract_text(tmp.name)
        except Exception as exc:
            if Path(filename).suffix.lower() == ".pdf":
                raise ValueError("El archivo PDF está corrupto o no es un PDF válido") from exc
            raise ValueError("No se pudo leer el archivo subido") from exc
    finally:
        os.unlink(tmp.name)

    if not text.strip():
        return 0

    chunks = _chunk_text(text)

    # Get embeddings from Gemini via OpenAI-compatible endpoint
    embeddings = []
    for start in range(0, len(chunks), 100):
        batch = chunks[start:start + 100]
        resp = _call_with_retry(
            lambda: oai.embeddings.create(
                model=settings.embedding_model,
                input=batch,
            )
        )
        embeddings.extend(e.embedding for e in resp.data)

    # Store in Qdrant
    points = []
    for i, (chunk, emb) in enumerate(zip(chunks, embeddings)):
        points.append(PointStruct(
            id=str(uuid4()),
            vector=emb,
            payload={
                "text": chunk,
                "source": filename,
                "chunk_index": i,
                "session_id": session_id,
                "user_id": user_id,
            },
        ))
    client.upsert(collection_name=settings.collection_name, points=points)
    _touch_session(session_id, filename, user_id)

    return len(chunks)


def _build_follow_ups(
    oai: OpenAI,
    message: str,
    full_response: str,
    context: str,
) -> list[str]:
    follow_prompt = (
        "Genera 3 preguntas de seguimiento breves que el usuario podria hacer "
        "para profundizar en este tema. Responde SOLO con las preguntas, "
        "una por linea, sin numeros ni prefijos."
    )
    try:
        follow_resp = _call_with_retry(
            lambda: oai.chat.completions.create(
                model=settings.chat_model,
                messages=[
                    {"role": "system", "content": f"Contexto:\n{context}"},
                    {"role": "user", "content": message},
                    {"role": "assistant", "content": full_response},
                    {"role": "user", "content": follow_prompt},
                ],
            )
        )
        follow_text = follow_resp.choices[0].message.content or ""
        return [
            q.strip().lstrip("0123456789.- ")
            for q in follow_text.strip().split("\n")
            if q.strip()
        ][:3]
    except Exception:
        return []


def _rerank(
    query: str,
    search_result: list,
    top_k: int,
) -> list:
    """Re-rank Qdrant results using a cross-encoder."""
    reranker = _get_reranker()
    if reranker is None or not search_result:
        return search_result[:top_k]

    pairs = [(query, (hit.payload or {}).get("text", "")) for hit in search_result]
    try:
        scores = reranker.predict(pairs)
    except Exception:
        return search_result[:top_k]

    scored_hits = list(zip(search_result, scores))
    scored_hits.sort(key=lambda x: x[1], reverse=True)

    return [hit for hit, _ in scored_hits[:top_k]]


def chat(
    message: str,
    session_id: str = "default",
    user_id: str = "anonymous",
) -> tuple[str, list[dict], list[str]]:
    """Query RAG: embed message → retrieve chunks → Gemini answers."""
    init_rag()
    client = _get_qdrant()
    oai = _get_openai()

    # Embed the query
    resp = _call_with_retry(
        lambda: oai.embeddings.create(
            model=settings.embedding_model,
            input=[message],
        )
    )
    query_vector = resp.data[0].embedding

    query_filter = _user_session_filter(user_id, session_id)

    # Search Qdrant
    search_result = client.query_points(
        collection_name=settings.collection_name,
        prefetch=[
            Prefetch(
                query=query_vector,
                using="",
                limit=settings.rerank_top_k * 3,
                filter=query_filter,
            ),
            Prefetch(
                limit=settings.rerank_top_k * 3,
                filter=_user_session_text_filter(user_id, session_id, message),
            ),
        ],
        query=FusionQuery(fusion=Fusion.RRF),
        limit=settings.rerank_top_k,
    ).points

    if settings.rerank_enabled:
        search_result = _rerank(message, search_result, settings.rerank_final_k)

    if not search_result:
        global_result = _global_hybrid_search(client, query_vector, message, user_id)
        cross_session_message = _cross_session_message(
            global_result,
            session_id,
            user_id,
        )
        if cross_session_message:
            return cross_session_message, [], []

        # No docs ingested yet — just chat
        completion = _call_with_retry(
            lambda: oai.chat.completions.create(
                model=settings.chat_model,
                messages=[{"role": "user", "content": message}],
            )
        )
        return completion.choices[0].message.content, [], []

    # Build context from retrieved chunks
    chunks_text = []
    sources_dict = {}
    for hit in search_result:
        chunks_text.append(hit.payload["text"])
        filename = hit.payload.get("source", "unknown")
        if filename not in sources_dict:
            sources_dict[filename] = hit.payload["text"][:200]

    context = "\n\n---\n\n".join(chunks_text)
    sources = [{"filename": k, "snippet": v} for k, v in sources_dict.items()]

    system_prompt = (
        "Eres un asistente de RAG. Usa el siguiente contexto para responder "
        "la pregunta del usuario. Si no encontrás la respuesta en el contexto, "
        "decí que no lo sabes. Respondé en español.\n\n"
        f"Contexto:\n{context}"
    )

    completion = _call_with_retry(
        lambda: oai.chat.completions.create(
            model=settings.chat_model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": message},
            ],
        )
    )

    full_response = completion.choices[0].message.content
    follow_ups = _build_follow_ups(oai, message, full_response, context)

    return full_response, sources, follow_ups


async def chat_stream(
    message: str,
    session_id: str = "default",
    user_id: str = "anonymous",
) -> AsyncGenerator[dict[str, object], None]:
    """Query RAG and stream Gemini chunks, then emit the source list."""
    append_session_message(session_id, "user", message, user_id=user_id)
    init_rag()
    client = _get_qdrant()
    oai = _get_openai()

    # Embed the query
    resp = _call_with_retry(
        lambda: oai.embeddings.create(
            model=settings.embedding_model,
            input=[message],
        )
    )
    query_vector = resp.data[0].embedding

    query_filter = _user_session_filter(user_id, session_id)

    # Search Qdrant
    search_result = client.query_points(
        collection_name=settings.collection_name,
        prefetch=[
            Prefetch(
                query=query_vector,
                using="",
                limit=settings.rerank_top_k * 3,
                filter=query_filter,
            ),
            Prefetch(
                limit=settings.rerank_top_k * 3,
                filter=_user_session_text_filter(user_id, session_id, message),
            ),
        ],
        query=FusionQuery(fusion=Fusion.RRF),
        limit=settings.rerank_top_k,
    ).points

    if settings.rerank_enabled:
        search_result = _rerank(message, search_result, settings.rerank_final_k)

    sources: list[dict] = []
    context = ""
    if not search_result:
        global_result = _global_hybrid_search(client, query_vector, message, user_id)
        cross_session_message = _cross_session_message(
            global_result,
            session_id,
            user_id,
        )
        if cross_session_message:
            append_session_message(
                session_id,
                "assistant",
                cross_session_message,
                sources=[],
                follow_ups=[],
                user_id=user_id,
            )
            yield {"type": "cross_session", "message": cross_session_message}
            yield {"type": "done", "sources": [], "follow_ups": []}
            return

        # No docs ingested yet -- just chat, but still stream the response.
        messages = [{"role": "user", "content": message}]
    else:
        chunks_text = []
        sources_dict = {}
        for hit in search_result:
            chunks_text.append(hit.payload["text"])
            filename = hit.payload.get("source", "unknown")
            if filename not in sources_dict:
                sources_dict[filename] = hit.payload["text"][:200]

        context = "\n\n---\n\n".join(chunks_text)
        sources = [{"filename": k, "snippet": v} for k, v in sources_dict.items()]

        system_prompt = (
            "Eres un asistente de RAG. Usa el siguiente contexto para responder "
            "la pregunta del usuario. Si no encontrás la respuesta en el contexto, "
            "decí que no lo sabes. Respondé en español.\n\n"
            f"Contexto:\n{context}"
        )
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": message},
        ]

    stream = _call_with_retry(
        lambda: oai.chat.completions.create(
            model=settings.chat_model,
            messages=messages,
            stream=True,
        )
    )

    full_response = ""
    for chunk in stream:
        content = chunk.choices[0].delta.content
        if content:
            full_response += content
            yield {"type": "chunk", "content": content}

    follow_ups: list[str] = []
    if sources:
        follow_ups = _build_follow_ups(oai, message, full_response, context)

    append_session_message(
        session_id,
        "assistant",
        full_response,
        sources=sources,
        follow_ups=follow_ups,
        user_id=user_id,
    )
    yield {"type": "done", "sources": sources, "follow_ups": follow_ups}


def delete_session_chunks(session_id: str, user_id: str = "anonymous") -> int:
    """Delete all indexed chunks for one chat session and return the chunk count."""
    init_rag()
    client = _get_qdrant()
    query_filter = _user_session_filter(user_id, session_id)

    # Count matching points efficiently
    count_result = client.count(
        collection_name=settings.collection_name,
        count_filter=query_filter,
        exact=True,
    )
    deleted_count = count_result.count

    if deleted_count:
        client.delete(
            collection_name=settings.collection_name,
            points_selector=FilterSelector(filter=query_filter),
        )

    # Also clean up sessions_data.json so deleted sessions don't reappear
    sessions_data = _load_sessions_data()
    current_data = sessions_data.get(session_id)
    if (
        isinstance(current_data, dict)
        and (current_data.get("user_id") == user_id or not current_data.get("user_id"))
    ):
        del sessions_data[session_id]
        _save_sessions_data(sessions_data)

    return deleted_count
