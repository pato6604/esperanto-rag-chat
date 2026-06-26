import json
import tempfile
import os
import time
from pathlib import Path
from collections.abc import AsyncGenerator
from uuid import uuid4

from openai import OpenAI, RateLimitError
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct

from app.config import settings


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
    if settings.collection_name in collections:
        # Recreate if vector size mismatch
        info = client.get_collection(settings.collection_name)
        if info.config.params.vectors.size != settings.vector_dim:
            client.delete_collection(collection_name=settings.collection_name)
            collections.remove(settings.collection_name)
    if settings.collection_name not in collections:
        client.create_collection(
            collection_name=settings.collection_name,
            vectors_config=VectorParams(size=settings.vector_dim, distance=Distance.COSINE),
        )


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
    """Extract text from a file. Supports PDF, TXT, MD."""
    ext = Path(file_path).suffix.lower()
    if ext == ".pdf":
        from pypdf import PdfReader
        reader = PdfReader(file_path)
        return "\n".join(page.extract_text() or "" for page in reader.pages)
    else:
        return Path(file_path).read_text(encoding="utf-8")


# ── Public API ───────────────────────────────────────────────────────


def init_rag() -> None:
    """Initialize Qdrant collection (idempotent)."""
    client = _get_qdrant()
    _ensure_collection(client)


def ingest_bytes(data: bytes, filename: str) -> int:
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

    client.delete_collection(collection_name=settings.collection_name)
    _ensure_collection(client)

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
            },
        ))
    client.upsert(collection_name=settings.collection_name, points=points)

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

    # Search Qdrant
    search_result = client.query_points(
        collection_name=settings.collection_name,
        query=query_vector,
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

    # Search Qdrant
    search_result = client.query_points(
        collection_name=settings.collection_name,
        query=query_vector,
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
