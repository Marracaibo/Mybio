#!/usr/bin/env bash
# Installazione completa sul VPS (Ubuntu 24.04 o 26.04), da lanciare dalla cartella del progetto:
#
#   sudo bash deploy/installa.sh
#
# Fa tutto da solo: Docker, firewall, OpenWA, file .env, collegamento del numero WhatsApp,
# scelta del gruppo, motore e webhook. Chiede solo la chiave Anthropic, il numero da collegare
# e il gruppo. Si può rilanciare in qualsiasi momento: salta i passi già fatti.
set -euo pipefail

PROGETTO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY="$PROGETTO/deploy"
ENV_FILE="$PROGETTO/.env"
OPENWA_DIR="${OPENWA_DIR:-/opt/openwa}"
OPENWA_URL_LOCALE="http://127.0.0.1:2785"
NOME_SESSIONE="linkedin"
# INSTALLA_SALTA_SISTEMA=1 non tocca pacchetti, swap e firewall;
# INSTALLA_SALTA_OPENWA=1 usa l'OpenWA già in esecuzione senza aggiornarlo né riavviarlo.
SALTA_SISTEMA="${INSTALLA_SALTA_SISTEMA:-0}"
SALTA_OPENWA="${INSTALLA_SALTA_OPENWA:-0}"

# ---------------------------------------------------------------- utilità
passo() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok() { printf '\033[32m    ✔ %s\033[0m\n' "$*"; }
avviso() { printf '\033[33m    ! %s\033[0m\n' "$*"; }
errore() { printf '\033[31m    ✘ %s\033[0m\n' "$*" >&2; exit 1; }
# Le domande leggono dal terminale (fd 3) anche se lo script arriva da una pipe.
exec 3<"${INSTALLA_RISPOSTE:-/dev/tty}" || { echo "Serve un terminale interattivo." >&2; exit 1; }
chiedi() { local r=""; read -r -u 3 -p "    $1 " r || true; printf '%s' "$r"; }
chiedi_segreto() { local r=""; read -r -s -u 3 -p "    $1 " r || true; echo >&2; printf '%s' "$r"; }

leggi_env() { [ -f "$ENV_FILE" ] && grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
scrivi_env() {
  local chiave="$1" valore="$2" tmp
  tmp="$(mktemp)"
  if grep -qE "^$chiave=" "$ENV_FILE"; then
    awk -v k="$chiave" -v v="$valore" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' "$ENV_FILE" >"$tmp"
  else
    cat "$ENV_FILE" >"$tmp"; printf '%s=%s\n' "$chiave" "$valore" >>"$tmp"
  fi
  cat "$tmp" >"$ENV_FILE"; rm -f "$tmp"
}

CHIAVE_OPENWA=""
api() { # api METODO PERCORSO [JSON] -> stampa il corpo, esce con errore se HTTP >= 400
  local metodo="$1" percorso="$2" corpo="${3:-}" out codice
  out="$(mktemp)"
  if [ -n "$corpo" ]; then
    codice="$(curl -sS -o "$out" -w '%{http_code}' -X "$metodo" -H "X-API-Key: $CHIAVE_OPENWA" \
      -H 'Content-Type: application/json' --data "$corpo" "$OPENWA_URL_LOCALE$percorso" || echo 000)"
  else
    codice="$(curl -sS -o "$out" -w '%{http_code}' -X "$metodo" -H "X-API-Key: $CHIAVE_OPENWA" \
      "$OPENWA_URL_LOCALE$percorso" || echo 000)"
  fi
  cat "$out"; rm -f "$out"
  [ "$codice" -lt 400 ] 2>/dev/null
}
json() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }

[ "$(id -u)" -eq 0 ] || errore "Lancia lo script con sudo: sudo bash deploy/installa.sh"
[ -f "$PROGETTO/.env.example" ] || errore "Non trovo .env.example: lancia lo script dalla cartella del progetto."

# ---------------------------------------------------------------- 1. sistema
if [ "$SALTA_SISTEMA" != "1" ]; then
  passo "1/8 Pacchetti di sistema e Docker"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git openssl python3 ufw >/dev/null
  if ! command -v docker >/dev/null; then
    curl -fsSL https://get.docker.com | sh >/dev/null
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true
  ok "Docker $(docker --version | awk '{print $3}' | tr -d ,)"

  # 2 GB di swap: Chromium (dentro OpenWA) ha picchi di memoria all'avvio.
  if ! swapon --show | grep -q .; then
    fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
    ok "Swap da 2 GB attivato"
  fi

  # Firewall: aperta solo la porta SSH. OpenWA e il motore non sono raggiungibili da internet.
  ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null
  ufw --force enable >/dev/null
  ok "Firewall attivo (solo SSH aperto)"
else
  passo "1/8 Sistema: saltato (INSTALLA_SALTA_SISTEMA=1)"
fi

# ---------------------------------------------------------------- 2. OpenWA
passo "2/8 OpenWA (gateway WhatsApp)"
if [ "$SALTA_OPENWA" = "1" ]; then
  ok "Uso l'OpenWA già avviato"
else
if [ ! -d "$OPENWA_DIR/.git" ]; then
  git clone -q --depth 1 https://github.com/rmyndharis/OpenWA.git "$OPENWA_DIR"
fi
cat >"$OPENWA_DIR/docker-compose.override.yml" <<'YAML'
# Scritto da deploy/installa.sh del motore LinkedIn.
services:
  openwa-api:
    image: ghcr.io/rmyndharis/openwa:latest
  # Non usiamo l'orchestrazione di database da dashboard: niente accesso al socket di Docker.
  docker-proxy:
    profiles: ["disabled"]
YAML
touch "$OPENWA_DIR/.env"
for riga in "ENGINE_TYPE=whatsapp-web.js" "SSRF_ALLOWED_HOSTS=motore" "TZ=Europe/Rome"; do
  chiave="${riga%%=*}"
  if grep -qE "^$chiave=" "$OPENWA_DIR/.env"; then
    sed -i "s|^$chiave=.*|$riga|" "$OPENWA_DIR/.env"
  else
    echo "$riga" >>"$OPENWA_DIR/.env"
  fi
done
(cd "$OPENWA_DIR" && docker compose pull -q openwa-api && docker compose up -d --no-build openwa-api >/dev/null 2>&1)
fi
printf '    Attendo che OpenWA sia pronto'
for _ in $(seq 1 90); do
  curl -fsS "$OPENWA_URL_LOCALE/api/health" >/dev/null 2>&1 && break
  printf '.'; sleep 2
done
echo
curl -fsS "$OPENWA_URL_LOCALE/api/health" >/dev/null 2>&1 || errore "OpenWA non risponde. Guarda i log: cd $OPENWA_DIR && docker compose logs openwa-api"
CHIAVE_OPENWA="$(docker exec openwa-api cat /app/data/.api-key 2>/dev/null | tr -d '[:space:]')"
[ -n "$CHIAVE_OPENWA" ] || errore "Non riesco a leggere la chiave API di OpenWA (/app/data/.api-key)."
ok "OpenWA attivo su $OPENWA_URL_LOCALE (solo locale)"

# ---------------------------------------------------------------- 3. .env
passo "3/8 File .env"
if [ ! -f "$ENV_FILE" ]; then
  cp "$PROGETTO/.env.example" "$ENV_FILE"
  scrivi_env ANTHROPIC_API_KEY ""
  ok "Creato .env da .env.example"
fi
chmod 600 "$ENV_FILE"
chiave_anthropic="$(leggi_env ANTHROPIC_API_KEY)"
while [ -z "$chiave_anthropic" ] || [ "$chiave_anthropic" = "sk-ant-..." ]; do
  chiave_anthropic="$(chiedi_segreto "Incolla la chiave API di Anthropic (non viene mostrata) e premi Invio:")"
  case "$chiave_anthropic" in sk-ant-*) ;; *) avviso "Le chiavi Anthropic iniziano con sk-ant-: riprova."; chiave_anthropic="";; esac
done
scrivi_env ANTHROPIC_API_KEY "$chiave_anthropic"
scrivi_env OPENWA_API_KEY "$CHIAVE_OPENWA"
[ -n "$(leggi_env OPENWA_WEBHOOK_SECRET)" ] || scrivi_env OPENWA_WEBHOOK_SECRET "$(openssl rand -hex 24)"
ok "Chiavi salvate in .env (leggibile solo da root)"

# ---------------------------------------------------------------- 4. numero WhatsApp
passo "4/8 Collegamento del numero WhatsApp dedicato"
stato_sessione() { api GET "/api/sessions/$1" | json 'print(d.get("status",""))' 2>/dev/null || true; }
errore_sessione() {
  local motivo
  motivo="$(api GET "/api/sessions/$1" | json 'print(d.get("lastError") or "nessun dettaglio")' 2>/dev/null || true)"
  errore "WhatsApp Web non si è avviato ($motivo). Rilancia lo script; se si ripete: cd $OPENWA_DIR && docker compose logs openwa-api"
}
sessione="$(leggi_env OPENWA_SESSION)"
if [ -n "$sessione" ] && ! api GET "/api/sessions/$sessione" >/dev/null 2>&1; then sessione=""; fi
if [ -z "$sessione" ]; then
  sessione="$(api GET /api/sessions | json "
s=d if isinstance(d,list) else d.get('data',[])
print(next((x['id'] for x in s if x.get('name')=='$NOME_SESSIONE'),''))" 2>/dev/null || true)"
fi
if [ -z "$sessione" ]; then
  sessione="$(api POST /api/sessions "{\"name\":\"$NOME_SESSIONE\"}" | json 'print(d["id"])')" \
    || errore "Non riesco a creare la sessione in OpenWA."
fi
scrivi_env OPENWA_SESSION "$sessione"

if [ "$(stato_sessione "$sessione")" = "ready" ]; then
  ok "Numero già collegato"
else
  api POST "/api/sessions/$sessione/start" >/dev/null 2>&1 || true
  printf '    Avvio WhatsApp Web'
  for _ in $(seq 1 60); do
    case "$(stato_sessione "$sessione")" in qr_ready|ready) break;; failed) echo; errore_sessione "$sessione";; esac
    printf '.'; sleep 3
  done
  echo
  if [ "$(stato_sessione "$sessione")" != "ready" ]; then
    echo "    Ti serve il telefono con il numero dedicato."
    numero=""
    while ! [[ "$numero" =~ ^[0-9]{8,15}$ ]]; do
      numero="$(chiedi "Numero dedicato con prefisso, solo cifre (es. 393331234567):" | tr -d ' +')"
    done
    codice=""
    for _ in 1 2 3 4 5; do
      codice="$(api POST "/api/sessions/$sessione/pairing-code" "{\"phoneNumber\":\"$numero\"}" \
        | json 'print(d["pairingCode"])' 2>/dev/null || true)"
      [ -n "$codice" ] && break
      sleep 5
    done
    if [ -n "$codice" ]; then
      echo
      printf '    Codice di collegamento: \033[1;32m%s\033[0m\n' "$codice"
      echo "    Sul telefono: WhatsApp → Impostazioni → Dispositivi collegati → Collega un dispositivo"
      echo "    → \"Collega con il numero di telefono\" e inserisci il codice."
    else
      avviso "Non riesco a ottenere il codice. Usa il QR dalla dashboard: dal tuo PC apri"
      avviso "ssh -L 2785:127.0.0.1:2785 <utente>@<ip-server>  e poi http://localhost:2785"
    fi
    printf '    Attendo il collegamento'
    for _ in $(seq 1 100); do
      case "$(stato_sessione "$sessione")" in ready) break;; failed) echo; errore_sessione "$sessione";; esac
      printf '.'; sleep 3
    done
    echo
    [ "$(stato_sessione "$sessione")" = "ready" ] || errore "Il numero non risulta collegato. Rilancia lo script per riprovare."
  fi
  ok "Numero collegato"
fi

# ---------------------------------------------------------------- 5. gruppo
passo "5/8 Gruppo dove arrivano le bozze"
gruppo="$(leggi_env WHATSAPP_GROUP_ID)"
if [[ "$gruppo" =~ @g\.us$ ]] && [ "$(chiedi "Gruppo già scelto ($gruppo). Lo tengo? [S/n]")" != "n" ]; then
  ok "Tengo il gruppo $gruppo"
else
  while true; do
    elenco="$(api GET "/api/sessions/$sessione/groups" | json "
for i,g in enumerate(d,1): print(f\"{i}\t{g['id']}\t{g.get('name','')}\")" 2>/dev/null || true)"
    if [ -z "$elenco" ]; then
      chiedi "Il numero non è in nessun gruppo. Aggiungilo al gruppo WhatsApp e premi Invio." >/dev/null
      continue
    fi
    echo "$elenco" | awk -F'\t' '{printf "    %s) %s\n", $1, $3}'
    scelta="$(chiedi "Numero del gruppo dove mandare le bozze (Invio per ricaricare l'elenco):")"
    gruppo="$(echo "$elenco" | awk -F'\t' -v s="$scelta" '$1==s{print $2}')"
    [ -n "$gruppo" ] && break
  done
  scrivi_env WHATSAPP_GROUP_ID "$gruppo"
  ok "Gruppo scelto: $gruppo"
fi

# ---------------------------------------------------------------- 6. Google Drive (facoltativo)
passo "6/8 Google Drive (facoltativo)"
profili=""
if [ -f "$DEPLOY/segreti/rclone/rclone.conf" ]; then
  profili="drive"; ok "Trovato rclone.conf: la cartella viene sincronizzata con Google Drive"
elif [ "$(chiedi "Vuoi sincronizzare la cartella con Google Drive? [s/N]")" = "s" ]; then
  avviso "Copia rclone.conf in $DEPLOY/segreti/rclone/ (vedi README, \"Google Drive\") e rilancia lo script."
  avviso "Per ora proseguo senza Drive."
else
  ok "Senza Drive: le bozze nascono dagli articoli delle newsletter (fonti.txt)"
fi
# deploy/.env lo legge docker compose da solo: anche i comandi lanciati a mano usano lo stesso profilo.
touch "$DEPLOY/.env"
sed -i '/^COMPOSE_PROFILES=/d' "$DEPLOY/.env"
echo "COMPOSE_PROFILES=$profili" >>"$DEPLOY/.env"

# ---------------------------------------------------------------- 7. motore
passo "7/8 Motore (adatta, invia, comandi nel gruppo)"
mkdir -p "$DEPLOY/dati/condivisa" "$DEPLOY/dati/motore" "$DEPLOY/segreti/rclone"
chown -R 1000:1000 "$DEPLOY/dati" "$DEPLOY/segreti"
compose() { (cd "$DEPLOY" && docker compose "$@"); }
compose up -d --build >/dev/null 2>&1 || compose up -d --build
printf '    Attendo il motore'
for _ in $(seq 1 40); do
  compose exec -T motore wget -qO- http://127.0.0.1:3000/salute >/dev/null 2>&1 && break
  printf '.'; sleep 3
done
echo
compose exec -T motore node --import tsx src/inizializza.ts >/dev/null || errore "Inizializzazione della cartella condivisa non riuscita."
compose exec -T motore node --import tsx src/webhook.ts || errore "Registrazione del webhook non riuscita."
ok "Motore attivo, webhook registrato"

# ---------------------------------------------------------------- 8. prova
passo "8/8 Prova"
if [ "$(chiedi "Mando un messaggio di prova nel gruppo? [S/n]")" != "n" ]; then
  testo='✅ Motore LinkedIn collegato. Le bozze arriveranno qui ogni mattina alle 8:30. Per ritoccarne una, rispondi citandola con la modifica (es. "più corto"), oppure con "aiuto" per l'\''elenco dei comandi.'
  corpo="$(python3 -c 'import json,sys; print(json.dumps({"chatId": sys.argv[1], "text": sys.argv[2]}))' "$gruppo" "$testo")"
  if api POST "/api/sessions/$sessione/messages/send-text" "$corpo" >/dev/null; then ok "Messaggio inviato"; else avviso "Invio non riuscito: controlla i log."; fi
fi

cat <<FINE

Fatto. Ogni giorno: newsletter alle $(leggi_env ORARIO_RSS || true), bozze alle $(leggi_env ORARIO_ADATTA || true), invio nel gruppo alle $(leggi_env ORARIO_INVIA || true) (ora di Roma).

Comandi utili (dalla cartella $PROGETTO/deploy):
  sudo docker compose logs -f motore                                   log in diretta
  sudo docker compose exec motore node --import tsx src/rss.ts         importa ora le newsletter
  sudo docker compose exec motore node --import tsx src/adatta.ts      crea ora le bozze
  sudo docker compose exec motore node --import tsx src/invia.ts       invia ora la prossima bozza
Per modificare le linee guida: $DEPLOY/dati/condivisa/linee-guida.md (o su Drive, se collegato).
Per rifare un passo (nuovo numero, altro gruppo): rilancia  sudo bash deploy/installa.sh
FINE
