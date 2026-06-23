"""List available Google AI models and their methods."""
import json
import urllib.request
from pathlib import Path

env_path = Path.home() / "AppData/Local/hermes/.env"
key = ""
if env_path.exists():
    for line in env_path.read_text().splitlines():
        if line.startswith("GOOGLE_API_KEY=") and len(line) > 15:
            key = line.split("=", 1)[1]
            break

# List models via REST API
url = "https://generativelanguage.googleapis.com/v1/models?key=" + key
resp = urllib.request.urlopen(url).read()
models = json.loads(resp)

for m in models.get("models", []):
    name = m["name"].replace("models/", "")
    methods = m.get("supportedGenerationMethods", [])
    print(f"{name:45s} {methods}")
