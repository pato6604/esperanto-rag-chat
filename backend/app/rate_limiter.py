import time
from collections import defaultdict

from fastapi import HTTPException


class InMemoryRateLimiter:
    def __init__(self):
        self._windows: dict[str, list[float]] = defaultdict(list)

    def _cleanup(self, user_id: str, window_sec: float):
        now = time.time()
        self._windows[user_id] = [
            t for t in self._windows[user_id]
            if now - t < window_sec
        ]

    def check(self, user_id: str, max_requests: int, window_sec: float = 60):
        self._cleanup(user_id, window_sec)
        if len(self._windows[user_id]) >= max_requests:
            raise HTTPException(
                status_code=429,
                detail=f"Demasiadas requests. Limite: {max_requests} por {window_sec}s. Espera un momento.",
            )
        self._windows[user_id].append(time.time())


rate_limiter = InMemoryRateLimiter()
