"""Test Google OpenAI-compatible endpoint models."""
from pathlib import Path
from openai import OpenAI

env_path = Path.home() / "AppData/Local/hermes/.env"
key = ""
if env_path.exists():
    for line in env_path.read_text().splitlines():
        if line.startswith("GOOGLE_API_KEY=") and len(line) > 15:
            key = line.split("=", 1)[1]
            break

client = OpenAI(
    api_key=key,
    base_url="https://generativelanguage.googleapis.com/v1beta/openai",
)

# Try different embedding models
for model in ["text-embedding-004", "models/text-embedding-004"]:
    try:
        resp = client.embeddings.create(model=model, input=["test"])
        print(f"EMBED OK  {model}: {len(resp.data[0].embedding)} dims")
    except Exception as e:
        print(f"EMBED FAIL {model}: {str(e)[:80]}")

# Try different chat models
for model in [
    "gemini-2.5-pro-exp-03-07",
    "models/gemini-2.5-pro-exp-03-07",
    "gemini-2.0-flash",
]:
    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": "say OK only"}],
        )
        print(f"CHAT OK   {model}: {resp.choices[0].message.content}")
    except Exception as e:
        print(f"CHAT FAIL {model}: {str(e)[:80]}")
