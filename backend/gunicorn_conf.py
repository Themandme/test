"""Gunicorn config for production. Override via env (WEB_CONCURRENCY, PORT, etc.)."""
import os

bind = f"0.0.0.0:{os.getenv('PORT', '8000')}"
workers = int(os.getenv("WEB_CONCURRENCY", "3"))
worker_class = "uvicorn.workers.UvicornWorker"
timeout = 30
graceful_timeout = 30
keepalive = 5
# Recycle workers periodically to bound memory and the per-process rate-limit state.
max_requests = 2000
max_requests_jitter = 200
accesslog = "-"
errorlog = "-"
# Trust the X-Forwarded-* headers from the reverse proxy / load balancer only.
forwarded_allow_ips = os.getenv("FORWARDED_ALLOW_IPS", "127.0.0.1")
