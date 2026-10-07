# doublegram-linkedin-engine

Prende post LinkedIn in inglese che hanno performato bene, li **adatta** (non li traduce) in italiano
per il profilo sales di Doublegram e ogni mattina manda una bozza su un gruppo WhatsApp.
Un umano la legge, la copia e la pubblica a mano su LinkedIn.

Cosa il sistema **non** fa, per scelta:

- nessuna interazione automatica con LinkedIn: niente scraping, API, pubblicazione, like, commenti o connessioni;
- non inventa numeri, clienti, risultati o funzionalità: usa solo `linee-guida.md`, altrimenti scrive `[DATO DA INSERIRE]`;
- non scrive su WhatsApp a nessuno tranne il gruppo configurato, e mai più di 3 messaggi al giorno.

---

## Come funziona

```
Cartella condivisa (Google Drive)                    Progetto locale (questo repo)
─────────────────────────────────                    ─────────────────────────────
01-da-adattare/   ← metti qui i post inglesi         .env          segreti
   _elaborati/    ← i sorgenti già elaborati         .stato.json   cosa è già stato inviato
02-bozze/         → bozze generate (.md)             logs/         log mensili
03-approvati/     ← sposti qui quelle scelte         openwa-data/  (se usi una cartella per OpenWA)
04-pubblicati/    ← archivio dopo la pubblicazione
_scartati/        → post fuori target + motivo
_errori/          → file falliti + motivo
linee-guida.md    profilo, pubblico, tono, fatti verificati
```

**`npm run adatta`** – per ogni file nuovo in `01-da-adattare/`:

1. estrae il testo (per gli screenshot usa la visione di Claude);
2. **analisi**: formato, hook, struttura, CTA, perché funziona, se l'idea è originale dell'autore, e se il post è adatto al profilo;
   i post fuori target (storie da founder, vita privata, temi fuori tema) finiscono in `_scartati/` con il motivo;
3. **adattamento**: due varianti italiane con la stessa struttura e contenuto nuovo;
4. **verifica**: niente frasi tradotte, nessun dato fuori dalle linee guida, citazione dell'autore se serve,
   più controlli automatici su lunghezza, emoji e markdown. Se non passa, rigenera **una** volta e poi salva comunque,
   con i problemi in evidenza;
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

Il testo da pubblicare lo scrive il modello più capace (`CLAUDE_MODEL`, Sonnet 5.5); trascrizione,
analisi e verifica, che sono compiti semplici di lettura e controllo, li fa un modello economico
(`CLAUDE_MODEL_CONTROLLI`, Haiku 4.5). Il system prompt con le linee guida è in cache, quindi più file
elaborati nello stesso giro costano meno.

Stima indicativa (dipende dalla lunghezza di `linee-guida.md` e dei post): pochi centesimi di dollaro a post,
circa 1,5–3 $ al mese con un post al giorno. Se la verifica ti sembra troppo permissiva, metti
`CLAUDE_MODEL_CONTROLLI=claude-sonnet-5-5`: con `CLAUDE_EFFORT_CONTROLLI=low` costa di più di Haiku, ma meno del default.

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
| `CLAUDE_MODEL_CONTROLLI` | modello economico per trascrizione, analisi e verifica, default `claude-haiku-4-5` |
| `CLAUDE_EFFORT_CONTROLLI` | ragionamento per i controlli (`low`, `medium`, `high`), default `low`; ignorato da Haiku 4.5 |
| `CLAUDE_FALLBACK` | `default` (consigliato): se il modello rifiuta una richiesta, Anthropic la riprova su un modello alternativo (solo sui modelli che lo supportano, es. Sonnet 5.5). `off` per disattivarlo |
| `SHARED_DIR` | cartella condivisa, es. `G:\Il mio Drive\Doublegram-LinkedIn` |
| `PROFILO_NOME`, `PROFILO_RUOLO`, `PROFILO_PUBBLICO` | chi firma i post e per chi scrive (entrano nel prompt) |
| `MAX_CARATTERI` | lunghezza massima del post, default 1300 |
| `OPENWA_URL`, `OPENWA_API_KEY`, `OPENWA_SESSION` | vedi sotto |
| `WHATSAPP_GROUP_ID` | id del gruppo, formato `120363…@g.us` (vedi sotto) |
| `INVIA_VARIANTE_B` | `true` / `false` |

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

registra nell'Utilità di pianificazione (cartella *Doublegram-LinkedIn*) `adatta` alle 07:30 e `invia` alle 08:30,
tutti i giorni, con l'utente collegato (serve perché Google Drive sia montato). Se il PC era spento all'orario previsto,
partono appena possibile. Orari diversi: `-OraAdatta 07:00 -OraInvia 09:00`. Per rimuoverle: `-Rimuovi`.

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
2. Alle 07:30 `adatta` crea le bozze in `02-bozze/`. Puoi anche lanciarlo a mano: `npm run adatta`.
3. Alle 08:30 arriva nel gruppo WhatsApp la bozza più vecchia non ancora inviata.
4. Leggi il messaggio di contesto: se ci sono **problemi di verifica** o **segnaposto** (`[DATO DA INSERIRE]`,
   `[AUTORE DA INSERIRE]`), correggili prima di pubblicare.
5. Copia la variante che preferisci e pubblicala a mano su LinkedIn.
6. Sposta la bozza in `03-approvati/` quando la scegli e in `04-pubblicati/` dopo la pubblicazione.
7. Ogni tanto controlla `_scartati/` e `_errori/`: accanto a ogni file c'è un `.motivo.txt`.
   Per rielaborare un file in errore, rimettilo in `01-da-adattare/`.

I log sono in `logs\AAAA-MM.log`; l'output delle attività pianificate anche in `logs\pianificazione.log`.

---

## Sviluppo

```powershell
npm run typecheck   # tsc --noEmit
```

Struttura: `src/adatta.ts` e `src/invia.ts` sono i due comandi; `src/prompts.ts` contiene i prompt
(analisi, adattamento, verifica); `src/schemi.ts` gli schemi zod degli output JSON; `src/claude.ts` la chiamata
a Claude con output strutturato; `src/openwa.ts` il client OpenWA.

## Prossime fasi

- **Fase 3**: lettura dei feed RSS delle newsletter elencate in `fonti.txt`, che salva i post nuovi in `01-da-adattare/`.
- **Fase 4**: webhook di OpenWA: risposte nel gruppo come "più corto" o "cambia hook" rigenerano la bozza.
