# 🗣️ Esperanto

Un sistema RAG para chatear con documentos.

## Stack

| Capa | Tecnología |
|------|-----------|
| **Frontend** | Next.js 16 + Tailwind CSS 4 + shadcn/ui |
| **Backend** | FastAPI + OpenAI Python SDK + Gemini |
| **Vector DB** | Qdrant (en memoria local, cloud en producción) |
| **Embeddings** | Gemini Embedding API (`gemini-embedding-001`, 3072d) |
| **LLM** | Gemini 2.5 Flash |

## Requisitos

- **Python 3.12+**
- **Node.js 18+**
- **Google API Key** (de [Google AI Studio](https://aistudio.google.com/) - tier gratuito)

## Setup Local

```bash
# 1. Clonar el repo
git clone https://github.com/pato6604/Esperanto.git
cd Esperanto
```

### 2. Backend

```bash
cd backend
python -m venv venv

# Windows (git-bash):
source venv/Scripts/activate
# Linux/Mac:
# source venv/bin/activate

pip install -r requirements.txt
```

### 3. API Key

Configurá tu `GOOGLE_API_KEY` en el archivo `.env` del proyecto o como variable de entorno.

### 4. Correr backend

```bash
cd backend
source venv/Scripts/activate
uvicorn app.main:app --reload --port 8000
```

### 5. Frontend

```bash
cd frontend
npm install
npm run dev
```

Abrir http://localhost:3000

## API Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/api/chat` | Preguntar a los documentos |
| GET | `/api/chat?message=...` | Preguntar (GET) |
| POST | `/api/upload` | Subir documento (PDF, TXT, MD) |

## Cómo funciona

1. **Subís un documento** (PDF, TXT o MD) → se divide en fragmentos (chunks) de 1024 caracteres
2. **Cada fragmento se embedding** con Gemini y se guarda en Qdrant (base vectorial)
3. **Cuando preguntás algo**, tu pregunta se embeddinga y se busca el fragmento más similar en Qdrant
4. **Gemini responde** usando el contexto recuperado + tu pregunta

## Estructura del proyecto

```
Esperanto/
├── backend/
│   ├── app/
│   │   ├── main.py          # Servidor FastAPI
│   │   ├── config.py        # Configuración (API key, modelos, parámetros)
│   │   ├── models.py        # Schemas Pydantic
│   │   ├── rag_engine.py    # Lógica RAG: embeddings, Qdrant, chat
│   │   └── routes/
│   │       └── chat.py      # Endpoints /chat y /upload
│   ├── Dockerfile
│   └── requirements.txt
├── frontend/
│   └── src/app/
│       ├── page.tsx         # UI del chat con upload de archivos
│       └── layout.tsx       # Layout con Source Serif 4, dark mode
├── docker-compose.yml
└── README.md
```

## Deploy

### Frontend → Vercel

```bash
cd frontend
npx vercel --prod
```

Variable de entorno: `NEXT_PUBLIC_API_URL` → URL del backend

### Backend → Railway

1. Crear proyecto en [Railway](https://railway.app)
2. Conectar este repo
3. Configurar variables de entorno: `GOOGLE_API_KEY`
4. Para Qdrant persistente: usar el template de Railway o [Qdrant Cloud](https://cloud.qdrant.io)
