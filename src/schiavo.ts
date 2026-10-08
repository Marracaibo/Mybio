import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { creaClient } from "./claude.js";
import { DATI_DIR, type Config } from "./config.js";
import { riepilogo, riepilogoAssistenza, AVVISO_SIMULATI } from "./dati-simulati.js";
import { creaCard } from "./grafica.js";
import { creaGrafico, type DatiGrafico } from "./grafico.js";
import { descriviErrore, type Logger } from "./log.js";
import { inviaImmagine, inviaTesto, inviaVocale, richiesta, scaricaMediaConTipo, type ConfigOpenWA } from "./openwa.js";
import { lavoraPost } from "./post.js";
import { leggiLineeGuida } from "./pipeline.js";
import { inizioTesto, oggi, slug } from "./testo.js";

/**
 * /schiavo (o /jarvis, o un vocale che inizia con "Jarvis…"): il maggiordomo del gruppo.
 * È un agente Claude con strumenti veri: legge la chat, cerca sul web e apre i link, guarda immagini e PDF
 * citati, ascolta i vocali citati, manda card, sondaggi e promemoria, prepara post per il canale e si
 * ricorda le cose che gli si chiede di ricordare. Agisce solo nel gruppo configurato: niente messaggi privati.
 * Citando una sua risposta si continua la conversazione. Se gli si parla con un vocale risponde con un vocale
 * (Piper, VOCE_URL). Modalità speciali: "cliente" (/cliente: dossier su un'azienda prima di una chiamata) e
 * "briefing" (ogni mattina alle BRIEFING_ORARIO, o con /briefing). I dati di Doublegram sono SIMULATI.
 */

export type Modo = "normale" | "cliente" | "briefing";

const MAX_GIRI = 10;

interface Scambio {
  domanda: string;
  risposta: string;
}

interface Promemoria {
  quando: string;
  testo: string;
  chi: string;
}

interface StatoSchiavo {
  /** trascrizioni dei vocali del gruppo (chiave: parte centrale dell'id), per leggi_chat */
  trascrizioni?: Record<string, string>;
  /** data (YYYY-MM-DD) dell'ultimo briefing automatico */
  ultimoBriefing?: string;
  note: string[];
  promemoria: Promemoria[];
  /** chiave: id del messaggio di risposta o "inizio:<testo>" → la conversazione fin lì */
  conversazioni: Record<string, { scambi: Scambio[]; data: string }>;
}

const FILE_STATO = path.join(DATI_DIR, ".schiavo.json");

function caricaStato(): StatoSchiavo {
  try {
    const d = JSON.parse(fs.readFileSync(FILE_STATO, "utf8")) as Partial<StatoSchiavo>;
    return { ultimoBriefing: d.ultimoBriefing, trascrizioni: d.trascrizioni ?? {}, note: d.note ?? [], promemoria: d.promemoria ?? [], conversazioni: d.conversazioni ?? {} };
  } catch {
    return { note: [], promemoria: [], conversazioni: {} };
  }
}

function salvaStato(s: StatoSchiavo): void {
  const conversazioni = Object.entries(s.conversazioni)
    .sort((a, b) => a[1].data.localeCompare(b[1].data))
    .slice(-100);
  fs.mkdirSync(DATI_DIR, { recursive: true });
  fs.writeFileSync(
    FILE_STATO,
    JSON.stringify({ ...s, conversazioni: Object.fromEntries(conversazioni) }, null, 2) + "\n",
    "utf8",
  );
}

const chiaveId = (id: string) => {
  const parti = id.split("_");
  return parti.length >= 3 ? (parti[2] ?? id) : id;
};

/** Salva la trascrizione di un vocale, così il maggiordomo sa cosa dice quando legge la chat. */
export function ricordaTrascrizione(id: string, testo: string): void {
  const stato = caricaStato();
  const voci = Object.entries({ ...stato.trascrizioni, [chiaveId(id)]: testo.slice(0, 2000) }).slice(-300);
  stato.trascrizioni = Object.fromEntries(voci);
  salvaStato(stato);
}

/** La conversazione a cui appartiene una risposta del maggiordomo citata, se c'è. */
export function conversazioneCitata(citato: { id?: string; body?: string } | undefined): Scambio[] | undefined {
  if (!citato) return undefined;
  const { conversazioni } = caricaStato();
  if (citato.id) {
    const k = chiaveId(citato.id);
    const trovata = Object.entries(conversazioni).find(([id]) => !id.startsWith("inizio:") && chiaveId(id) === k);
    if (trovata) return trovata[1].scambi;
  }
  if (citato.body && citato.body.length >= 20) {
    const inizio = inizioTesto(citato.body);
    const trovata = Object.entries(conversazioni).find(([id]) => id === `inizio:${inizio}`);
    if (trovata) return trovata[1].scambi;
  }
  return undefined;
}

// ---------- Strumenti ----------

const strumento = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
): Anthropic.Beta.BetaToolUnion => ({
  name,
  description,
  strict: true,
  input_schema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
});

const STRUMENTI_BASE: Anthropic.Beta.BetaToolUnion[] = [
  strumento(
    "leggi_chat",
    "Legge gli ultimi messaggi del gruppo WhatsApp (autore, ora, testo). Per riassunti, 'cosa mi sono perso', decisioni prese, chi ha detto cosa.",
    { quanti: { type: "integer", description: "Quanti messaggi, da 10 a 100" } },
  ),
  strumento(
    "invia_card",
    "Manda nel gruppo un'immagine 1:1 nello stile di Doublegram News (sfondo blu-viola, logo, etichetta, titolo grande).",
    {
      etichetta: { type: "string", description: "1-3 parole in maiuscolo, es. NOW LIVE" },
      titolo: { type: "string", description: "Al massimo 22 caratteri" },
      sottotitolo: { type: "string", description: "Al massimo 45 caratteri, oppure stringa vuota" },
    },
  ),
  strumento("invia_sondaggio", "Manda nel gruppo un sondaggio WhatsApp.", {
    domanda: { type: "string" },
    opzioni: { type: "array", items: { type: "string" }, description: "Da 2 a 12 opzioni brevi" },
    scelta_multipla: { type: "boolean" },
  }),
  strumento(
    "programma_promemoria",
    "Programma un messaggio che il maggiordomo scriverà nel gruppo all'ora indicata (promemoria, scadenze, auguri).",
    {
      quando: { type: "string", description: "Data e ora ISO 8601 con fuso orario, es. 2026-10-09T09:00:00+02:00" },
      testo: { type: "string", description: "Il messaggio da mandare, già scritto nello stile del maggiordomo" },
    },
  ),
  strumento("elenca_promemoria", "Elenca i promemoria programmati.", {}),
  strumento("annulla_promemoria", "Annulla un promemoria programmato.", {
    numero: { type: "integer", description: "Il numero come in elenca_promemoria (da 1)" },
  }),
  strumento(
    "ricorda",
    "Salva un'informazione da ricordare per sempre (preferenze del team, fatti su Doublegram, decisioni). Usalo quando ti chiedono di ricordare qualcosa.",
    { nota: { type: "string" } },
  ),
  strumento("dimentica", "Cancella una nota salvata.", {
    numero: { type: "integer", description: "Il numero della nota (da 1), come nell'elenco delle note" },
  }),
  strumento(
    "crea_post_canale",
    "Avvia la preparazione di un post per il canale Telegram Doublegram News con card (lo fa il bot /post, che manda direttamente card e testo nel gruppo o fa domande).",
    { richiesta: { type: "string", description: "Di cosa parla il post, con tutti i fatti noti" } },
  ),
  strumento(
    "invia_grafico",
    "Manda nel gruppo un grafico (linee o barre) nello stile di Doublegram. Fino a 4 serie con gli stessi punti delle etichette.",
    {
      titolo: { type: "string", description: "Al massimo 40 caratteri" },
      sottotitolo: { type: "string", description: "Periodo e fonte, es. 'Ultimi 30 giorni · dati simulati'" },
      tipo: { type: "string", enum: ["linee", "barre"] },
      etichette: { type: "array", items: { type: "string" }, description: "Etichette dell'asse X, es. date 'MM-GG'" },
      serie: {
        type: "array",
        items: {
          type: "object",
          properties: { nome: { type: "string" }, valori: { type: "array", items: { type: "number" } } },
          required: ["nome", "valori"],
          additionalProperties: false,
        },
      },
    },
  ),
];

const STRUMENTO_DATI = strumento(
  "dati_doublegram",
  `Numeri di Doublegram per un periodo: utenti, attivi, gruppi, abbonati Premium, nuovi e disdette, MRR, ricavi, costi, margine, churn, conversione, paesi, uso dei prodotti, canali e motivi di disdetta, più la serie giorno per giorno (o settimanale sopra i 45 giorni). ATTENZIONE: ${AVVISO_SIMULATI}.`,
  {
    da: { type: "string", description: "Data iniziale YYYY-MM-DD" },
    a: { type: "string", description: "Data finale YYYY-MM-DD (al massimo oggi)" },
  },
);

const STRUMENTO_ASSISTENZA = strumento(
  "assistenza_doublegram",
  `Assistenza clienti e soddisfazione degli utenti di Doublegram in un periodo: ticket aperti e chiusi, arretrato, tempi di prima risposta e di risoluzione, CSAT, NPS, recensioni, argomenti dei ticket, segnali emergenti, commenti degli utenti, capacità del team e serie giorno per giorno. ATTENZIONE: ${AVVISO_SIMULATI}.`,
  {
    da: { type: "string", description: "Data iniziale YYYY-MM-DD" },
    a: { type: "string", description: "Data finale YYYY-MM-DD (al massimo oggi)" },
  },
);

function strumenti(config: Config, modo: Modo): Anthropic.Beta.BetaToolUnion[] {
  const ricerche = modo === "cliente" ? 10 : modo === "briefing" ? 3 : 5;
  return [
    { type: "web_search_20260209", name: "web_search", max_uses: ricerche },
    { type: "web_fetch_20260209", name: "web_fetch", max_uses: ricerche },
    ...STRUMENTI_BASE,
    ...(config.DATI_DOUBLEGRAM === "simulati" ? [STRUMENTO_DATI, STRUMENTO_ASSISTENZA] : []),
  ];
}

interface Contesto {
  config: Config;
  log: Logger;
  openwa: ConfigOpenWA;
  chi: string;
}

async function leggiChat(openwa: ConfigOpenWA, quanti: number): Promise<string> {
  const n = Math.max(10, Math.min(100, Math.trunc(quanti) || 40));
  const { trascrizioni = {} } = caricaStato();
  const storico = (await richiesta(openwa, "GET", `/messages/${encodeURIComponent(openwa.gruppo)}/history?limit=${n}`)) as Array<{
    id?: string;
    body?: string;
    type?: string;
    fromMe?: boolean;
    author?: string;
    timestamp?: number;
    contact?: { pushName?: string; name?: string };
  }> | null;
  if (!Array.isArray(storico) || !storico.length) return "Nessun messaggio letto.";
  return storico
    .map((m) => {
      const ora = m.timestamp
        ? new Date(m.timestamp * 1000).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
        : "";
      const autore = m.fromMe ? "Padrone (numero collegato) o bot" : (m.contact?.name ?? m.contact?.pushName ?? m.author ?? "?");
      const trascritto = m.id ? trascrizioni[chiaveId(m.id)] : undefined;
      const testo = trascritto ? `[vocale] ${trascritto}` : m.body?.trim() || `[${m.type ?? "messaggio"}]`;
      return `[${ora}] ${autore}: ${testo.slice(0, 600)}`;
    })
    .join("\n");
}

async function eseguiStrumento(ctx: Contesto, nome: string, input: Record<string, unknown>): Promise<string> {
  const { config, openwa, log } = ctx;
  const stato = caricaStato();
  switch (nome) {
    case "leggi_chat":
      return leggiChat(openwa, Number(input["quanti"]));
    case "invia_card": {
      const png = creaCard(
        {
          etichetta: String(input["etichetta"] ?? ""),
          titolo: String(input["titolo"] ?? ""),
          sottotitolo: String(input["sottotitolo"] ?? "") || undefined,
        },
        config.SHARED_DIR,
      );
      await inviaImmagine(openwa, png);
      return "Card inviata nel gruppo.";
    }
    case "invia_sondaggio": {
      const opzioni = (Array.isArray(input["opzioni"]) ? input["opzioni"] : []).map(String).slice(0, 12);
      if (opzioni.length < 2) return "Servono almeno 2 opzioni.";
      await richiesta(openwa, "POST", "/messages/send-poll", {
        chatId: openwa.gruppo,
        name: String(input["domanda"] ?? "").slice(0, 255),
        options: opzioni.map((o) => o.slice(0, 100)),
        allowMultipleAnswers: Boolean(input["scelta_multipla"]),
      });
      return "Sondaggio inviato nel gruppo.";
    }
    case "programma_promemoria": {
      const quando = new Date(String(input["quando"] ?? ""));
      if (Number.isNaN(quando.getTime())) return "Data non valida: usa il formato ISO 8601 con fuso orario.";
      if (quando.getTime() < Date.now() - 60_000) return "Quella data è già passata.";
      if (stato.promemoria.length >= 50) return "Ci sono già 50 promemoria: annullane qualcuno.";
      stato.promemoria.push({ quando: quando.toISOString(), testo: String(input["testo"] ?? ""), chi: ctx.chi });
      stato.promemoria.sort((a, b) => a.quando.localeCompare(b.quando));
      salvaStato(stato);
      return `Promemoria programmato per ${quando.toLocaleString("it-IT", { timeZone: process.env["TZ"] || "Europe/Rome" })}.`;
    }
    case "elenca_promemoria":
      return stato.promemoria.length
        ? stato.promemoria
            .map((p, i) => `${i + 1}. ${new Date(p.quando).toLocaleString("it-IT")} – ${p.testo.slice(0, 120)}`)
            .join("\n")
        : "Nessun promemoria programmato.";
    case "annulla_promemoria": {
      const i = Number(input["numero"]) - 1;
      if (!stato.promemoria[i]) return "Non c'è un promemoria con quel numero.";
      const [tolto] = stato.promemoria.splice(i, 1);
      salvaStato(stato);
      return `Annullato: ${tolto?.testo.slice(0, 120)}`;
    }
    case "ricorda": {
      const nota = String(input["nota"] ?? "").trim();
      if (!nota) return "Nota vuota.";
      stato.note = [...stato.note, nota.slice(0, 500)].slice(-60);
      salvaStato(stato);
      return "Nota salvata.";
    }
    case "dimentica": {
      const i = Number(input["numero"]) - 1;
      if (!stato.note[i]) return "Non c'è una nota con quel numero.";
      const [tolta] = stato.note.splice(i, 1);
      salvaStato(stato);
      return `Dimenticato: ${tolta}`;
    }
    case "dati_doublegram":
      return JSON.stringify(riepilogo(String(input["da"] ?? ""), String(input["a"] ?? "")));
    case "assistenza_doublegram":
      return JSON.stringify(riepilogoAssistenza(String(input["da"] ?? ""), String(input["a"] ?? "")));
    case "invia_grafico": {
      const png = creaGrafico({
        titolo: String(input["titolo"] ?? ""),
        sottotitolo: String(input["sottotitolo"] ?? "") || undefined,
        tipo: input["tipo"] === "barre" ? "barre" : "linee",
        etichette: (Array.isArray(input["etichette"]) ? input["etichette"] : []).map(String),
        serie: (Array.isArray(input["serie"]) ? input["serie"] : []) as DatiGrafico["serie"],
      });
      await inviaImmagine(openwa, png);
      return "Grafico inviato nel gruppo.";
    }
    case "crea_post_canale":
      // Il bot /post manda da sé domande o card + testo: lo faccio partire dopo la risposta del maggiordomo.
      setImmediate(() => {
        lavoraPost({ config, log, openwa }, String(input["richiesta"] ?? "")).catch((e) =>
          log.errore(`Schiavo → post: ${descriviErrore(e)}`),
        );
      });
      return "Preparazione del post avviata: card e testo (o le domande) arriveranno tra un minuto.";
    default:
      return `Strumento sconosciuto: ${nome}`;
  }
}

// ---------- Allegati citati ----------

function tipoDaFirma(dati: Buffer, dichiarato: string): string {
  if (dati.subarray(0, 4).toString("hex") === "89504e47") return "image/png";
  if (dati.subarray(0, 3).toString("hex") === "ffd8ff") return "image/jpeg";
  if (dati.subarray(0, 4).toString("ascii") === "RIFF" && dati.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (dati.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (dati.subarray(0, 4).toString("ascii") === "%PDF") return "application/pdf";
  return dichiarato;
}

export interface Allegato {
  dati: Buffer;
  mimetype: string;
}

/** Scarica l'allegato di un messaggio (citato o lo stesso del comando) e ne riconosce il tipo. */
export async function scaricaAllegato(openwa: ConfigOpenWA, chat: string, messageId: string): Promise<Allegato | undefined> {
  try {
    const { dati, mimetype } = await scaricaMediaConTipo(openwa, chat, messageId);
    if (!dati.length) return undefined;
    return { dati, mimetype: tipoDaFirma(dati, mimetype) };
  } catch {
    return undefined; // il messaggio citato non ha allegati
  }
}

// ---------- Il maggiordomo ----------

const ISTRUZIONI_MODO: Record<Modo, string> = {
  normale: "",
  cliente: `
MODALITÀ RICERCA CLIENTE: prepari un dossier su un'azienda (o un progetto) prima di un contatto commerciale di Roberto,
il Sales Manager. Metodo: 1) sito ufficiale, cosa fanno, dimensioni, mercato e notizie degli ultimi 6 mesi;
2) presenza su Telegram (canali e gruppi t.me, iscritti se pubblici), Discord e altre community; 3) persone da contattare,
solo con ruolo professionale e da fonti pubbliche (sito, LinkedIn, stampa), MAI dati personali privati come numeri
personali, indirizzi di casa o familiari; 4) collega i loro problemi ai prodotti veri di Doublegram.
Formato: *Chi sono* · *Community e canali* · *Persone da contattare* · *Perché Doublegram* (3 argomenti concreti) ·
*Obiezioni probabili* (con la risposta) · *Primo messaggio* (email breve, pronta da mandare) · *Fonti* (link).
Fino a 2500 caratteri. Se qualcosa non si trova, scrivilo invece di supporlo.`,
  briefing: `
MODALITÀ BRIEFING DEL MATTINO: lo scrivi di tua iniziativa per tutto il team. Usa leggi_chat (100 messaggi) per quello
che si è detto da ieri mattina, elenca_promemoria per gli impegni, dati_doublegram per ieri e per gli ultimi 7 giorni
confrontati con i 7 precedenti, e al massimo 2 ricerche web su novità di ieri e di oggi su Telegram, community online e
bot concorrenti (Combot, Rose, Group Help, Shieldy).
Formato: saluto da maggiordomo con la data · *Ieri nel gruppo* (decisioni e compiti, con i nomi) · *Oggi* (impegni) ·
*I numeri* (3-4 righe con vendite e assistenza, dicendo che sono simulati) · *Dal mondo* (1-3 notizie con la fonte) · *Il mio consiglio*
(1-2 priorità). Al massimo 1500 caratteri. Manda un grafico solo se un andamento è davvero notevole.
Non programmare promemoria e non mandare sondaggi di tua iniziativa: proponili, e li farai se te lo chiedono.
In fondo metti una riga che contiene solo "VOCE:" e sotto una versione parlata di circa 40 secondi (al massimo
600 caratteri), senza elenchi, link, emoji né asterischi, con parole italiane (la voce legge male l'inglese:
"riepilogo" invece di "briefing", "incasso mensile" invece di "MRR").`,
};

const ISTRUZIONI_VOCE = `
RISPOSTA A VOCE: ti hanno parlato con un vocale e risponderai con un vocale. Scrivi come parleresti: frasi brevi,
niente elenchi, emoji, link, asterischi o sigle; parole italiane quando possibile (la voce legge male l'inglese:
"incasso mensile" invece di "MRR", "tasso di disdetta" invece di "churn"); al massimo 700 caratteri. Se servono link o
numeri da leggere con calma, aggiungili in fondo dopo una riga che contiene solo "SCRITTO:".`;

function sistema(config: Config, note: string[], modo: Modo = "normale", aVoce = false): string {
  return `Sei Jarvis, il maggiordomo personale del team di Doublegram, dentro il loro gruppo WhatsApp.
Ti rivolgi a chi ti scrive con deferenza da maggiordomo inglese d'altri tempi ("Signore", "Mi permetta", "Come desidera"),
con eleganza e un filo di ironia asciutta, mai servile in modo stucchevole. Ma sei straordinariamente capace:
risolvi davvero il problema, con precisione, e quando serve usi gli strumenti senza chiedere il permesso.

Cosa sai fare (usa gli strumenti, non limitarti a descrivere):
- cercare sul web informazioni aggiornate (web_search) e leggere pagine e link (web_fetch), citando le fonti;
- leggere la chat del gruppo per riassunti e "cosa mi sono perso" (leggi_chat);
- rispondere sui numeri di Doublegram (dati_doublegram) e sull'assistenza clienti e la soddisfazione (assistenza_doublegram);
- guardare immagini e PDF e ascoltare vocali che ti vengono citati (arrivano già nel messaggio);
- mandare card grafiche nello stile Doublegram News (invia_card), sondaggi (invia_sondaggio), promemoria a orario (programma_promemoria);
- preparare post per il canale Telegram (crea_post_canale) e ricordare informazioni nel tempo (ricorda / dimentica).

Doublegram: suite di bot per community Telegram (Security, Scribe, Doublegram AI, Lookup), piano Free e Premium a 9,99 $/mese, doublegram.com.
Linee guida del team (fatti verificati):
${leggiLineeGuida(config.SHARED_DIR).trim().slice(0, 4000)}

Regole:
- Rispondi in italiano (o nella lingua in cui ti scrivono). Testo adatto a WhatsApp: niente titoli markdown né tabelle;
  *grassetto* con un asterisco, elenchi con trattini. Di norma al massimo 1500 caratteri: sii denso, non prolisso.
- Non inventare fatti, numeri o fonti: se non lo sai e non puoi verificarlo, dillo con garbo.
- Agisci solo nel gruppo: non puoi scrivere in privato a nessuno e non devi provarci.
- Se hai usato uno strumento che manda qualcosa nel gruppo, nella risposta dillo in una riga, senza ripetere il contenuto.
- I dati di Doublegram (dati_doublegram, assistenza_doublegram) sono SIMULATI: quando li usi dillo sempre ("dati
  simulati"). Con i numeri ragiona da CFO e da responsabile dell'assistenza: confronta i periodi, collega le cause
  (es. ticket, tempi di risposta, soddisfazione e disdette), proponi azioni concrete e misurabili.

Note salvate (cose che il team ti ha chiesto di ricordare):
${note.length ? note.map((n, i) => `${i + 1}. ${n}`).join("\n") : "(nessuna)"}
${ISTRUZIONI_MODO[modo]}${aVoce ? ISTRUZIONI_VOCE : ""}`;
}

/**
 * Esegue una richiesta al maggiordomo e restituisce la risposta da scrivere nel gruppo.
 * `precedenti`: la conversazione fin qui (quando si cita una sua risposta).
 */
export async function chiediSchiavo(
  ctx: Contesto,
  richiestaUtente: string,
  opzioni: { precedenti?: Scambio[]; allegato?: Allegato; trascrizione?: string; citato?: string; modo?: Modo; aVoce?: boolean },
): Promise<{ risposta: string; scambi: Scambio[] }> {
  const { config, log } = ctx;
  const client = creaClient(config);
  const stato = caricaStato();
  const modello = config.CLAUDE_MODEL_SCHIAVO;

  const messaggi: Anthropic.Beta.BetaMessageParam[] = [];
  for (const s of opzioni.precedenti ?? []) {
    messaggi.push({ role: "user", content: s.domanda }, { role: "assistant", content: s.risposta });
  }
  const contenuto: Anthropic.Beta.BetaContentBlockParam[] = [];
  const a = opzioni.allegato;
  if (a && /^image\/(png|jpeg|webp|gif)$/.test(a.mimetype) && a.dati.length <= 5 * 1024 * 1024) {
    contenuto.push({
      type: "image",
      source: { type: "base64", media_type: a.mimetype as "image/png", data: a.dati.toString("base64") },
    });
  } else if (a && a.mimetype === "application/pdf" && a.dati.length <= 20 * 1024 * 1024) {
    contenuto.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: a.dati.toString("base64") } });
  }
  const adesso = new Date().toLocaleString("it-IT", {
    timeZone: process.env["TZ"] || "Europe/Rome",
    dateStyle: "full",
    timeStyle: "short",
  });
  const righe = [`(Adesso: ${adesso}, fuso ${process.env["TZ"] || "Europe/Rome"}. Ti scrive: ${ctx.chi}.)`];
  if (opzioni.citato) righe.push(`Messaggio citato:\n${opzioni.citato.slice(0, 4000)}`);
  if (opzioni.trascrizione) righe.push(`Trascrizione del vocale citato:\n${opzioni.trascrizione}`);
  righe.push(`Richiesta: ${richiestaUtente || "(nessun testo: occupati del contenuto citato)"}`);
  contenuto.push({ type: "text", text: righe.join("\n\n") });
  messaggi.push({ role: "user", content: contenuto });

  const fallback = /^claude-(fable-5|mythos-5|opus-5|sonnet-5-5)/.test(modello) && config.CLAUDE_FALLBACK === "default";
  let risposta: Anthropic.Beta.BetaMessage | undefined;
  for (let giro = 0; giro < MAX_GIRI; giro++) {
    risposta = await client.beta.messages.create({
      model: modello,
      max_tokens: 16000,
      system: [
        { type: "text", text: sistema(config, stato.note, opzioni.modo, opzioni.aVoce), cache_control: { type: "ephemeral" } },
      ],
      tools: strumenti(config, opzioni.modo ?? "normale"),
      messages: messaggi,
      output_config: { effort: "medium" },
      ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });
    for (const blocco of risposta.content) {
      if ((blocco.type === "web_search_tool_result" || blocco.type === "web_fetch_tool_result") && !Array.isArray(blocco.content)) {
        const errore = (blocco.content as { error_code?: string }).error_code;
        if (errore) log.avviso(`Schiavo: ${blocco.type} errore ${errore}`);
      }
    }
    if (risposta.stop_reason === "pause_turn") {
      messaggi.push({ role: "assistant", content: risposta.content });
      continue;
    }
    if (risposta.stop_reason !== "tool_use") break;
    messaggi.push({ role: "assistant", content: risposta.content });
    const risultati: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const blocco of risposta.content) {
      if (blocco.type !== "tool_use") continue;
      let esito: string;
      let errore = false;
      try {
        esito = await eseguiStrumento(ctx, blocco.name, (blocco.input ?? {}) as Record<string, unknown>);
        log.info(`Schiavo: ${blocco.name}`);
      } catch (e) {
        esito = `Errore: ${descriviErrore(e)}`;
        errore = true;
        log.avviso(`Schiavo: ${blocco.name} non riuscito: ${descriviErrore(e)}`);
      }
      risultati.push({ type: "tool_result", tool_use_id: blocco.id, content: esito, is_error: errore });
    }
    messaggi.push({ role: "user", content: risultati });
  }

  let testo = "";
  if (risposta?.stop_reason === "refusal") {
    testo = "Mi rincresce, Signore, ma questa è una richiesta che non posso esaudire.";
  } else {
    testo = (risposta?.content ?? [])
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  }
  testo = testo.replace(/^\s*(🎩\s*)+/u, ""); // il cappello lo aggiunge rispondiSchiavo
  if (!testo) testo = "Fatto, Signore.";
  const scambi = [...(opzioni.precedenti ?? []), { domanda: righe.slice(1).join("\n\n"), risposta: testo }].slice(-8);
  return { risposta: testo, scambi };
}

/** Divide la risposta nella parte principale e in quella dopo una riga "VOCE:" o "SCRITTO:". */
function dividi(testo: string, segno: "VOCE" | "SCRITTO"): [string, string] {
  const m = new RegExp(`^\\s*\\**${segno}:?\\**\\s*$`, "im").exec(testo);
  if (!m) return [testo.trim(), ""];
  return [testo.slice(0, m.index).trim(), testo.slice(m.index + m[0].length).trim()];
}

/** Testo pulito per la sintesi vocale: niente asterischi, emoji, link. */
function daPronunciare(testo: string): string {
  return testo
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_~`#>]/g, "")
    .replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu, "")
    .replace(/[ \t]+/g, " ")
    .trim()
    .slice(0, 1500);
}

/** Testo → vocale Ogg/Opus con Piper (servizio scribe). */
export async function sintetizza(config: Config, testo: string): Promise<Buffer> {
  if (!config.VOCE_URL) throw new Error("VOCE_URL non configurato");
  const risposta = await fetch(config.VOCE_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body: daPronunciare(testo),
    signal: AbortSignal.timeout(120_000),
  });
  if (!risposta.ok) throw new Error(`sintesi vocale non riuscita (${risposta.status}): ${(await risposta.text()).slice(0, 200)}`);
  return Buffer.from(await risposta.arrayBuffer());
}

function registra(id: string | undefined, testo: string, scambi: Scambio[]): void {
  const stato = caricaStato();
  const voce = { scambi, data: new Date().toISOString() };
  if (id) stato.conversazioni[id] = voce;
  if (testo) stato.conversazioni[`inizio:${inizioTesto(testo)}`] = voce;
  salvaStato(stato);
}

/**
 * Manda la risposta nel gruppo e la registra, così citandola si prosegue la conversazione.
 * Con `aVoce` (e VOCE_URL) la risposta è un vocale, più l'eventuale parte "SCRITTO:" come testo.
 * Con "VOCE:" nel testo (il briefing) manda il testo e poi la versione parlata.
 */
export async function rispondiSchiavo(
  ctx: { config: Config; log: Logger; openwa: ConfigOpenWA },
  testo: string,
  scambi: Scambio[],
  opzioni: { rispondiA?: string; aVoce?: boolean; prefisso?: string } = {},
): Promise<void> {
  const { config, log, openwa } = ctx;
  const cita = opzioni.rispondiA ? { quotedMessageId: opzioni.rispondiA } : {};
  const testoTesto = async (t: string, conCitazione = true) => {
    const messaggio = `${opzioni.prefisso ?? "🎩"} ${t}`;
    const id = await inviaTesto(openwa, messaggio, conCitazione ? cita : {}).catch(() => inviaTesto(openwa, messaggio));
    registra(id, messaggio, scambi);
  };
  const vocale = async (t: string, conCitazione: boolean) => {
    const ogg = await sintetizza(config, t);
    const id = await inviaVocale(openwa, ogg, conCitazione ? opzioni.rispondiA : undefined);
    registra(id, "", scambi);
  };

  const [principale, parlato] = dividi(testo, "VOCE");
  if (parlato) {
    await testoTesto(principale);
    if (config.VOCE_URL) await vocale(parlato, false).catch((e) => log.avviso(`Voce: ${descriviErrore(e)}`));
    return;
  }
  if (opzioni.aVoce && config.VOCE_URL) {
    const [detto, scritto] = dividi(testo, "SCRITTO");
    try {
      await vocale(detto, true);
      if (scritto) await testoTesto(scritto, false);
      return;
    } catch (e) {
      log.avviso(`Voce non riuscita, rispondo per iscritto: ${descriviErrore(e)}`);
    }
  }
  await testoTesto(testo.replace(/^\s*\**SCRITTO:?\**\s*$/im, "").trim());
}

/** Salva il dossier di /cliente nella cartella condivisa (06-clienti). */
export function salvaDossier(config: Config, richiesta: string, testo: string): string {
  const cartella = path.join(config.SHARED_DIR, "06-clienti");
  fs.mkdirSync(cartella, { recursive: true });
  const file = `${oggi()}_${slug(richiesta).slice(0, 60) || "cliente"}.md`;
  fs.writeFileSync(path.join(cartella, file), `# ${richiesta}\n\n${testo.trim()}\n`, "utf8");
  return file;
}

// ---------- Briefing del mattino ----------

const RICHIESTA_BRIEFING = "È l'ora del briefing del mattino: preparalo per il team.";

/** Il briefing: scritto, con la versione parlata in un vocale se BRIEFING_VOCE=true. */
export async function eseguiBriefing(ctx: { config: Config; log: Logger; openwa: ConfigOpenWA }, rispondiA?: string): Promise<void> {
  const { risposta, scambi } = await chiediSchiavo({ ...ctx, chi: "nessuno: è il briefing automatico per tutto il team" }, RICHIESTA_BRIEFING, {
    modo: "briefing",
  });
  const testo = ctx.config.BRIEFING_VOCE === "true" ? risposta : dividi(risposta, "VOCE")[0];
  await rispondiSchiavo(ctx, testo, scambi, { rispondiA, prefisso: "☀️🎩" });
  ctx.log.info("Schiavo: briefing inviato");
}

/** Da chiamare periodicamente: manda il briefing una volta al giorno, all'ora configurata (entro 3 ore). */
export async function controllaBriefing(ctx: { config: Config; log: Logger; openwa: ConfigOpenWA }): Promise<void> {
  if (ctx.config.BRIEFING_ORARIO === "off") return;
  const [hh, mm] = ctx.config.BRIEFING_ORARIO.split(":").map(Number);
  const ora = new Date();
  const minuti = ora.getHours() * 60 + ora.getMinutes();
  const obiettivo = (hh ?? 8) * 60 + (mm ?? 45);
  const oggiLocale = `${ora.getFullYear()}-${String(ora.getMonth() + 1).padStart(2, "0")}-${String(ora.getDate()).padStart(2, "0")}`;
  if (minuti < obiettivo || minuti > obiettivo + 180) return;
  const stato = caricaStato();
  if (stato.ultimoBriefing === oggiLocale) return;
  stato.ultimoBriefing = oggiLocale; // segnato prima: se fallisce non riprova a raffica
  salvaStato(stato);
  await eseguiBriefing(ctx);
}

/** Manda i promemoria scaduti. Da chiamare periodicamente dal servizio. */
export async function controllaPromemoria(openwa: ConfigOpenWA, log: Logger): Promise<void> {
  const stato = caricaStato();
  const ora = new Date().toISOString();
  const scaduti = stato.promemoria.filter((p) => p.quando <= ora);
  if (!scaduti.length) return;
  stato.promemoria = stato.promemoria.filter((p) => p.quando > ora);
  salvaStato(stato);
  for (const p of scaduti) {
    await inviaTesto(openwa, `⏰🎩 ${p.testo}`).catch((e) => log.errore(`Promemoria non inviato: ${descriviErrore(e)}`));
    log.info("Schiavo: promemoria inviato");
  }
}
