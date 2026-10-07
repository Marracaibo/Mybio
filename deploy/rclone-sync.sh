#!/bin/sh
# Sincronizza in due direzioni la cartella di Google Drive con /condivisa, ogni RCLONE_INTERVALLO secondi.
# Così chi lavora su Drive (dal PC o dal telefono) e il motore in cloud vedono gli stessi file.
set -u

REMOTO="${RCLONE_REMOTO:-gdrive:Doublegram-LinkedIn}"
LOCALE=/condivisa
INTERVALLO="${RCLONE_INTERVALLO:-120}"
# Stato di bisync e cache accanto alla configurazione: devono sopravvivere ai riavvii del container.
LAVORO=/config/rclone/bisync
MARCATORE=/config/rclone/.bisync-inizializzato

sincronizza() {
  rclone bisync "$REMOTO" "$LOCALE" \
    --workdir "$LAVORO" --cache-dir /config/rclone/cache \
    --create-empty-src-dirs \
    --resilient --recover --max-lock 5m \
    --conflict-resolve newer --conflict-loser num \
    --drive-skip-gdocs \
    --exclude "desktop.ini" --exclude "~\$*" --exclude "*.tmp" \
    "$@"
}

if [ ! -f "$MARCATORE" ]; then
  echo "Prima sincronizzazione (resync) tra $REMOTO e $LOCALE"
  sincronizza --resync && touch "$MARCATORE" || echo "Prima sincronizzazione fallita, riprovo al prossimo giro"
fi

while true; do
  if [ -f "$MARCATORE" ]; then
    sincronizza || echo "$(date -Iseconds) bisync fallito, riprovo tra ${INTERVALLO}s"
  else
    sincronizza --resync && touch "$MARCATORE"
  fi
  sleep "$INTERVALLO"
done
