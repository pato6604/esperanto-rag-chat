#!/usr/bin/bash
source "$LOCALAPPDATA/hermes/.env" 2>/dev/null
key="$GOOGLE_API_KEY"
curl -s "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $key" \
  -d @"/c/Users/Patricio Quintana/Esperanto/review_payload.json" 2>&1
