import requests
try:
    r = requests.post("http://localhost:8001/api/chat", json={"message": "Decime hola en español", "session_id": "test"}, timeout=30)
    print(r.status_code)
    print(r.text[:500])
except Exception as e:
    print(f"Error: {e}")
