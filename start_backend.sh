#!/usr/bin/bash
source "$LOCALAPPDATA/hermes/.env" 2>/dev/null
cd "/c/Users/Patricio Quintana/Esperanto/backend"
export GOOGLE_API_KEY
python -m uvicorn app.main:app --host 0.0.0.0 --port 8002
