# 📚 RAG Chat — Document Q&A System

Chat with your documents using **RAG** (Retrieval-Augmented Generation).

## Stack

| Capa | Tecnología |
|------|-----------|
| **Frontend** | Next.js 15 + Tailwind CSS + shadcn/ui |
| **Backend** | FastAPI + LlamaIndex + Gemini 2.5 Pro |
| **Vector DB** | Qdrant |
| **Embeddings** | Gemini Embedding API |
| **LLM** | Gemini 2.5 Pro |

## Requisitos

- **Python 3.12+**
- **Node.js 18+**
- **Docker** (para Qdrant local)
- **GOOGLE_API_KEY** (de Google AI Studio)

## Setup Local

### 1. Backend

```bash
cd backend
python -m venv venv

# Windows:
source venv/Scripts/activate
# Linux/Mac:
# source venv/bin/activate

pip install -r requirements.txt
```

### 2. Levantar Qdrant

```bash
docker run -d -p 6333:6333 qdrant/qdrant
```

O con docker-compose (recomendado):

```bash
cd ..
docker compose up -d qdrant
```

### 3. Correr backend

```bash
cd backend
source venv/Scripts/activate
uvicorn app.main:app --reload --port 8000
```

### 4. Frontend

```bash
cd frontend
npm install
npm run dev
```

Abrir http://localhost:3000

## Deploy

### Frontend → Vercel

```bash
cd frontend
npx vercel --prod
```

Configurar variable de entorno:
- `NEXT_PUBLIC_API_URL` → URL del backend en Railway

### Backend → Railway

1. Crear proyecto en [Railway](https://railway.app)
2. Conectar repo de GitHub
3. Agregar Qdrant como servicio (Railway template)
4. Configurar variables de entorno:
   - `GOOGLE_API_KEY`
   - `QDRANT_URL` → URL interna de Qdrant en Railway
5. Deploy

### Alternativa: Render

Mismo concepto que Railway, con [Render](https://render.com).

## API Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/api/chat` | Preguntar a los documentos |
| GET | `/api/chat?message=...` | Preguntar (GET) |
| POST | `/api/upload` | Subir documento (PDF, TXT, MD) |

## Estructura del proyecto

```
rag-project/
├── backend/
│   ├── app/
│   │   ├── main.py          # FastAPI app
│   │   ├── config.py        # Configuración
│   │   ├── models.py        # Pydantic models
│   │   ├── rag_engine.py    # Lógica RAG
│   │   └── routes/
│   │       └── chat.py      # Endpoints
│   ├── Dockerfile
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   └── app/
│   │       ├── page.tsx     # Chat UI
│   │       └── layout.tsx
│   ├── components/
│   │   └── ui/              # shadcn/ui components
│   └── .env.local
├── docker-compose.yml
└── README.md
```
