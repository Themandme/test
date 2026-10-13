# Production image for the Senior Directory API.
FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Install deps first for layer caching.
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# App code + the shared brands dataset (read at startup).
COPY backend/ ./backend/
COPY data/ ./data/

# Run as a non-root user.
RUN useradd --create-home --uid 10001 appuser
USER appuser

WORKDIR /app/backend
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health').status==200 else 1)"

# Gunicorn + Uvicorn workers. Tune workers via WEB_CONCURRENCY.
CMD ["gunicorn", "app.main:app", "-c", "gunicorn_conf.py"]
