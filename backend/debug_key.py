"""Debug key reading - minimal."""
from pathlib import Path

p = Path.home() / "AppData/Local/hermes/.env"
for line in p.read_text().splitlines():
    ls = line.strip()
    if "GOOGLE_API_KEY=*** ls and not ls.startswith("#"):
        parts = ls.split("=", 1)
        val = parts[1]
        print("FOUND len=", len(val), "first=", val[0])
