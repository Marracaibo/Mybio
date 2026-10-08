"""Scribe locale: trascrive i vocali con Whisper (faster-whisper, modello "small" su CPU) e dà la voce
al maggiordomo con Piper.

POST /trascrivi con il file audio come corpo (es. audio/ogg) -> {"text": "..."}.
POST /parla con il testo (UTF-8) come corpo -> vocale audio/ogg (Opus), pronto per WhatsApp.
GET /salute -> {"ok": true}. Nessuna porta pubblica: lo chiama solo il motore sulla rete Docker.
"""

import io
import json
import os
import tempfile
import threading
import urllib.request
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import av
from faster_whisper import WhisperModel
from piper import PiperVoice, SynthesisConfig

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

# Voce: le voci italiane di Piper sono paola-medium (la più chiara), serena-medium/high e riccardo-x_low (maschile,
# ma di bassa qualità). Si scaricano al primo uso in /modelli/piper.
VOCE = os.environ.get("PIPER_VOCE", "it_IT-paola-medium")
VELOCITA = float(os.environ.get("PIPER_LENTEZZA", "1.05"))  # >1 parla più piano
CARTELLA_VOCI = os.path.join(os.environ.get("HF_HOME", "/modelli"), "piper")
_voce = None
blocco_voce = threading.Lock()


def voce():
    global _voce
    if _voce is None:
        os.makedirs(CARTELLA_VOCI, exist_ok=True)
        lingua, nome, qualita = VOCE.split("-", 2)
        base = f"https://huggingface.co/rhasspy/piper-voices/resolve/main/{lingua.split('_')[0]}/{lingua}/{nome}/{qualita}/{VOCE}"
        for estensione in (".onnx", ".onnx.json"):
            percorso = os.path.join(CARTELLA_VOCI, VOCE + estensione)
            if not os.path.exists(percorso):
                print(f"Scarico la voce {VOCE}{estensione}...", flush=True)
                urllib.request.urlretrieve(base + estensione, percorso + ".parziale")
                os.replace(percorso + ".parziale", percorso)
        _voce = PiperVoice.load(os.path.join(CARTELLA_VOCI, VOCE + ".onnx"))
    return _voce


def parla(testo):
    """Testo -> vocale Ogg/Opus mono (il formato dei vocali di WhatsApp)."""
    wav = io.BytesIO()
    with blocco_voce:
        with wave.open(wav, "wb") as f:
            voce().synthesize_wav(testo, f, syn_config=SynthesisConfig(length_scale=VELOCITA))
    wav.seek(0)
    uscita = io.BytesIO()
    with av.open(wav, "r") as ingresso, av.open(uscita, "w", format="ogg") as ogg:
        flusso = ogg.add_stream("libopus", rate=48000, layout="mono")
        flusso.bit_rate = 32000
        ricampiona = av.AudioResampler(format="s16", layout="mono", rate=48000)
        for frame in ingresso.decode(audio=0):
            for f in ricampiona.resample(frame):
                for pacchetto in flusso.encode(f):
                    ogg.mux(pacchetto)
        for f in ricampiona.resample(None):
            for pacchetto in flusso.encode(f):
                ogg.mux(pacchetto)
        for pacchetto in flusso.encode(None):
            ogg.mux(pacchetto)
    return uscita.getvalue()


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
        percorso = self.path.split("?")[0]
        lunghezza = int(self.headers.get("Content-Length") or 0)
        if percorso == "/parla":
            if not 0 < lunghezza <= 20000:
                return self._json(413, {"errore": "testo vuoto o troppo lungo"})
            try:
                audio = parla(self.rfile.read(lunghezza).decode("utf-8"))
            except Exception as e:
                return self._json(500, {"errore": str(e)[:200]})
            self.send_response(200)
            self.send_header("Content-Type", "audio/ogg; codecs=opus")
            self.send_header("Content-Length", str(len(audio)))
            self.end_headers()
            self.wfile.write(audio)
            return
        if percorso != "/trascrivi":
            return self._json(404, {"errore": "non trovato"})
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
