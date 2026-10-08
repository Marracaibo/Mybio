# Scribe locale (Whisper small su CPU). Il modello si scarica al primo avvio in /modelli (volume).
FROM python:3.12-slim
# av 19 non è compatibile con faster-whisper 1.2.1 (av.open senza metadata_errors)
RUN pip install --no-cache-dir faster-whisper==1.2.1 "av==18.1.0"
ENV HF_HOME=/modelli PYTHONUNBUFFERED=1
WORKDIR /app
COPY server.py .
EXPOSE 8000
CMD ["python", "server.py"]
