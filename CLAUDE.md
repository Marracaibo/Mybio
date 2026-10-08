# doublegram-linkedin-engine — guida per Claude

Motore di Doublegram su WhatsApp. Gira su un VPS (Ubuntu, Docker) collegato a WhatsApp tramite OpenWA, e lavora
solo nel gruppo WhatsApp "Doublegram" del team. Tutto in italiano: codice, commenti, log, messaggi, commit.

## Cosa fa
1. **Bozze LinkedIn**: adatta in italiano post e newsletter in inglese (RSS, screenshot, testo o link mandati nel
   gruppo con "adatta") e manda le bozze nel gruppo per Roberto Rainoni (Sales Manager di Doublegram). Al massimo 3
   bozze al giorno; "adatta subito" e "manda bozza" scavalcano il limite. Pipeline: `rss.ts` → `adatta.ts`
   (`pipeline.ts`, `prompts.ts`, `schemi.ts`) → `invia.ts`; i comandi del gruppo sono in `comandi.ts`.
2. **Bot Doublegram adattati a WhatsApp** (`doublegram.ts`): /ai, /post (post per il canale Telegram con card,
   `post.ts` + `grafica.ts`), Scribe (vocali trascritti con Whisper sul server), /lookup, /security, /shop.
3. **Jarvis, il maggiordomo** (`schiavo.ts`, comandi /schiavo e /jarvis, o un vocale che inizia con "Jarvis"):
   agente Claude con strumenti. Fa ricerca web, legge la chat e la memoria cifrata (`memoria.ts`), lavora sui dati
   SIMULATI di vendite e assistenza (`dati-simulati.ts`) e su Linear SIMULATO (`linear-simulato.ts`). Fa grafici
   (`grafico.ts`), file veri PowerPoint/Excel/Word/PDF con le Agent Skills (`file-claude.ts`), ricerca approfondita
   con rapporto PDF (`ricerca.ts`), approvazioni con 👍 (`approvazioni.ts`), quiz con le reazioni (`quiz.ts`),
   sticker (`sticker.ts`), briefing del mattino e monitoraggio proattivo.
   - Mentre lavora si vede l'avanzamento (`progresso.ts`, messaggio che si modifica).
   - Risponde a voce con Piper (`deploy/scribe/server.py`, POST /parla).

`servizio.ts` è il processo sempre acceso. Riceve il webhook di OpenWA (message.received, message.sent,
message.reaction), mette in coda i lavori e gestisce gli orari di pianificazione, promemoria, briefing e monitoraggio.

## Regole da rispettare sempre
- **Il numero WhatsApp collegato è quello PERSONALE del titolare.** I bot agiscono solo nel gruppo configurato
  (`WHATSAPP_GROUP_ID`). Mai messaggi privati a terzi, mai invii di massa, mai pubblicare negli stati, mai rispondere
  alle chiamate. Con il numero personale i propri messaggi arrivano come `message.sent`: le eco del motore vanno
  ignorate (`inviatoDaQui`, `idInviatoDaQui`) e le citazioni si leggono dallo storico (`citazioneDaStorico`).
- **Segreti**: mai chiederli né mostrarli in chat e mai metterli nel repo (che può essere pubblico). Vivono nel
  `.env` sul server e si impostano con comandi come `read -s`. Le chiavi Anthropic iniziano con `sk-ant-`.
- **LinkedIn**: non si legge in automatico (vieta lo scraping e servirebbe il login). Le fonti LinkedIn arrivano
  solo come screenshot o testo incollato.
- **Dati simulati**: vendite, assistenza e Linear sono finti ma coerenti, e Jarvis deve sempre dirlo. Per i dati veri
  si sostituisce solo il modulo (`dati-simulati.ts`, `linear-simulato.ts`).
- **Fatti su Doublegram**: solo quelli in `modello-cartella-condivisa/linee-guida.md` e quelli già nei prompt
  (bot Security, Scribe, Doublegram AI, Lookup; Free e Premium a 9,99 $/mese; doublegram.com). Niente fatti inventati.
- Nei commit non scrivere identificativi di modelli.

## Note tecniche
- Node 22 + TypeScript eseguito con tsx; `npm run typecheck` (= `tsc --noEmit`) deve passare prima di ogni commit.
- **SDK Anthropic**:
  - output JSON con `client.beta.messages.parse` + `betaZodOutputFormat` (`claude.ts`, `chiediJson`);
  - Jarvis usa `client.beta.messages.stream`;
  - i modelli sono in `config.ts`: `CLAUDE_MODEL` (scrittura), `CLAUDE_MODEL_CONTROLLI`, `CLAUDE_MODEL_VERIFICA`,
    `CLAUDE_MODEL_SCHIAVO`, `CLAUDE_MODEL_FILE`.
- **Strumenti di Jarvis**:
  - niente `strict`: con più di 20 strumenti l'API rifiuta la richiesta (grammatica troppo grande);
  - ricerca web con le versioni classiche `web_search_20250305` / `web_fetch_20250910`: con quelle a filtro
    dinamico Jarvis ripeteva la ricerca senza ottenere risultati.
- **File con le skill**: `code_execution_20260521` + `container.skills` + beta `code-execution-2025-08-25`; si
  scaricano con `client.files`. I testi lunghi vanno caricati come `container_upload`, non incollati nel prompt.
- **OpenWA** (rmyndharis/OpenWA, motore whatsapp-web.js):
  - i voti dei sondaggi e i pulsanti interattivi non arrivano al motore, le reazioni sì (per questo il quiz usa
    👍 ❤️ 😂 😮);
  - gli sticker si mandano come PNG (li converte OpenWA);
  - i messaggi si modificano con POST /messages/edit.
- **Grafica**: SVG reso in PNG con `@resvg/resvg-js` e Montserrat (`assets/post/`). Niente emoji nel testo: resvg
  non ha font a colori.
- **Deploy** (`deploy/`, guida nel README):
  - OpenWA in /opt/openwa; motore e scribe con `cd ~/motore/deploy && sudo docker compose up -d --build`;
  - il webhook si registra da solo all'avvio del servizio;
  - installazione da zero con `deploy/installa.sh`.
- **Prove locali**: finto OpenWA (server HTTP che registra i messaggi) + POST firmati HMAC
  (`X-OpenWA-Signature: sha256=…`) su `/webhook/openwa`. Vedi gli esempi nella cronologia del progetto.

## Stato (ottobre 2026)
- In produzione e provati dal titolare: bozze LinkedIn, "adatta" con screenshot, Scribe, /ai, /post.
- Provati con Claude vero su gruppo simulato, da provare sul server: voce, briefing, /cliente, dati simulati,
  avanzamento in diretta, approvazioni, file PowerPoint, memoria, monitoraggio, quiz, sticker, ricerca web.
- Da riprovare: il PDF della ricerca approfondita. La correzione con `container_upload` non è ancora stata
  verificata perché il credito API era finito.
- Idee non ancora fatte:
  - pubblicazione vera sul canale Telegram (serve un bot admin del canale);
  - Linear vero (serve una chiave API);
  - dati veri di Doublegram;
  - un numero WhatsApp dedicato, che servirebbe anche per stati, benvenuto e filtro dei nuovi membri.
