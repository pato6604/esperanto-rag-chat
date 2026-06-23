# RAG System Architecture

This document describes the architecture of our RAG (Retrieval-Augmented Generation) system.

## Components

1. **Vector Database**: Qdrant stores document embeddings for semantic search.
2. **Embedding Model**: Gemini Embedding API converts text chunks into vector embeddings.
3. **LLM**: Gemini 2.5 Pro generates answers based on retrieved context.
4. **Orchestrator**: LlamaIndex coordinates retrieval and generation.

## Data Flow

1. Documents are chunked into 1024-character segments.
2. Each chunk is embedded using Gemini Embedding API.
3. Embeddings are stored in Qdrant with the original text.
4. User queries are embedded and compared against stored vectors.
5. Top 5 most similar chunks are retrieved.
6. Gemini 2.5 Pro generates a response with the context.

## Configuration

- Chunk size: 1024 characters
- Chunk overlap: 200 characters
- Similarity top-k: 5
- Embedding dimension: 3072
