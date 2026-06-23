import os
from pathlib import Path
from pydantic_settings import BaseSettings


def read_key() -> str:
    val = os.getenv("GOOGLE_API_KEY", "")
    if val and len(val) > 10:
        return val
    env = Path.home() / "AppData/Local/hermes/.env"
    if not env.exists():
        return ""
    for line in env.read_text().splitlines():
        s = line.strip()
        if not s or s[0] == "#":
            continue
        if "API_KEY" in s and "=" in s:
            parts = s.split("=", 1)
            if len(parts[1]) > 10:
                return parts[1]
    return ""


class Settings(BaseSettings):
    gemini_api_key: str = read_key()
    gemini_base_url: str = "https://generativelanguage.googleapis.com/v1beta/openai"

    embedding_model: str = "gemini-embedding-001"
    chat_model: str = "gemini-2.0-flash"

    qdrant_path: str = "./qdrant_db"
    collection_name: str = "rag_docs"

    host: str = "0.0.0.0"
    port: int = 8000
    cors_origins: list[str] = ["http://localhost:3000"]

    chunk_size: int = 1024
    chunk_overlap: int = 200
    top_k: int = 5
    vector_dim: int = 3072


settings = Settings()
