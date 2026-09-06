"""Bounded per-process admission control; durable provider budgets live in the DB."""

from collections import OrderedDict
from threading import Lock
from time import monotonic

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse


class WindowLimiter:
    def __init__(self, maximum_keys=4096):
        self.entries = OrderedDict()
        self.maximum_keys = maximum_keys
        self.lock = Lock()

    def allow(self, key, limit, now=None):
        now = monotonic() if now is None else now
        with self.lock:
            start, count = self.entries.get(key, (now, 0))
            if now - start >= 60:
                start, count = now, 0
            if count >= limit:
                return False
            self.entries[key] = (start, count + 1)
            self.entries.move_to_end(key)
            while len(self.entries) > self.maximum_keys:
                self.entries.popitem(last=False)
            return True


class RequestLimitsMiddleware(BaseHTTPMiddleware):
    def __init__(self, app):
        super().__init__(app)
        self.limiter = WindowLimiter()

    async def dispatch(self, request, call_next):
        path = request.url.path
        # Use socket peer, never caller-controlled forwarding headers. Same-origin
        # Vercel traffic shares the ceiling, intentionally limiting total load.
        scope = None
        if path.startswith("/api/annotations"):
            scope = ("match", 180)
        elif request.method == "POST" and path in {
            "/api/recommendations/generate", "/api/recommendations/preview",
            "/api/channels", "/api/channels/resolve", "/api/account/telegram-link",
        }:
            scope = ("expensive", 20)
        if scope:
            peer = request.client.host if request.client else "unknown"
            if not self.limiter.allow((scope[0], peer), scope[1]):
                return JSONResponse(
                    {"detail": "Too many requests. Please wait a minute and try again."},
                    status_code=429, headers={"Retry-After": "60", "Cache-Control": "no-store"},
                )
        return await call_next(request)
