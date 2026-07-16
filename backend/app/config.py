import os
from pathlib import Path
from typing import Any

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings
from pydantic_settings import SettingsConfigDict


BACKEND_DIR = Path(__file__).resolve().parents[1]
BACKEND_ENV = BACKEND_DIR / ".env"
HERMES_ENV = Path.home() / "AppData/Local/hermes/.env"


def _read_env_file_value(path: Path, keys: tuple[str, ...]) -> str:
    if not path.exists():
        return ""

    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s[0] == "#" or "=" not in s:
            continue
        key, value = s.split("=", 1)
        if key.strip() in keys:
            return value.strip().strip('"').strip("'")
    return ""


def read_key() -> str:
    val = os.getenv("GOOGLE_API_KEY", "")
    if val and len(val) > 10:
        return val

    backend_key = _read_env_file_value(BACKEND_ENV, ("GOOGLE_API_KEY",))
    if len(backend_key) > 10:
        return backend_key

    hermes_key = _read_env_file_value(HERMES_ENV, ("GOOGLE_API_KEY", "API_KEY"))
    if len(hermes_key) > 10:
        return hermes_key

    return ""


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(BACKEND_ENV),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    GOOGLE_API_KEY: str = Field(default_factory=read_key)
    GEMINI_BASE_URL: str = "https://generativelanguage.googleapis.com/v1beta/openai"

    embedding_model: str = "gemini-embedding-001"
    chat_model: str = "gemini-3.1-flash-lite-preview"

    QDRANT_MODE: str = "local"
    QDRANT_URL: str = ""
    QDRANT_API_KEY: str = ""
    qdrant_path: str = "./qdrant_db"
    collection_name: str = "rag_docs"

    host: str = "0.0.0.0"
    port: int = Field(default=8000, validation_alias="PORT")
    CORS_ORIGINS: str = "http://localhost:3000"

    chunk_size: int = 1024
    chunk_overlap: int = 200
    top_k: int = 5
    vector_dim: int = 3072
    rerank_enabled: bool = True
    rerank_model: str = "cross-encoder/ms-marco-MiniLM-L-6-v2"
    rerank_top_k: int = 20
    rerank_final_k: int = 5

    @field_validator("QDRANT_MODE")
    @classmethod
    def validate_qdrant_mode(cls, value: str) -> str:
        mode = value.strip().lower()
        if mode not in {"local", "cloud"}:
            raise ValueError('QDRANT_MODE debe ser "local" o "cloud"')
        return mode

    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def parse_cors_env(cls, value: Any) -> str:
        if isinstance(value, list):
            return ",".join(str(item) for item in value)
        return str(value)

    @property
    def gemini_api_key(self) -> str:
        return self.GOOGLE_API_KEY

    @property
    def gemini_base_url(self) -> str:
        return self.GEMINI_BASE_URL

    @property
    def qdrant_url(self) -> str:
        return self.QDRANT_URL

    @property
    def qdrant_api_key(self) -> str:
        return self.QDRANT_API_KEY

    @property
    def cors_origins(self) -> list[str]:
        return [
            origin.strip()
            for origin in self.CORS_ORIGINS.split(",")
            if origin.strip()
        ]


settings = Settings()
