import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { creaClient } from "./claude.js";
import { DATI_DIR, type Config } from "./config.js";
import { riepilogo, riepilogoAssistenza, AVVISO_SIMULATI } from "./dati-simulati.js";
import { creaCard } from "./grafica.js";
import { creaGrafico, type DatiGrafico } from "./grafico.js";
import { proponi, type TipoProposta } from "./approvazioni.js";
import { creaFile, type TipoFile } from "./file-claude.js";
import { aggiornaCompito, cercaCompiti, creaCompito } from "./linear-simulato.js";
import { descriviErrore, type Logger } from "./log.js";
import { cercaMemoria, memorizza } from "./memoria.js";
import {
  fissaMessaggio,
  inviaDocumento,
  inviaImmagine,
  inviaSticker,
  inviaTesto,
  inviaVocale,
  richiesta,
  scaricaMediaConTipo,
  type ConfigOpenWA,
} from "./openwa.js";
import { lavoraPost } from "./post.js";
import { leggiLineeGuida } from "./pipeline.js";
import { descriviPasso, Progresso } from "./progresso.js";
import { avviaQuiz } from "./quiz.js";
import { ricercaApprofondita } from "./ricerca.js";
import { creaSticker } from "./sticker.js";
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

export type Modo = "normale" | "cliente" | "briefing" | "monitor";

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
  /** turni di monitoraggio già fatti ("YYYY-MM-DD HH:MM") e cose già segnalate (per non ripetersi) */
  monitorFatti?: string[];
  segnalati?: string[];
  /** ricerche approfondite per giorno */
  ricerche?: Record<string, number>;
  note: string[];
  promemoria: Promemoria[];
  /** chiave: id del messaggio di risposta o "inizio:<testo>" → la conversazione fin lì */
  conversazioni: Record<string, { scambi: Scambio[]; data: string }>;
}

const FILE_STATO = path.join(DATI_DIR, ".schiavo.json");

function caricaStato(): StatoSchiavo {
  try {
    const d = JSON.parse(fs.readFileSync(FILE_STATO, "utf8")) as Partial<StatoSchiavo>;
    return { ultimoBriefing: d.ultimoBriefing, monitorFatti: d.monitorFatti ?? [], segnalati: d.segnalati ?? [], ricerche: d.ricerche ?? {}, trascrizioni: d.trascrizioni ?? {}, note: d.note ?? [], promemoria: d.promemoria ?? [], conversazioni: d.conversazioni ?? {} };
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

// Niente "strict": con più di 20 strumenti l'API lo rifiuta (grammatica troppo grande). Gli input li controlla
// comunque eseguiStrumento, campo per campo.

const strumento = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
): Anthropic.Beta.BetaToolUnion => ({
  name,
  description,
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

const STRUMENTI_AVANZATI: Anthropic.Beta.BetaToolUnion[] = [
  strumento(
    "cerca_memoria",
    "Cerca nella memoria completa del gruppo (tutti i messaggi salvati, anche vecchi di mesi, con i vocali trascritti): decisioni passate, chi ha detto cosa, quando se n'è parlato. Parole vuote = tutti i messaggi del periodo.",
    {
      parole: { type: "string", description: "Parole chiave (anche più d'una), o stringa vuota" },
      da: { type: "string", description: "Data iniziale YYYY-MM-DD, o stringa vuota" },
      a: { type: "string", description: "Data finale YYYY-MM-DD, o stringa vuota" },
      autore: { type: "string", description: "Nome di chi ha scritto, o stringa vuota" },
    },
  ),
  strumento(
    "linear_crea",
    "Crea un compito su Linear (SIMULATO per ora). Usalo direttamente solo se te lo chiedono; se è una tua idea usa chiedi_approvazione. Per l'etichetta 'agent' servono obiettivo e criteri di accettazione.",
    {
      titolo: { type: "string" },
      descrizione: { type: "string" },
      assegnatario: { type: "string", description: "Nome, o stringa vuota" },
      priorita: { type: "string", enum: ["Urgente", "Alta", "Media", "Bassa", "Nessuna"] },
      scadenza: { type: "string", description: "YYYY-MM-DD, o stringa vuota" },
      etichette: { type: "array", items: { type: "string" } },
      obiettivo: { type: "string", description: "Stringa vuota se non serve" },
      criteri_accettazione: { type: "array", items: { type: "string" } },
      file_coinvolti: { type: "array", items: { type: "string" } },
    },
  ),
  strumento("linear_cerca", "Cerca compiti su Linear (SIMULATO per ora).", {
    testo: { type: "string", description: "Parole nel titolo, o stringa vuota" },
    stato: { type: "string", description: "Backlog, Todo, In Progress, In Review, Done, Canceled, 'aperti' o stringa vuota" },
    assegnatario: { type: "string", description: "Nome o stringa vuota" },
    in_scadenza_giorni: { type: "integer", description: "Solo quelli che scadono entro N giorni (0 = nessun filtro)" },
  }),
  strumento("linear_aggiorna", "Aggiorna un compito su Linear (SIMULATO per ora): stato, assegnatario, priorità, scadenza, commento.", {
    id: { type: "string", description: "Es. DG-104" },
    stato: { type: "string", description: "Nuovo stato o stringa vuota" },
    assegnatario: { type: "string", description: "Stringa vuota per lasciarlo" },
    priorita: { type: "string", description: "Stringa vuota per lasciarla" },
    scadenza: { type: "string", description: "YYYY-MM-DD o stringa vuota" },
    commento: { type: "string", description: "Stringa vuota se nessuno" },
  }),
  strumento(
    "chiedi_approvazione",
    "Manda nel gruppo una proposta che si approva con 👍 (e si scarta con 👎). Usalo per le azioni che proponi di tua iniziativa: un compito, un promemoria, un sondaggio. Quando qualcuno mette 👍 la eseguo io.",
    {
      tipo: { type: "string", enum: ["compito", "promemoria", "sondaggio"] },
      descrizione: { type: "string", description: "La proposta in 1-3 righe, chiara per tutti" },
      parametri_json: {
        type: "string",
        description:
          'JSON con i parametri: compito {"titolo","descrizione","assegnatario","priorita","scadenza","etichette":[],"obiettivo","criteri_accettazione":[]}; promemoria {"quando":"ISO 8601 con fuso","testo"}; sondaggio {"domanda","opzioni":[],"scelta_multipla":false}',
      },
    },
  ),
  strumento(
    "crea_file",
    "Crea un file vero e lo manda nel gruppo: presentazione PowerPoint (pptx), foglio Excel (xlsx, anche con formule e grafici), documento Word (docx) o PDF. Ci mette 1-3 minuti e lavora in background. Metti nelle istruzioni TUTTO il contenuto e i numeri (prendili prima con gli altri strumenti): chi crea il file non vede questa conversazione.",
    {
      tipo: { type: "string", enum: ["pptx", "xlsx", "docx", "pdf"] },
      nome_file: { type: "string", description: "Senza estensione, es. demo-dashboard" },
      istruzioni: { type: "string", description: "Struttura, contenuto completo, dati, tono, numero di slide/pagine" },
    },
  ),
  strumento(
    "ricerca_approfondita",
    "Ricerca approfondita sul web con più ricercatori in parallelo e rapporto in PDF con le fonti (5-10 minuti, in background, costa qualche dollaro). Solo quando chiedono esplicitamente una ricerca approfondita, un'analisi di mercato o un rapporto.",
    { tema: { type: "string", description: "Il tema, con lo scopo e cosa interessa al team" } },
  ),
  strumento(
    "avvia_quiz",
    "Avvia un quiz nel gruppo (si gioca con le reazioni sulla card, con punti e classifica). Solo se te lo chiedono.",
    {
      tema: { type: "string", description: "Tema del quiz, o stringa vuota per misto" },
      domande: { type: "integer", description: "Da 3 a 10" },
      secondi: { type: "integer", description: "Secondi per domanda, da 15 a 60" },
    },
  ),
  strumento("crea_sticker", "Disegna uno sticker WhatsApp (grafica con testo e simboli, niente foto né volti reali) e lo manda nel gruppo.", {
    descrizione: { type: "string", description: "Cosa deve rappresentare e il testo, es. 'maggiordomo con vassoio, scritta APPROVATO'" },
  }),
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
  const ricerche = modo === "cliente" ? 10 : modo === "briefing" || modo === "monitor" ? 4 : 6;
  // Versioni "classiche" della ricerca: quelle con il filtro dinamico (_20260209) lanciano le ricerche da codice e,
  // insieme a tanti strumenti nostri, Jarvis ripeteva la stessa ricerca fino a esaurire il limite senza risultati.
  return [
    { type: "web_search_20250305", name: "web_search", max_uses: ricerche },
    { type: "web_fetch_20250910", name: "web_fetch", max_uses: ricerche },
    ...STRUMENTI_BASE,
    ...STRUMENTI_AVANZATI.filter((t) => config.MEMORIA === "on" || ("name" in t && t.name !== "cerca_memoria")),
    ...(config.DATI_DOUBLEGRAM === "simulati" ? [STRUMENTO_DATI, STRUMENTO_ASSISTENZA] : []),
  ];
}

interface Contesto {
  config: Config;
  log: Logger;
  openwa: ConfigOpenWA;
  chi: string;
  /** messaggio di avanzamento da aggiornare mentre lavora */
  progresso?: Progresso;
  /** messaggio a cui rispondere (per i lavori in background) */
  rispondiA?: string;
}

/** Aggiunge un promemoria (anche da un'approvazione con 👍). */
export function aggiungiPromemoria(quandoTesto: string, testo: string, chi: string): string {
  const stato = caricaStato();
  const quando = new Date(quandoTesto);
  if (Number.isNaN(quando.getTime())) return "Data non valida: usa il formato ISO 8601 con fuso orario.";
  if (quando.getTime() < Date.now() - 60_000) return "Quella data è già passata.";
  if (stato.promemoria.length >= 50) return "Ci sono già 50 promemoria: annullane qualcuno.";
  stato.promemoria.push({ quando: quando.toISOString(), testo, chi });
  stato.promemoria.sort((a, b) => a.quando.localeCompare(b.quando));
  salvaStato(stato);
  return `Promemoria programmato per ${quando.toLocaleString("it-IT", { timeZone: process.env["TZ"] || "Europe/Rome" })}.`;
}

/** Crea un file con le skill di Claude e lo manda nel gruppo, con il suo messaggio di avanzamento. */
async function lavoroFile(ctx: Contesto, tipo: TipoFile, nomeFile: string, istruzioni: string): Promise<void> {
  const { config, log, openwa } = ctx;
  const progresso = new Progresso(openwa, `📎 *Preparo ${nomeFile}.${tipo}*`, ctx.rispondiA);
  await progresso.inizia();
  try {
    const file = await creaFile(config, { tipo, nomeFile, istruzioni }, (p) => progresso.passo(p));
    const cartella = path.join(config.SHARED_DIR, "08-file");
    fs.mkdirSync(cartella, { recursive: true });
    fs.writeFileSync(path.join(cartella, `${oggi()}_${file.nome}`), file.dati);
    await inviaDocumento(openwa, file.dati, file.nome, file.mimetype);
    await progresso.fine(`📎 *${file.nome}* è pronto, Signore: lo trova qui sotto (e in 08-file/).
${file.nota ? `
${file.nota}` : ""}`);
    log.info(`Schiavo: file ${file.nome} (${Math.round(file.dati.length / 1024)} KB)`);
  } catch (e) {
    log.errore(`Schiavo, file: ${descriviErrore(e)}`);
    await progresso.fine(`📎 Mi rincresce, Signore: il file ${nomeFile}.${tipo} non è venuto (${descriviErrore(e)}).`);
  }
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
    case "programma_promemoria":
      return aggiungiPromemoria(String(input["quando"] ?? ""), String(input["testo"] ?? ""), ctx.chi);
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
    case "cerca_memoria":
      return cercaMemoria(config, {
        parole: String(input["parole"] ?? ""),
        da: String(input["da"] ?? "") || undefined,
        a: String(input["a"] ?? "") || undefined,
        autore: String(input["autore"] ?? "") || undefined,
      });
    case "linear_crea":
      return creaCompito({
        titolo: String(input["titolo"] ?? ""),
        descrizione: String(input["descrizione"] ?? ""),
        assegnatario: String(input["assegnatario"] ?? ""),
        priorita: String(input["priorita"] ?? ""),
        scadenza: String(input["scadenza"] ?? ""),
        etichette: Array.isArray(input["etichette"]) ? input["etichette"].map(String) : [],
        obiettivo: String(input["obiettivo"] ?? ""),
        criteri_accettazione: Array.isArray(input["criteri_accettazione"]) ? input["criteri_accettazione"].map(String) : [],
        file_coinvolti: Array.isArray(input["file_coinvolti"]) ? input["file_coinvolti"].map(String) : [],
        autore: ctx.chi,
      });
    case "linear_cerca":
      return cercaCompiti({
        testo: String(input["testo"] ?? ""),
        stato: String(input["stato"] ?? "") || undefined,
        assegnatario: String(input["assegnatario"] ?? "") || undefined,
        in_scadenza_giorni: Number(input["in_scadenza_giorni"]) || undefined,
      });
    case "linear_aggiorna":
      return aggiornaCompito({
        id: String(input["id"] ?? ""),
        stato: String(input["stato"] ?? "") || undefined,
        assegnatario: String(input["assegnatario"] ?? "") || undefined,
        priorita: String(input["priorita"] ?? "") || undefined,
        scadenza: String(input["scadenza"] ?? "") || undefined,
        commento: String(input["commento"] ?? "") || undefined,
        autore: ctx.chi,
      });
    case "chiedi_approvazione": {
      let parametri: Record<string, unknown> = {};
      try {
        parametri = JSON.parse(String(input["parametri_json"] ?? "{}")) as Record<string, unknown>;
      } catch {
        return "parametri_json non è un JSON valido.";
      }
      const tipo = String(input["tipo"] ?? "") as TipoProposta;
      if (!["compito", "promemoria", "sondaggio"].includes(tipo)) return "Tipo di proposta non valido.";
      return proponi(openwa, tipo, String(input["descrizione"] ?? ""), parametri);
    }
    case "crea_file": {
      const tipo = String(input["tipo"] ?? "") as TipoFile;
      if (!["pptx", "xlsx", "docx", "pdf"].includes(tipo)) return "Tipo di file non valido.";
      void lavoroFile(ctx, tipo, String(input["nome_file"] ?? "documento"), String(input["istruzioni"] ?? ""));
      return "Creazione del file avviata in background: nel gruppo c'è già il messaggio che mostra l'avanzamento, e il file arriverà lì tra 1-3 minuti.";
    }
    case "ricerca_approfondita": {
      const giorno = oggi();
      const fatte = stato.ricerche?.[giorno] ?? 0;
      if (fatte >= config.RICERCHE_MAX_GIORNO) return `Oggi sono già state fatte ${fatte} ricerche approfondite (limite RICERCHE_MAX_GIORNO): riprova domani.`;
      stato.ricerche = { [giorno]: fatte + 1 };
      salvaStato(stato);
      void ricercaApprofondita({ config, log, openwa }, String(input["tema"] ?? ""), ctx.rispondiA);
      return "Ricerca approfondita avviata in background: nel gruppo c'è il messaggio con l'avanzamento, il rapporto PDF arriverà tra 5-10 minuti.";
    }
    case "avvia_quiz":
      return avviaQuiz({ config, log, openwa }, String(input["tema"] ?? ""), Number(input["domande"]) || 5, Number(input["secondi"]) || 30);
    case "crea_sticker": {
      const { png, descrizione } = await creaSticker(config, String(input["descrizione"] ?? ""));
      await inviaSticker(openwa, png);
      return `Sticker inviato: ${descrizione}`;
    }
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
  monitor: `
MODALITÀ MONITORAGGIO (turno automatico, nessuno ti ha scritto): controlli se c'è qualcosa che il team DEVE sapere ora.
Guarda: 1-3 ricerche web su novità degli ultimi giorni (Telegram per community e bot, concorrenti come Combot, Rose,
Group Help, Shieldy, e le aziende dei dossier clienti indicate sotto); i compiti Linear che scadono entro 2 giorni
(linear_cerca con in_scadenza_giorni 2); anomalie nei numeri e nell'assistenza degli ultimi 3 giorni rispetto ai
precedenti (dati simulati).
Scrivi SOLO se trovi qualcosa di nuovo, concreto e utile adesso, che non è nell'elenco delle cose già segnalate.
Se non c'è niente di davvero importante rispondi esattamente NIENTE (e nient'altro).
Se scrivi: al massimo 700 caratteri, cosa è successo, perché conta per Doublegram, cosa suggerisci, con la fonte.
Se serve un'azione puoi proporla con chiedi_approvazione.`,
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
- preparare post per il canale Telegram (crea_post_canale) e ricordare informazioni nel tempo (ricorda / dimentica);
- cercare in tutta la memoria del gruppo, anche messaggi vecchi di mesi (cerca_memoria);
- gestire i compiti su Linear (linear_crea / linear_cerca / linear_aggiorna; per ora è SIMULATO: dillo);
- proporre azioni che il team approva con un 👍 (chiedi_approvazione);
- creare file veri: PowerPoint, Excel, Word, PDF (crea_file), e ricerche approfondite con rapporto PDF (ricerca_approfondita);
- far giocare il gruppo a un quiz (avvia_quiz) e disegnare sticker (crea_sticker).

Doublegram: suite di bot per community Telegram (Security, Scribe, Doublegram AI, Lookup), piano Free e Premium a 9,99 $/mese, doublegram.com.
Linee guida del team (fatti verificati):
${leggiLineeGuida(config.SHARED_DIR).trim().slice(0, 4000)}

Regole:
- Rispondi in italiano (o nella lingua in cui ti scrivono). Testo adatto a WhatsApp: niente titoli markdown né tabelle;
  *grassetto* con un asterisco, elenchi con trattini. Di norma al massimo 1500 caratteri: sii denso, non prolisso.
- Non inventare fatti, numeri o fonti: se non lo sai e non puoi verificarlo, dillo con garbo.
- Agisci solo nel gruppo: non puoi scrivere in privato a nessuno e non devi provarci.
- Se hai usato uno strumento che manda qualcosa nel gruppo, nella risposta dillo in una riga, senza ripetere il contenuto.
- Quello che ti chiedono lo fai direttamente; quello che proponi tu di tua iniziativa (un compito, un promemoria,
  un sondaggio) passa da chiedi_approvazione, così decide il team con un 👍.
- Per una domanda sul passato ("cosa avevamo deciso…", "quando ne abbiamo parlato") usa cerca_memoria prima di rispondere.
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
    const flusso = client.beta.messages.stream({
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
    // Avanzamento in diretta: ricerche web e pagine lette appena il blocco è completo.
    if (ctx.progresso) {
      const progresso = ctx.progresso;
      let scrive = false;
      flusso.on("streamEvent", (evento, istantanea) => {
        if (evento.type === "content_block_stop") {
          const b = istantanea.content[evento.index];
          if (b?.type === "server_tool_use") progresso.passo(descriviPasso(b.name, (b.input ?? {}) as Record<string, unknown>));
        } else if (evento.type === "content_block_start" && evento.content_block.type === "text" && !scrive && giro > 0) {
          scrive = true;
          progresso.passo("✍️ Scrivo la risposta");
        }
      });
    }
    risposta = await flusso.finalMessage();
    // Errori degli strumenti lato server (ricerca, pagine, esecuzione di codice della ricerca "dinamica"):
    // non fanno fallire la chiamata, arrivano dentro i blocchi. Li metto nei log.
    for (const blocco of risposta.content) {
      if (!blocco.type.endsWith("_tool_result")) continue;
      const c = (blocco as { content?: unknown }).content;
      const errore = c && typeof c === "object" && !Array.isArray(c) ? (c as { error_code?: string }).error_code : undefined;
      if (errore) log.avviso(`Schiavo: ${blocco.type} errore ${errore}`);
    }
    const usati = risposta.content.filter((b) => b.type === "server_tool_use").map((b) => (b as { name: string }).name);
    if (usati.length) log.info(`Schiavo: strumenti server ${usati.join(", ")} (stop: ${risposta.stop_reason})`);
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
        ctx.progresso?.passo(descriviPasso(blocco.name, (blocco.input ?? {}) as Record<string, unknown>));
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
  opzioni: { rispondiA?: string; aVoce?: boolean; prefisso?: string; progresso?: Progresso; fissa?: boolean } = {},
): Promise<void> {
  const { config, log, openwa } = ctx;
  const cita = opzioni.rispondiA ? { quotedMessageId: opzioni.rispondiA } : {};
  let progresso = opzioni.progresso;
  const testoTesto = async (t: string, conCitazione = true) => {
    const messaggio = `${opzioni.prefisso ?? "🎩"} ${t}`;
    // Il messaggio di avanzamento diventa la risposta (una volta sola).
    const id = progresso
      ? await progresso.fine(messaggio)
      : await inviaTesto(openwa, messaggio, conCitazione ? cita : {}).catch(() => inviaTesto(openwa, messaggio));
    progresso = undefined;
    registra(id, messaggio, scambi);
    // In memoria la risposta vera (il messaggio è nato come "Un istante…" ed è stato modificato).
    if (id) memorizza(config, { id, data: new Date().toISOString(), autore: "Jarvis", testo: messaggio });
    if (opzioni.fissa && id) await fissaMessaggio(openwa, id);
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
      await progresso?.elimina();
      progresso = undefined;
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
  const progresso = new Progresso(ctx.openwa, "☀️🎩 Preparo il briefing del mattino…", rispondiA);
  await progresso.inizia();
  const { risposta, scambi } = await chiediSchiavo(
    { ...ctx, chi: "nessuno: è il briefing automatico per tutto il team", progresso },
    RICHIESTA_BRIEFING,
    { modo: "briefing" },
  );
  const testo = ctx.config.BRIEFING_VOCE === "true" ? risposta : dividi(risposta, "VOCE")[0];
  // Il briefing resta fissato in cima al gruppo per 24 ore.
  await rispondiSchiavo(ctx, testo, scambi, { rispondiA, prefisso: "☀️🎩", progresso, fissa: true });
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

// ---------- Monitoraggio proattivo ----------

/** Da chiamare ogni minuto: agli orari MONITOR_ORARI fa un giro di controllo e scrive solo se c'è qualcosa. */
export async function controllaMonitor(ctx: { config: Config; log: Logger; openwa: ConfigOpenWA }): Promise<void> {
  if (ctx.config.MONITOR_ORARI === "off") return;
  const ora = new Date();
  const minuti = ora.getHours() * 60 + ora.getMinutes();
  const giorno = `${ora.getFullYear()}-${String(ora.getMonth() + 1).padStart(2, "0")}-${String(ora.getDate()).padStart(2, "0")}`;
  const turno = ctx.config.MONITOR_ORARI.split(",")
    .map((t) => t.trim())
    .find((t) => {
      const [h, m] = t.split(":").map(Number);
      const obiettivo = (h ?? 0) * 60 + (m ?? 0);
      return minuti >= obiettivo && minuti <= obiettivo + 60;
    });
  if (!turno) return;
  const chiave = `${giorno} ${turno}`;
  const stato = caricaStato();
  if (stato.monitorFatti?.includes(chiave)) return;
  stato.monitorFatti = [...(stato.monitorFatti ?? []), chiave].slice(-20);
  salvaStato(stato);
  await eseguiMonitor(ctx);
}

export async function eseguiMonitor(ctx: { config: Config; log: Logger; openwa: ConfigOpenWA }): Promise<void> {
  const stato = caricaStato();
  const dossier = fs.existsSync(path.join(ctx.config.SHARED_DIR, "06-clienti"))
    ? fs.readdirSync(path.join(ctx.config.SHARED_DIR, "06-clienti")).filter((f) => f.endsWith(".md")).slice(-10)
    : [];
  const richiestaMonitor = [
    "Turno di monitoraggio.",
    `Aziende dei dossier clienti: ${dossier.length ? dossier.map((f) => f.replace(/^\d{4}-\d{2}-\d{2}_/, "").replace(/\.md$/, "")).join(", ") : "nessuna"}.`,
    `Già segnalato in passato (non ripeterlo):\n${(stato.segnalati ?? []).slice(-30).map((s) => `- ${s}`).join("\n") || "- niente"}`,
  ].join("\n\n");
  const { risposta, scambi } = await chiediSchiavo({ ...ctx, chi: "nessuno: è il monitoraggio automatico" }, richiestaMonitor, { modo: "monitor" });
  if (/^\W*NIENTE\W*$/i.test(risposta.trim()) || risposta.trim().length < 30) {
    ctx.log.info("Monitoraggio: niente da segnalare");
    return;
  }
  await rispondiSchiavo(ctx, risposta, scambi, { prefisso: "🔔🎩" });
  const s2 = caricaStato();
  s2.segnalati = [...(s2.segnalati ?? []), `${oggi()}: ${risposta.replace(/\s+/g, " ").slice(0, 160)}`].slice(-40);
  salvaStato(s2);
  ctx.log.info("Monitoraggio: segnalazione inviata");
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
