import json
import tempfile
import os
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


def get_all_sessions() -> list[dict]:
    """
    Scrollea todos los puntos en Qdrant, agrupa por session_id y combina
    la informacion con sessions_data.json.
    """
    points = _scroll_all_points()
    grouped_points: dict[str, list] = {}

    for point in points:
        payload = point.payload or {}
        session_id = str(payload.get("session_id") or "default")
        grouped_points.setdefault(session_id, []).append(point)

    sessions_data = _load_sessions_data()
    now = _now_iso()
    sessions: list[dict] = []
    data_changed = False

    for session_id, session_points in grouped_points.items():
        documents, total_chunks = _documents_from_points(session_points)
        current_data = sessions_data.get(session_id)

        if not isinstance(current_data, dict):
            current_data = {
                "title": _auto_session_title(session_id, documents),
                "created_at": now,
                "last_updated": now,
            }
            sessions_data[session_id] = current_data
            data_changed = True
        else:
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


def get_session_title(session_id: str) -> str:
    """Devuelve el titulo guardado o auto-genera uno."""
    sessions_data = _load_sessions_data()
    session_data = sessions_data.get(session_id)
    if isinstance(session_data, dict) and session_data.get("title"):
        return str(session_data["title"])

    documents_data = get_session_documents(session_id)
    return _auto_session_title(session_id, documents_data["documents"])


def set_session_title(session_id: str, title: str) -> None:
    """Guarda el titulo en sessions_data.json."""
    sessions_data = _load_sessions_data()
    now = _now_iso()
    current_data = sessions_data.get(session_id)

    if not isinstance(current_data, dict):
        current_data = {
            "created_at": now,
        }

    current_data["title"] = title
    current_data["last_updated"] = now
    sessions_data[session_id] = current_data
    _save_sessions_data(sessions_data)


def _touch_session(session_id: str, fallback_title: str | None = None) -> None:
    """Actualiza la metadata basica de una sesion."""
    sessions_data = _load_sessions_data()
    now = _now_iso()
    current_data = sessions_data.get(session_id)

    if not isinstance(current_data, dict):
        current_data = {
            "title": fallback_title or _auto_session_title(session_id),
            "created_at": now,
        }

    if not current_data.get("title"):
        current_data["title"] = fallback_title or _auto_session_title(session_id)
    if not current_data.get("created_at"):
        current_data["created_at"] = now
    current_data["last_updated"] = now
    sessions_data[session_id] = current_data
    _save_sessions_data(sessions_data)


def get_session_documents(session_id: str) -> dict:
    """
    Scrollea puntos de una sesion especifica.
    Devuelve: { documents: [{filename, chunks}], total_chunks }
    """
    points = _scroll_all_points(_session_filter(session_id))
    documents, total_chunks = _documents_from_points(points)
    return {"documents": documents, "total_chunks": total_chunks}


def ingest_bytes(data: bytes, filename: str, session_id: str = "default") -> int:
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
            },
        ))
    client.upsert(collection_name=settings.collection_name, points=points)
    _touch_session(session_id, filename)

    return len(chunks)


def chat(message: str, session_id: str = "default") -> tuple[str, list[str]]:
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

    query_filter = _session_filter(session_id)

    # Search Qdrant
    search_result = client.query_points(
        collection_name=settings.collection_name,
        prefetch=[
            Prefetch(
                query=query_vector,
                using="",
                limit=settings.top_k * 3,
                filter=query_filter,
            ),
            Prefetch(
                limit=settings.top_k * 3,
                filter=_session_text_filter(session_id, message),
            ),
        ],
        query=FusionQuery(fusion=Fusion.RRF),
        limit=settings.top_k,
    ).points

    if not search_result:
        # No docs ingested yet — just chat
        completion = _call_with_retry(
            lambda: oai.chat.completions.create(
                model=settings.chat_model,
                messages=[{"role": "user", "content": message}],
            )
        )
        return completion.choices[0].message.content, []

    # Build context from retrieved chunks
    chunks_text = []
    sources = set()
    for hit in search_result:
        chunks_text.append(hit.payload["text"])
        sources.add(hit.payload.get("source", "unknown"))

    context = "\n\n---\n\n".join(chunks_text)

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

    return completion.choices[0].message.content, list(sources)


async def chat_stream(
    message: str,
    session_id: str = "default",
) -> AsyncGenerator[dict[str, str | list[str]], None]:
    """Query RAG and stream Gemini chunks, then emit the source list."""
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

    query_filter = _session_filter(session_id)

    # Search Qdrant
    search_result = client.query_points(
        collection_name=settings.collection_name,
        prefetch=[
            Prefetch(
                query=query_vector,
                using="",
                limit=settings.top_k * 3,
                filter=query_filter,
            ),
            Prefetch(
                limit=settings.top_k * 3,
                filter=_session_text_filter(session_id, message),
            ),
        ],
        query=FusionQuery(fusion=Fusion.RRF),
        limit=settings.top_k,
    ).points

    sources: list[str] = []
    if not search_result:
        # No docs ingested yet -- just chat, but still stream the response.
        messages = [{"role": "user", "content": message}]
    else:
        chunks_text = []
        source_names = set()
        for hit in search_result:
            chunks_text.append(hit.payload["text"])
            source_names.add(hit.payload.get("source", "unknown"))

        context = "\n\n---\n\n".join(chunks_text)
        sources = list(source_names)

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

    for chunk in stream:
        content = chunk.choices[0].delta.content
        if content:
            yield {"type": "chunk", "content": content}

    yield {"type": "done", "sources": sources}


def delete_session_chunks(session_id: str) -> int:
    """Delete all indexed chunks for one chat session and return the chunk count."""
    init_rag()
    client = _get_qdrant()
    query_filter = _session_filter(session_id)

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

    return deleted_count
