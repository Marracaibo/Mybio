#!/usr/bin/env bash
# Mostra nel terminale il QR per collegare il numero WhatsApp a OpenWA e lo aggiorna finché il
# collegamento non riesce. Alternativa al codice di 8 caratteri. Uso:  sudo bash deploy/qr.sh
set -euo pipefail

PROGETTO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
URL="http://127.0.0.1:2785"
[ "$(id -u)" -eq 0 ] || { echo "Lancia con sudo: sudo bash deploy/qr.sh" >&2; exit 1; }

if ! command -v zbarimg >/dev/null || ! command -v qrencode >/dev/null; then
  echo "Installo gli strumenti per mostrare il QR..."
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq zbar-tools qrencode >/dev/null
fi

CHIAVE="$(docker exec openwa-api cat /app/data/.api-key | tr -d '[:space:]')"
SESSIONE="$(grep -E '^OPENWA_SESSION=' "$PROGETTO/.env" | cut -d= -f2-)"
[ -n "$SESSIONE" ] || { echo "OPENWA_SESSION mancante in .env: lancia prima sudo bash deploy/installa.sh" >&2; exit 1; }
api() { curl -sS -H "X-API-Key: $CHIAVE" "$@"; }
stato() { api "$URL/api/sessions/$SESSIONE" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))'; }

case "$(stato)" in
  ready) echo "Il numero è già collegato. Ora: sudo bash deploy/installa.sh"; exit 0;;
  qr_ready) ;;
  *) api -X POST "$URL/api/sessions/$SESSIONE/start" >/dev/null || true; sleep 10;;
esac

PNG="$(mktemp --suffix .png)"
trap 'rm -f "$PNG"' EXIT
while true; do
  s="$(stato)"
  if [ "$s" = "ready" ]; then
    clear; echo "✔ Numero collegato. Ora rilancia:  sudo bash deploy/installa.sh"; exit 0
  fi
  if api "$URL/api/sessions/$SESSIONE/qr" | python3 -c '
import base64, json, sys
d = json.load(sys.stdin)
q = d.get("qrCode") or ""
if "," not in q: sys.exit(1)
open(sys.argv[1], "wb").write(base64.b64decode(q.split(",", 1)[1]))' "$PNG" 2>/dev/null; then
    clear
    zbarimg -q --raw "$PNG" 2>/dev/null | head -1 | qrencode -t ansiutf8 -m 2
    echo "Sul telefono del numero dedicato: WhatsApp → Dispositivi collegati → Collega un dispositivo"
    echo "e inquadra il QR. Si aggiorna da solo ogni 15 secondi (stato: $s). Ctrl+C per uscire."
  else
    echo "In attesa del QR (stato: $s)..."
  fi
  sleep 15
done
