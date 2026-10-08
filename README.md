# doublegram-linkedin-engine

Prende post LinkedIn in inglese che hanno performato bene, li **adatta** (non li traduce) in italiano
per il profilo sales di Doublegram e ogni mattina manda una bozza su un gruppo WhatsApp.
Un umano la legge, la copia e la pubblica a mano su LinkedIn.

Cosa il sistema **non** fa, per scelta:

- nessuna interazione automatica con LinkedIn: niente scraping, API, pubblicazione, like, commenti o connessioni;
- non inventa numeri, clienti, risultati o funzionalità: usa solo `linee-guida.md`, altrimenti scrive `[DATO DA INSERIRE]`
  (i dati di terzi presenti nel post originale si possono riportare solo citandone la fonte nel testo);
- non scrive su WhatsApp a nessuno tranne il gruppo configurato, e mai più di 3 messaggi al giorno.

---

## Come funziona

```
Cartella condivisa (Google Drive)                    Progetto locale (questo repo)
─────────────────────────────────                    ─────────────────────────────
01-da-adattare/   ← metti qui i post inglesi         .env          segreti
   _elaborati/    ← i sorgenti già elaborati         .stato.json   cosa è già stato inviato
02-bozze/         → bozze generate (.md)             .rss-visti.json  articoli RSS già importati
03-approvati/     ← sposti qui quelle scelte         logs/         log mensili
04-pubblicati/    ← archivio dopo la pubblicazione   openwa-data/  (se usi una cartella per OpenWA)
_scartati/        → post fuori target + motivo
_errori/          → file falliti + motivo
linee-guida.md    profilo, pubblico, tono, fatti verificati
fonti.txt         feed RSS delle newsletter (Fase 3)
```

**`npm run rss`** – legge i feed RSS/Atom delle newsletter elencati in `fonti.txt` e salva gli articoli nuovi
in `01-da-adattare/` (file `rss_AAAA-MM-GG_<titolo>.md`, con autore, link e `tipo: newsletter`).
Prende al massimo `RSS_MAX_PER_FEED` articoli per feed, ignora quelli più vecchi di `RSS_GIORNI` giorni e
ricorda quelli già importati, quindi non li duplica. I link a LinkedIn in `fonti.txt` vengono rifiutati.
Un feed che non risponde viene segnalato nel log e gli altri proseguono.

**`npm run adatta`** – per ogni file nuovo in `01-da-adattare/`:

1. estrae il testo (per gli screenshot usa la visione di Claude);
2. **analisi**: formato, hook, struttura, CTA, perché funziona, se l'idea è originale dell'autore, e se il post è adatto al profilo;
   i post fuori target (storie da founder, vita privata, temi fuori tema) finiscono in `_scartati/` con il motivo;
3. **adattamento**: due varianti italiane con la stessa struttura e contenuto nuovo;
4. **verifica**: niente frasi tradotte parola per parola, nessun dato fuori dalle linee guida o non attribuito alla
   sua fonte, niente esperienze in prima persona inventate, citazione dell'autore se serve, più controlli automatici
   su lunghezza, emoji, markdown e numero di menzioni di Doublegram. Se non passa, rigenera **una** volta e poi
   salva comunque, con i problemi in evidenza;
5. scrive `02-bozze/AAAA-MM-GG_<slug>.md` e sposta il sorgente in `01-da-adattare/_elaborati/`.

Un file che fallisce va in `_errori/` con un `.motivo.txt` accanto e la coda prosegue.
Se invece il problema è del servizio (chiave API errata, rete assente, Claude sovraccarico) il giro si ferma
e i file restano in `01-da-adattare/`: verranno elaborati al giro successivo.

**`npm run invia`** – prende la bozza più vecchia di `02-bozze/` non ancora inviata e la manda nel gruppo:

1. contesto: fonte, formato, perché funziona, eventuali problemi della verifica e segnaposto da completare;
2. la **Variante A** in testo semplice (senza asterischi o altra formattazione WhatsApp), pronta da copiare;
3. la **Variante B** (disattivabile con `INVIA_VARIANTE_B=false`).

Se OpenWA non risponde scrive l'errore nel log ed esce, senza tentativi a raffica: riprova al giro successivo
riprendendo dal messaggio a cui si era fermato.

**`npm run servizio`** (Fase 4) – resta sempre acceso e fa due cose:

1. **comandi nel gruppo**: se qualcuno risponde *citando* un messaggio di una bozza con una richiesta come
   "più corto" o "cambia hook", riscrive quella variante (Sonnet), la ricontrolla, aggiorna il file in `02-bozze/`
   (o `03-approvati/`) e risponde nel gruppo con l'esito e il testo nuovo. Le risposte ai comandi **non contano**
   nel limite dei 3 messaggi al giorno; c'è solo un tetto di sicurezza (`COMANDI_MAX_GIORNO`, default 20).
   Tutto il resto che si scrive nel gruppo viene ignorato;
2. **pianificazione** (se `PIANIFICAZIONE_INTERNA=true`): lancia `rss`, `adatta` e `invia` agli orari `ORARIO_*`.
   Se il servizio riparte in ritardo recupera i lavori fino a 3 ore dopo l'orario; oltre, li salta a domani
   (niente invii a sorpresa nel pomeriggio).

I messaggi arrivano da OpenWA tramite un webhook firmato (`OPENWA_WEBHOOK_SECRET`), registrato con `npm run webhook`.

### Formato della bozza

```
---
fonte: Justin Welsh / https://www.linkedin.com/posts/...
formato: controcorrente
perche_funziona: Sfida una convinzione diffusa e dà subito un'alternativa pratica.
verifica: ok
segnaposto: ["Variante B: 1 × [DATO DA INSERIRE]"]
sorgente: post-justin.txt
---
## Variante A
<post pronto da incollare su LinkedIn>

## Variante B
<...>
```

Se la verifica trova problemi, la riga diventa `verifica: problemi: ["Variante A: …", …]`.
La riga `segnaposto` compare solo se nel testo ci sono `[DATO DA INSERIRE]` o `[AUTORE DA INSERIRE]` da completare.

---

## Costi

Il testo da pubblicare lo scrive il modello più capace (`CLAUDE_MODEL`, Sonnet 5.5); trascrizione e
analisi, che sono compiti semplici di lettura, li fa un modello economico (`CLAUDE_MODEL_CONTROLLI`, Haiku 5.5).
La verifica delle bozze la fa Sonnet 5.5 con poco ragionamento (`CLAUDE_MODEL_VERIFICA`, `CLAUDE_EFFORT_CONTROLLI=low`):
nelle prove con post e articoli veri Haiku 4.5 dava esiti diversi sulla stessa bozza e segnalava problemi inesistenti.
Il system prompt con le linee guida è in cache, quindi più file elaborati nello stesso giro costano meno.

Stima indicativa (dipende dalla lunghezza di `linee-guida.md` e dei post): pochi centesimi di dollaro a post,
circa 1,5–3 $ al mese con un post al giorno. Con la Fase 3 il costo cresce con il numero di articoli importati:
ogni feed può portare fino a `RSS_MAX_PER_FEED` articoli al giorno, quindi tieni `fonti.txt` corto o abbassa quel valore.
Per risparmiare si può mettere `CLAUDE_MODEL_VERIFICA=claude-haiku-4-5`, ma la verifica diventa poco affidabile.

---

## Setup (Windows)

Requisiti: Windows 10/11, [Node.js 22](https://nodejs.org), Google Drive per desktop, Docker Desktop (per OpenWA).

```powershell
cd C:\Users\39351\Projects
git clone <url-del-repo> doublegram-linkedin-engine
cd doublegram-linkedin-engine
npm install
copy .env.example .env
notepad .env
```

Nel file `.env`:

| Variabile | Cosa mettere |
|---|---|
| `ANTHROPIC_API_KEY` | chiave API di Anthropic |
| `CLAUDE_MODEL` | modello che scrive le varianti, default `claude-sonnet-5-5` |
| `CLAUDE_MODEL_CONTROLLI` | modello economico per trascrizione e analisi, default `claude-haiku-5-5` |
| `CLAUDE_MODEL_VERIFICA` | modello che controlla le bozze, default `claude-sonnet-5-5` |
| `CLAUDE_EFFORT_CONTROLLI` | ragionamento per analisi e verifica (`low`, `medium`, `high`), default `low` |
| `CLAUDE_FALLBACK` | `default` (consigliato): se il modello rifiuta una richiesta, Anthropic la riprova su un modello alternativo (solo sui modelli che lo supportano, es. Sonnet 5.5). `off` per disattivarlo |
| `SHARED_DIR` | cartella condivisa, es. `G:\Il mio Drive\Doublegram-LinkedIn` |
| `PROFILO_NOME`, `PROFILO_RUOLO`, `PROFILO_PUBBLICO` | chi firma i post e per chi scrive (entrano nel prompt) |
| `MAX_CARATTERI` | lunghezza massima del post, default 1300 |
| `OPENWA_URL`, `OPENWA_API_KEY`, `OPENWA_SESSION` | vedi sotto |
| `WHATSAPP_GROUP_ID` | id del gruppo, formato `120363…@g.us` (vedi sotto) |
| `INVIA_VARIANTE_B` | `true` / `false` |
| `RSS_MAX_PER_FEED` | articoli nuovi presi al massimo da ogni feed a ogni giro, default 3 |
| `RSS_GIORNI` | articoli più vecchi di così vengono ignorati, default 7 |
| `RSS_MAX_CARATTERI` | articoli più lunghi vengono tagliati (con avviso), default 20000 |

Poi crea le cartelle e il file di linee guida di esempio:

```powershell
npm run inizializza
```

e **compila `linee-guida.md`** nella cartella condivisa: è l'unica fonte di fatti che il sistema userà.
Finché contiene campi `{{…}}` da compilare, `adatta` lo segnala nel log.

> **Segreti al sicuro.** `.env`, `.stato.json`, i log e i dati di OpenWA stanno solo nella cartella del progetto.
> Il progetto non deve stare dentro la cartella condivisa (e viceversa): i comandi si rifiutano di partire se succede,
> o se trovano `.env`, `.stato.json` o dati di sessione nella cartella condivisa.

### Setup di OpenWA

[OpenWA](https://github.com/rmyndharis/OpenWA) è un gateway WhatsApp self-hosted con API REST.

1. **Numero dedicato.** Usa una SIM/numero WhatsApp solo per questo scopo, non il tuo personale:
   OpenWA usa un client non ufficiale e il numero potrebbe essere limitato da WhatsApp.
   Aggiungi quel numero al gruppo WhatsApp dove vuoi ricevere le bozze.
2. **Avvio con Docker**, con il motore **whatsapp-web.js** (non Baileys):

   ```powershell
   cd C:\Users\39351\Projects
   git clone https://github.com/rmyndharis/OpenWA.git
   cd OpenWA
   ```

   Nel file `.env` di OpenWA (o nel `docker-compose.yml`, sezione `environment`) imposta:

   ```
   ENGINE_TYPE=whatsapp-web.js
   ```

   e avvia:

   ```powershell
   docker compose up -d
   ```

   I dati di sessione restano nel volume Docker `openwa-data` (sul PC, fuori dalla cartella condivisa).
   Se preferisci una cartella, montala dentro il progetto locale (`openwa-data/` è già in `.gitignore`), mai su Google Drive.
3. **Chiave API**: `docker exec openwa-api cat /app/data/.api-key` → copiala in `OPENWA_API_KEY`.
4. **Sessione**: apri la dashboard su <http://localhost:2785>, crea una sessione, avviala e scansiona il QR
   dal telefono con il numero dedicato (WhatsApp → Dispositivi collegati). L'id della sessione va in `OPENWA_SESSION`.
   In alternativa via API:

   ```powershell
   curl.exe -X POST http://localhost:2785/api/sessions -H "X-API-Key: <chiave>" -H "Content-Type: application/json" -d "{\"name\":\"linkedin\"}"
   curl.exe -X POST http://localhost:2785/api/sessions/<id>/start -H "X-API-Key: <chiave>"
   ```

   e poi `GET /api/sessions/<id>/qr` (o la dashboard) per il QR.
5. `OPENWA_URL` resta `http://localhost:2785` se OpenWA gira sullo stesso PC.

### Trovare l'id del gruppo

Con la sessione collegata e `OPENWA_*` compilate nel `.env`:

```powershell
npm run gruppi
```

stampa `id<TAB>nome` di tutti i gruppi del numero dedicato. Copia l'id del gruppo giusto
(finisce con `@g.us`) in `WHATSAPP_GROUP_ID`. Gli id che non finiscono con `@g.us` (chat singole) vengono rifiutati.

### Pianificazione

In PowerShell, dalla cartella del progetto:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\installa-pianificazione.ps1
```

registra nell'Utilità di pianificazione (cartella *Doublegram-LinkedIn*) `rss` alle 07:00, `adatta` alle 07:30 e `invia` alle 08:30,
tutti i giorni, con l'utente collegato (serve perché Google Drive sia montato). Se il PC era spento all'orario previsto,
partono appena possibile. Orari diversi: `-OraRss 06:30 -OraAdatta 07:00 -OraInvia 09:00`. Per rimuoverle: `-Rimuovi`.

In alternativa lascia acceso `npm run servizio` con `PIANIFICAZIONE_INTERNA=true`: fa la stessa cosa e in più gestisce
i comandi nel gruppo. **Usa uno dei due, non entrambi.** Se vuoi i comandi ma preferisci l'Utilità di pianificazione,
metti `PIANIFICAZIONE_INTERNA=false`.

### Comandi nel gruppo sul PC (Fase 4)

1. Nel `.env`: `OPENWA_WEBHOOK_SECRET` (almeno 16 caratteri casuali) e
   `WEBHOOK_URL=http://host.docker.internal:3000/webhook/openwa` (OpenWA gira in Docker e raggiunge il PC così).
2. Nel `.env` di OpenWA aggiungi `SSRF_ALLOWED_HOSTS=host.docker.internal` (altrimenti OpenWA rifiuta di chiamare
   indirizzi interni) e riavvialo con `docker compose up -d`.
3. `npm run webhook` per registrare il webhook (si può rilanciare: aggiorna quello esistente).
4. `npm run servizio` e lascialo aperto. Funziona solo a PC acceso: per averlo sempre attivo vedi **Deploy in cloud**.

---

## Deploy in cloud (funziona anche a PC spento)

Tutto gira su un piccolo server Linux (VPS) con Docker: OpenWA, il motore (`npm run servizio`) e una
sincronizzazione bidirezionale con la cartella di Google Drive (rclone), così il team continua a lavorare su Drive
come prima. Basta un VPS da 2 vCPU / 4 GB di RAM (es. Hetzner CX22, pochi euro al mese): OpenWA con
whatsapp-web.js usa un Chromium che da solo occupa 300–500 MB.

```
VPS
├─ OpenWA (compose ufficiale)  ── rete Docker "openwa-network" ──  motore (deploy/docker-compose.yml)
│    dati di sessione nel volume openwa_openwa-data                   stato e log in deploy/dati/motore
└─ rclone ⇄ Google Drive (ogni 2 minuti) ──────────────────────────── deploy/dati/condivisa
```

Segreti e dati di sessione restano sul server (`.env`, `deploy/segreti/`, volumi Docker), mai su Drive.
Nessuna porta è pubblica: la dashboard di OpenWA si apre con un tunnel SSH.

### Installazione automatica (consigliata)

Su un VPS nuovo con Ubuntu 24.04 o 26.04 (es. OVHcloud VPS-1, 2 vCore / 4 GB), collegati con
`ssh ubuntu@<ip-del-server>` e lancia:

```bash
git clone https://github.com/Marracaibo/Mybio.git doublegram-linkedin-engine
cd doublegram-linkedin-engine
sudo bash deploy/installa.sh
```

Lo script installa Docker, attiva il firewall (solo SSH aperto) e 2 GB di swap, avvia OpenWA, crea il `.env`
(chiede solo la chiave Anthropic e genera da solo gli altri segreti), collega il numero WhatsApp con un
**codice di 8 caratteri** da inserire sul telefono (Dispositivi collegati → Collega con il numero di telefono),
fa scegliere il gruppo da un elenco, avvia il motore, registra il webhook e manda un messaggio di prova.
Si può rilanciare quando serve (nuovo numero, altro gruppo, aggiornamento): salta i passi già fatti.
Google Drive è facoltativo: se `deploy/segreti/rclone/rclone.conf` esiste (vedi il passo 4 qui sotto)
lo script attiva anche la sincronizzazione, altrimenti la cartella condivisa resta solo sul server.

I passi qui sotto descrivono la stessa installazione fatta a mano.

**1. Server.** Crea il VPS (Ubuntu 24.04), installa Docker (`curl -fsSL https://get.docker.com | sh`) e git.

**2. OpenWA** (dalla home del server):

```bash
git clone https://github.com/rmyndharis/OpenWA.git && cd OpenWA
cat > docker-compose.override.yml <<'YAML'
services:
  openwa-api:
    image: ghcr.io/rmyndharis/openwa:latest
YAML
cat >> .env <<'ENV'
ENGINE_TYPE=whatsapp-web.js
SSRF_ALLOWED_HOSTS=motore
TZ=Europe/Rome
ENV
docker compose pull openwa-api && docker compose up -d --no-build
docker exec openwa-api cat /app/data/.api-key      # → OPENWA_API_KEY
```

Dashboard dal tuo PC: `ssh -L 2785:127.0.0.1:2785 utente@server` e poi <http://localhost:2785>.
Crea la sessione, scansiona il QR con il numero dedicato e annota l'id (→ `OPENWA_SESSION`).
Se avevi già una sessione sul PC, la ricolleghi semplicemente con un nuovo QR sul server.

**3. Motore:**

```bash
cd ~ && git clone <url-del-repo> doublegram-linkedin-engine && cd doublegram-linkedin-engine
cp .env.example .env && nano .env     # chiavi, profilo, OPENWA_*, WHATSAPP_GROUP_ID, OPENWA_WEBHOOK_SECRET
mkdir -p deploy/dati/condivisa deploy/dati/motore deploy/segreti/rclone
sudo chown -R 1000:1000 deploy/dati deploy/segreti
```

`SHARED_DIR`, `OPENWA_URL`, `WEBHOOK_URL` e `PIANIFICAZIONE_INTERNA` nel `.env` vengono ignorati: in cloud li imposta
`deploy/docker-compose.yml`. Gli orari restano `ORARIO_*` con `TZ=Europe/Rome`.

**4. Google Drive (rclone).** Sul tuo PC Windows installa rclone (`winget install Rclone.Rclone`), lancia
`rclone config` → nuovo remoto chiamato `gdrive`, tipo *Google Drive*, accesso completo, autorizza dal browser.
Poi copia il file di configurazione sul server (contiene il token: è un segreto):

```powershell
scp "$env:APPDATA\rclone\rclone.conf" utente@server:~/doublegram-linkedin-engine/deploy/segreti/rclone/
```

Sul server: `sudo chown -R 1000:1000 deploy/segreti`. Se la cartella su Drive non si chiama
`Doublegram-LinkedIn` (nella radice di "Il mio Drive"), imposta `RCLONE_REMOTO=gdrive:percorso/della/cartella`
in un file `deploy/.env`. Nello stesso file aggiungi `COMPOSE_PROFILES=drive`: senza, il servizio rclone non parte.

**5. Avvio:**

```bash
cd deploy
docker compose up -d --build
docker compose exec motore node --import tsx src/webhook.ts     # registra il webhook (una volta)
docker compose logs -f motore                                    # log in diretta
```

Al primo avvio rclone copia la cartella di Drive sul server (e viceversa). Da lì in poi ogni modifica fatta su Drive
arriva al motore entro 2 minuti, e bozze, scarti ed errori arrivano su Drive.

Aggiornamenti: `git pull && cd deploy && docker compose up -d --build`. Per OpenWA vedi il suo README
(`docker compose pull openwa-api && docker compose up -d --no-build`).

> Sul PC, a quel punto, non serve più nulla: niente Utilità di pianificazione e niente OpenWA locale
> (se li avevi installati, disattivali con `scripts\installa-pianificazione.ps1 -Rimuovi` e `docker compose down`
> nella cartella di OpenWA, altrimenti i lavori girerebbero due volte).

---

## Uso quotidiano

1. **Raccogli i post** (a mano: il sistema non legge LinkedIn). In `01-da-adattare/` puoi mettere:
   - un file `.txt` o `.md` con il testo del post, con autore e link facoltativi in testa:

     ```
     autore: Justin Welsh
     link: https://www.linkedin.com/posts/...
     ---
     testo del post incollato qui…
     ```

   - oppure uno screenshot `.png`, `.jpg` o `.webp` del post (massimo 5 MB).

   - oppure, **dal gruppo WhatsApp** (con `npm run servizio` attivo, senza citare messaggi): uno screenshot con
     didascalia `adatta`, oppure `adatta: <testo del post>`, oppure `adatta <link a un articolo>`. Il motore lo salva in
     `01-da-adattare/` e risponde nel gruppo. I link a LinkedIn vengono rifiutati: per quelli serve lo screenshot.
     Con **`adatta subito`** (al posto di `adatta`) la bozza viene creata e mandata nel gruppo appena pronta;
     se il post viene scartato arriva il motivo. **`manda bozza`** invia ora la prossima bozza in coda.
     Gli invii chiesti così ignorano il limite di 3 messaggi al giorno e non lo consumano.

   In più, alle 07:00 `rss` aggiunge da solo gli articoli nuovi delle newsletter elencate in `fonti.txt`
   (un feed per riga, facoltativo un nome davanti: `Justin Welsh | https://….substack.com/feed`).
2. Alle 07:30 `adatta` crea le bozze in `02-bozze/`. Puoi anche lanciarlo a mano: `npm run adatta`.
3. Alle 08:30 arriva nel gruppo WhatsApp la bozza più vecchia non ancora inviata.
4. Leggi il messaggio di contesto: se ci sono **problemi di verifica** o **segnaposto** (`[DATO DA INSERIRE]`,
   `[AUTORE DA INSERIRE]`), correggili prima di pubblicare.
5. Copia la variante che preferisci e pubblicala a mano su LinkedIn.
6. Sposta la bozza in `03-approvati/` quando la scegli e in `04-pubblicati/` dopo la pubblicazione.
7. Ogni tanto controlla `_scartati/` e `_errori/`: accanto a ogni file c'è un `.motivo.txt`.
   Per rielaborare un file in errore, rimettilo in `01-da-adattare/`.

**Ritocchi dal telefono (con `npm run servizio` attivo).** Nel gruppo tieni premuto il messaggio della variante →
*Rispondi* → scrivi cosa cambiare:

| Scrivi | Effetto |
|---|---|
| `più corto` / `più lungo` | accorcia o allunga |
| `cambia hook` | nuovo inizio, stessa struttura |
| `cambia chiusura` | nuova domanda o CTA finale |
| `più diretto`, `meno formale`, `senza emoji` | cambia tono o forma |
| `rifai: <istruzione>` | qualsiasi altra richiesta, in parole tue |
| `aiuto` | elenco dei comandi |

Si può combinare ("più corto e senza emoji"). Rispondendo al messaggio della Variante B si modifica la B;
rispondendo al messaggio di contesto si modifica la A, a meno di scrivere "variante B".
Si può rispondere anche al testo nuovo per altri ritocchi. Il file della bozza viene aggiornato.

I log sono in `logs\AAAA-MM.log`; l'output delle attività pianificate anche in `logs\pianificazione.log`.

---

## Prototipo: i bot Doublegram su WhatsApp

Con `npm run servizio` attivo, nel gruppo configurato funzionano anche le versioni WhatsApp dei bot Doublegram
(`src/doublegram.ts`). Scrivi `/doublegram` nel gruppo per l'elenco:

| Comando | Cosa fa |
|---|---|
| `/ai <domanda>` | risponde Claude (citando un messaggio, lo usa come contesto) |
| `/post <di cosa parla>` | post per il canale Telegram nello stile di Doublegram News: card 1080×1080 (logo, etichetta, titolo, sottotitolo) + testo con **grassetti**. Se mancano fatti (data, novità, link) fa domande: si risponde citando. Citando card o testo con una modifica ("più corto", "cambia titolo in …") lo rifà. Salva in `05-post/` |
| vocali | Scribe li trascrive in automatico con Whisper "small" sul server (servizio `scribe`, ~800 MB di RAM) · `/scribe on` / `off` |
| `/lookup <numero>` o `/lookup @persona` | nome pubblico, foto, rubrica: utile per riconoscere i cloni |
| `/security on` / `off` / `stato`, `/vieta <parola>`, `/consenti <parola>` | rimuove link e parole vietate scritti da chi non è admin (il numero collegato deve essere admin). Spento di default |
| `/shop`, `/aggiungi <n>`, `/togli <n>`, `/carrello`, `/svuota`, `/ordina` | i piani veri di Doublegram, carrello e ordine con il link per attivarlo |
| `/schiavo <richiesta>` o `/jarvis …`, o un vocale che inizia con "Jarvis" | il maggiordomo (`src/schiavo.ts`, `CLAUDE_MODEL_SCHIAVO`, di default Opus 5.5): risponde da maggiordomo e usa strumenti veri, cioè ricerca web e lettura di link, lettura della chat ("cosa mi sono perso?"), foto, PDF e vocali citati, card, sondaggi, promemoria a orario, post per il canale e note da ricordare. Mentre lavora mette 🎩 sul messaggio e mostra "sta scrivendo…". Citando una sua risposta si continua la conversazione. **A voce:** se gli parli con un vocale (o gli chiedi "rispondimi a voce") risponde con un vocale (Piper nel servizio `scribe`, voce `PIPER_VOCE`, di default `it_IT-paola-medium`) |
| `/cliente <azienda>` | dossier prima di una chiamata: chi sono, community e canali Telegram, persone da contattare (solo ruoli pubblici), perché Doublegram, obiezioni, email pronta, fonti. Salvato in `06-clienti/` |
| `/briefing` | il briefing del mattino subito; in automatico arriva ogni giorno alle `BRIEFING_ORARIO` (8:45), scritto e a voce: ieri nel gruppo, oggi, numeri, notizie, consigli |
| numeri di Doublegram | il maggiordomo risponde a "quanti abbonati abbiamo?", "com'è andato settembre?", "perché perdiamo clienti?" con grafici e consigli, e anche su assistenza clienti e soddisfazione ("come va l'assistenza?": ticket, arretrato, tempi di risposta, CSAT, NPS, commenti). **I dati sono SIMULATI** (`src/dati-simulati.ts`, `DATI_DOUBLEGRAM=simulati`): coerenti nel tempo ma finti, e lui lo dice sempre. Per i dati veri basta sostituire quel modulo con le API di Doublegram |

Tutto resta nel gruppo: nessun messaggio privato. I prezzi vengono da doublegram.com/pricing; per cambiarli
metti un `catalogo-doublegram.json` nella cartella condivisa. Tetto giornaliero: `DOUBLEGRAM_MAX_GIORNO`.

## Sviluppo

```powershell
npm run typecheck   # tsc --noEmit
```

Struttura: `src/rss.ts`, `src/adatta.ts`, `src/invia.ts` e `src/servizio.ts` sono i comandi;
`src/pipeline.ts` contiene analisi, varianti, revisione e verifica; `src/prompts.ts` i prompt;
`src/schemi.ts` gli schemi zod degli output JSON; `src/claude.ts` la chiamata a Claude con output strutturato;
`src/openwa.ts` il client OpenWA; `src/comandi.ts` i comandi nel gruppo (Fase 4); `src/feed.ts` la lettura dei feed.
