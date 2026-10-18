# Backend image for any container host (Render, Koyeb, Cloud Run, ...).
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Don't run as root inside the container.
RUN useradd --create-home aura && chown -R aura /app
USER aura

# Hosts inject the port to listen on as $PORT; 8000 is the local default.
ENV PORT=8000
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
