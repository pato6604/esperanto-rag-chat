Eres un implementador de código.

# Contexto
Proyecto Esperanto en C:\Users\Patricio Quintana\Esperanto (Windows, git-bash).
Backend: FastAPI corriendo en puerto 8002.

# El bug
En `backend/app/rag_engine.py`, la función `ingest_bytes()` llama `oai.embeddings.create(input=chunks)` con TODOS los chunks en una sola llamada. La API de embeddings de Gemini (OpenAI-compatible endpoint) tiene un límite de 100 inputs por batch. Cuando un documento tiene mucho texto (ej: 22 páginas) y genera 100+ chunks, falla con:

Error code: 400 - {"error": {"code": 400, "message": "* BatchEmbedContentsRequest.requests: at most 100 requests can be in one batch", "status": "INVALID_ARGUMENT"}}

# Tarea
Modificá `ingest_bytes()` en `backend/app/rag_engine.py` para batchiar las llamadas a embeddings en grupos de máximo 100 chunks por llamada.

El fix:
1. Dividí `chunks` en lotes de 100
2. Hacé `oai.embeddings.create(input=batch)` para cada lote
3. Concatená todos los `embeddings` resultantes
4. Después procesá todo como antes (crear points, upsert a Qdrant)

No toques nada más.

# Verificación
Corré: cd backend && python -c "from app.rag_engine import ingest_bytes; print('Import OK')"
Después probá subiendo un TXT con mucho texto (100+ chunks) y verificá que no tire el error de batch.
