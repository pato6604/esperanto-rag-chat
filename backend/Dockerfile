# ============================================================
# Esperanto Backend — Dockerfile para GCP Cloud Run
# ============================================================
FROM python:3.12-slim AS builder

WORKDIR /build

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        gcc g++ build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# Download cross-encoder model during build (cache for runtime)
RUN python -c "\
from sentence_transformers import SentenceTransformer; \
SentenceTransformer('cross-encoder/ms-marco-MiniLM-L-6-v2')"


FROM python:3.12-slim

WORKDIR /app

COPY --from=builder /install /usr/local
COPY --from=builder /root/.cache /root/.cache

COPY . .

RUN mkdir -p /app/qdrant_db

ENV PORT=8000
ENV ENV=production

EXPOSE $PORT

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:$PORT/health')" || exit 1

CMD exec uvicorn app.main:app --host 0.0.0.0 --port $PORT --workers 1
