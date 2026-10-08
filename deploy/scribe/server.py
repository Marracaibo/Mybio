"""Scribe locale: trascrive i vocali con Whisper (faster-whisper, modello "small" su CPU).

POST /trascrivi con il file audio come corpo (es. audio/ogg) -> {"text": "..."}.
GET /salute -> {"ok": true}. Nessuna porta pubblica: lo chiama solo il motore sulla rete Docker.
"""

import json
import os
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from faster_whisper import WhisperModel

MODELLO = os.environ.get("WHISPER_MODELLO", "small")
LINGUA = os.environ.get("WHISPER_LINGUA", "it")
# Più alto = più preciso ma più lento (5 è il valore di riferimento di Whisper).
BEAM = int(os.environ.get("WHISPER_BEAM", "5"))
# Parole che Whisper deve riconoscere bene (nomi propri e termini di lavoro).
VOCABOLARIO = os.environ.get(
    "WHISPER_VOCABOLARIO", "Doublegram, Telegram, WhatsApp, LinkedIn, community, bot, admin, call, demo, startup."
)
MAX_BYTE = 25 * 1024 * 1024

print(f"Carico Whisper '{MODELLO}' (al primo avvio lo scarica, qualche minuto)...", flush=True)
modello = WhisperModel(MODELLO, device="cpu", compute_type="int8", cpu_threads=int(os.environ.get("WHISPER_THREADS", "2")))
blocco = threading.Lock()  # una trascrizione alla volta: il server ha pochi core
print("Scribe pronto", flush=True)


class Gestore(BaseHTTPRequestHandler):
    def _json(self, codice, dati):
        corpo = json.dumps(dati, ensure_ascii=False).encode()
        self.send_response(codice)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(corpo)))
        self.end_headers()
        self.wfile.write(corpo)

    def do_GET(self):
        if self.path == "/salute":
            return self._json(200, {"ok": True, "modello": MODELLO})
        self._json(404, {"errore": "non trovato"})

    def do_POST(self):
        if self.path.split("?")[0] != "/trascrivi":
            return self._json(404, {"errore": "non trovato"})
        lunghezza = int(self.headers.get("Content-Length") or 0)
        if not 0 < lunghezza <= MAX_BYTE:
            return self._json(413, {"errore": "audio vuoto o troppo grande"})
        audio = self.rfile.read(lunghezza)
        with tempfile.NamedTemporaryFile(suffix=".audio") as f:
            f.write(audio)
            f.flush()
            try:
                with blocco:
                    segmenti, _ = modello.transcribe(
                        f.name, language=LINGUA, vad_filter=True, beam_size=BEAM, initial_prompt=VOCABOLARIO
                    )
                    testo = " ".join(s.text.strip() for s in segmenti).strip()
            except Exception as e:  # audio illeggibile
                return self._json(422, {"errore": str(e)[:200]})
        self._json(200, {"text": testo})

    def log_message(self, *args):
        pass


ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORTA", "8000"))), Gestore).serve_forever()
