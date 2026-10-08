import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { creaClient } from "./claude.js";
import { DATI_DIR, type Config } from "./config.js";
import { creaCard } from "./grafica.js";
import { descriviErrore, type Logger } from "./log.js";
import { inviaImmagine, inviaTesto, richiesta, scaricaMediaConTipo, type ConfigOpenWA } from "./openwa.js";
import { lavoraPost } from "./post.js";
import { leggiLineeGuida } from "./pipeline.js";
import { inizioTesto } from "./testo.js";

/**
 * /schiavo (o /jarvis, o un vocale che inizia con "Jarvis…"): il maggiordomo del gruppo.
 * È un agente Claude con strumenti veri: legge la chat, cerca sul web e apre i link, guarda immagini e PDF
 * citati, ascolta i vocali citati, manda card, sondaggi e promemoria, prepara post per il canale e si
 * ricorda le cose che gli si chiede di ricordare. Agisce solo nel gruppo configurato: niente messaggi privati.
 * Citando una sua risposta si continua la conversazione.
 */

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
  note: string[];
  promemoria: Promemoria[];
  /** chiave: id del messaggio di risposta o "inizio:<testo>" → la conversazione fin lì */
  conversazioni: Record<string, { scambi: Scambio[]; data: string }>;
}

const FILE_STATO = path.join(DATI_DIR, ".schiavo.json");

function caricaStato(): StatoSchiavo {
  try {
    const d = JSON.parse(fs.readFileSync(FILE_STATO, "utf8")) as Partial<StatoSchiavo>;
    return { note: d.note ?? [], promemoria: d.promemoria ?? [], conversazioni: d.conversazioni ?? {} };
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

const STRUMENTI: Anthropic.Beta.BetaToolUnion[] = [
  { type: "web_search_20260209", name: "web_search", max_uses: 5 },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 5 },
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
];

interface Contesto {
  config: Config;
  log: Logger;
  openwa: ConfigOpenWA;
  chi: string;
}

async function leggiChat(openwa: ConfigOpenWA, quanti: number): Promise<string> {
  const n = Math.max(10, Math.min(100, Math.trunc(quanti) || 40));
  const storico = (await richiesta(openwa, "GET", `/messages/${encodeURIComponent(openwa.gruppo)}/history?limit=${n}`)) as Array<{
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
      const testo = m.body?.trim() || `[${m.type ?? "messaggio"}]`;
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

function sistema(config: Config, note: string[]): string {
  return `Sei Jarvis, il maggiordomo personale del team di Doublegram, dentro il loro gruppo WhatsApp.
Ti rivolgi a chi ti scrive con deferenza da maggiordomo inglese d'altri tempi ("Signore", "Mi permetta", "Come desidera"),
con eleganza e un filo di ironia asciutta, mai servile in modo stucchevole. Ma sei straordinariamente capace:
risolvi davvero il problema, con precisione, e quando serve usi gli strumenti senza chiedere il permesso.

Cosa sai fare (usa gli strumenti, non limitarti a descrivere):
- cercare sul web informazioni aggiornate (web_search) e leggere pagine e link (web_fetch), citando le fonti;
- leggere la chat del gruppo per riassunti e "cosa mi sono perso" (leggi_chat);
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

Note salvate (cose che il team ti ha chiesto di ricordare):
${note.length ? note.map((n, i) => `${i + 1}. ${n}`).join("\n") : "(nessuna)"}`;
}

/**
 * Esegue una richiesta al maggiordomo e restituisce la risposta da scrivere nel gruppo.
 * `precedenti`: la conversazione fin qui (quando si cita una sua risposta).
 */
export async function chiediSchiavo(
  ctx: Contesto,
  richiestaUtente: string,
  opzioni: { precedenti?: Scambio[]; allegato?: Allegato; trascrizione?: string; citato?: string },
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
      system: [{ type: "text", text: sistema(config, stato.note), cache_control: { type: "ephemeral" } }],
      tools: STRUMENTI,
      messages: messaggi,
      output_config: { effort: "medium" },
      ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });
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
  if (!testo) testo = "Fatto, Signore.";
  const scambi = [...(opzioni.precedenti ?? []), { domanda: righe.slice(1).join("\n\n"), risposta: testo }].slice(-8);
  return { risposta: testo, scambi };
}

/** Manda la risposta nel gruppo e la registra, così citandola si prosegue la conversazione. */
export async function rispondiSchiavo(
  openwa: ConfigOpenWA,
  testo: string,
  scambi: Scambio[],
  rispondiA?: string,
): Promise<void> {
  const messaggio = `🎩 ${testo}`;
  const id = await inviaTesto(openwa, messaggio, rispondiA ? { quotedMessageId: rispondiA } : {}).catch(() =>
    inviaTesto(openwa, messaggio),
  );
  const stato = caricaStato();
  const voce = { scambi, data: new Date().toISOString() };
  if (id) stato.conversazioni[id] = voce;
  stato.conversazioni[`inizio:${inizioTesto(messaggio)}`] = voce;
  salvaStato(stato);
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
