import fs from "node:fs";
import path from "node:path";
import { componiBozza, leggiBozza } from "./bozza.js";
import { creaClient } from "./claude.js";
import { percorsoLibero } from "./cartelle.js";
import { CARTELLE, type Config } from "./config.js";
import { htmlInTesto } from "./feed.js";
import { descriviErrore, type Logger } from "./log.js";
import { configOpenWA, inviaTesto, scaricaMedia, type ConfigOpenWA } from "./openwa.js";
import {
  caricaSorgente,
  leggiLineeGuida,
  revisionaVariante,
  segnaposto,
  verifica,
  type Contesto,
} from "./pipeline.js";
import { caricaStato, caricaStatoComandi, salvaStatoComandi, type MessaggioInviato } from "./stato.js";
import { inizioTesto, oggi, testoSemplice } from "./testo.js";

/** Il messaggio che arriva da OpenWA con gli eventi message.received / message.sent (solo i campi che usiamo). */
export interface MessaggioRicevuto {
  id?: string;
  chatId?: string;
  from?: string;
  body?: string;
  fromMe?: boolean;
  type?: string;
  media?: { mimetype?: string; data?: string; omitted?: boolean };
  quotedMessage?: { id?: string; body?: string };
}

export type Comando = { tipo: "riscrivi"; richiesta: string; quale?: "A" | "B" } | { tipo: "aiuto" };

const normalizza = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** Parole che rendono una risposta un comando. Il testo intero diventa la richiesta per il modello. */
const PAROLE_CHIAVE = [
  "piu corto", "piu corta", "piu breve", "accorcia", "sintetizza", "taglia",
  "piu lungo", "piu lunga", "allunga", "sviluppa",
  "hook", "cambia inizio", "cambia attacco", "altro inizio",
  "cambia chiusura", "cambia finale", "cambia cta", "altra domanda",
  "piu diretto", "piu diretta", "piu semplice", "piu concreto", "piu concreta",
  "meno formale", "piu informale", "piu formale", "cambia tono", "tono",
  "senza emoji", "meno emoji", "piu emoji",
  "rifai", "rigenera", "riscrivi", "riprova", "cambia",
];

export const AIUTO = [
  "Rispondi citando una bozza (tieni premuto il messaggio → Rispondi) e scrivi cosa cambiare, per esempio:",
  "- più corto / più lungo",
  "- cambia hook",
  "- cambia chiusura",
  "- più diretto / meno formale",
  "- senza emoji",
  "- rifai: <istruzione libera>",
  "Aggiungi \"variante B\" per modificare la B. Le risposte non contano nel limite dei 3 messaggi al giorno.",
  "",
  "Per proporre un post da adattare scrivi nel gruppo (senza citare niente):",
  "- uno screenshot del post con didascalia: adatta",
  "- adatta: <testo del post incollato>",
  "- adatta <link a un articolo o newsletter> (LinkedIn no: lì serve lo screenshot)",
].join("\n");

export function interpretaComando(testo: string): Comando | undefined {
  const t = normalizza(testo);
  if (!t) return undefined;
  if (/^(aiuto|comandi|help|\?)$/.test(t)) return { tipo: "aiuto" };
  if (!PAROLE_CHIAVE.some((p) => t.includes(p))) return undefined;
  const quale = /\bvariante\s*b\b|^b\b[:\s]/.test(t) ? "B" : /\bvariante\s*a\b|^a\b[:\s]/.test(t) ? "A" : undefined;
  return { tipo: "riscrivi", richiesta: testo.trim(), ...(quale ? { quale } : {}) };
}

/** whatsapp-web.js usa id come `true_<chat>_<chiave>[_<partecipante>]`: confronto sulla chiave. */
function chiaveId(id: string): string {
  const parti = id.split("_");
  return parti.length >= 3 ? (parti[2] ?? id) : id;
}

export function trovaRiferimento(
  citato: { id?: string; body?: string },
  registri: Array<Record<string, MessaggioInviato>>,
): MessaggioInviato | undefined {
  for (const registro of registri) {
    if (citato.id && registro[citato.id]) return registro[citato.id];
  }
  if (citato.id) {
    const chiave = chiaveId(citato.id);
    for (const registro of registri) {
      const trovato = Object.entries(registro).find(([id]) => chiaveId(id) === chiave);
      if (trovato) return trovato[1];
    }
  }
  if (citato.body) {
    // Ripiego: il testo citato coincide con l'inizio di un messaggio inviato (il più recente vince).
    const inizio = inizioTesto(citato.body);
    for (const registro of registri) {
      const trovato = Object.values(registro)
        .reverse()
        .find((m) => m.inizio && (inizio.startsWith(m.inizio) || m.inizio.startsWith(inizio)) && inizio.length >= 20);
      if (trovato) return trovato;
    }
  }
  return undefined;
}

function trovaBozza(sharedDir: string, nome: string): string | undefined {
  for (const cartella of [CARTELLE.bozze, CARTELLE.approvati]) {
    const file = path.join(sharedDir, cartella, nome);
    if (fs.existsSync(file)) return file;
  }
  return undefined;
}

const INIZIO_ADATTA = /^\s*adatta\b\s*:?\s*/i;
const ESTENSIONI_IMMAGINE: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/**
 * "adatta" nel gruppo: salva in 01-da-adattare/ uno screenshot, un testo incollato o un articolo
 * scaricato da un link. Restituisce il messaggio di risposta per il gruppo.
 */
async function aggiungiFonte(config: Config, openwa: ConfigOpenWA, msg: MessaggioRicevuto, chat: string): Promise<string> {
  const resto = (msg.body ?? "").replace(INIZIO_ADATTA, "").trim();
  const cartella = path.join(config.SHARED_DIR, CARTELLE.daAdattare);
  fs.mkdirSync(cartella, { recursive: true });
  const base = `whatsapp_${oggi()}_${Date.now()}`;
  const conferma = `✅ Aggiunto alle fonti: diventa una bozza al prossimo giro delle ${config.ORARIO_ADATTA}.`;

  const mime = msg.media?.mimetype ?? "";
  if (msg.type === "image" || mime.startsWith("image/")) {
    const ext = ESTENSIONI_IMMAGINE[mime];
    if (!ext) return `Formato immagine non supportato (${mime || "sconosciuto"}): manda uno screenshot PNG o JPG.`;
    const dati =
      msg.media?.data && !msg.media.omitted
        ? Buffer.from(msg.media.data, "base64")
        : msg.id
          ? await scaricaMedia(openwa, chat, msg.id)
          : undefined;
    if (!dati?.length) return "Non riesco a scaricare l'immagine: riprova a mandarla.";
    if (dati.length > 5 * 1024 * 1024) return "Immagine troppo grande (massimo 5 MB): manda uno screenshot normale.";
    fs.writeFileSync(percorsoLibero(cartella, `${base}.${ext}`), dati);
    return conferma;
  }

  const link = /^<?(https?:\/\/\S+?)>?$/.exec(resto)?.[1];
  if (link) {
    if (/(^|\.)linkedin\.com$/i.test(new URL(link).hostname)) {
      return "LinkedIn non si può leggere in automatico: manda uno screenshot del post con didascalia \"adatta\", oppure incolla il testo dopo \"adatta:\".";
    }
    const risposta = await fetch(link, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; doublegram-linkedin-engine)" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!risposta.ok) return `Non riesco ad aprire il link (errore ${risposta.status}).`;
    const html = await risposta.text();
    const corpo = /<article[\s\S]*?<\/article>/i.exec(html)?.[0] ?? /<body[\s\S]*<\/body>/i.exec(html)?.[0] ?? html;
    const titolo = htmlInTesto(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").trim();
    let testo = htmlInTesto(corpo.replace(/<(script|style|nav|footer|header|aside)[\s\S]*?<\/\1>/gi, " ")).trim();
    if (testo.length < 300) return "Dal link non ho ricavato un testo utilizzabile: incolla il testo dopo \"adatta:\".";
    if (testo.length > config.RSS_MAX_CARATTERI) testo = testo.slice(0, config.RSS_MAX_CARATTERI) + "\n\n[articolo tagliato]";
    const intestazione = [`link: ${link}`, "tipo: newsletter", "---", titolo].filter(Boolean).join("\n");
    fs.writeFileSync(percorsoLibero(cartella, `${base}.md`), `${intestazione}\n\n${testo}\n`, "utf8");
    return conferma;
  }

  if (resto.length >= 80) {
    // Il testo può iniziare con "autore: Nome" e "link: …" (vedi leggiTestoSorgente).
    fs.writeFileSync(percorsoLibero(cartella, `${base}.txt`), resto + "\n", "utf8");
    return conferma;
  }
  return "Dopo \"adatta\" metti uno screenshot, un link a un articolo o il testo del post (almeno qualche riga).";
}

export interface ServizioComandi {
  config: Config;
  log: Logger;
}

/**
 * Gestisce un messaggio ricevuto nel gruppo. Ignora in silenzio tutto ciò che non è una risposta
 * a una bozza inviata dal sistema e contenente un comando.
 */
export async function gestisciMessaggio(srv: ServizioComandi, msg: MessaggioRicevuto, chiave: string): Promise<void> {
  const { config, log } = srv;
  const openwa = configOpenWA(config);
  const chat = msg.chatId ?? msg.from;
  if (chat !== openwa.gruppo) return;

  const statoComandi = caricaStatoComandi();
  if (statoComandi.elaborati.includes(chiave)) return; // consegna duplicata
  const registri = [caricaStato().messaggi, statoComandi.messaggi];

  // Con il numero personale arrivano (come message.sent) anche i messaggi spediti dal motore stesso:
  // quelli che coincidono con un testo inviato dal sistema vanno ignorati, per non reagire a sé stessi.
  if (msg.fromMe && msg.body) {
    const inizio = inizioTesto(msg.body);
    if (registri.some((r) => Object.values(r).some((m) => m.inizio && m.inizio === inizio))) return;
  }

  if (!msg.quotedMessage && INIZIO_ADATTA.test(msg.body ?? "")) {
    const giorno = oggi();
    if ((statoComandi.perGiorno[giorno] ?? 0) >= config.COMANDI_MAX_GIORNO) {
      log.avviso(`Tetto di ${config.COMANDI_MAX_GIORNO} comandi al giorno raggiunto: ignoro una nuova fonte`);
      return;
    }
    statoComandi.elaborati.push(chiave);
    statoComandi.perGiorno[giorno] = (statoComandi.perGiorno[giorno] ?? 0) + 1;
    salvaStatoComandi(statoComandi);
    let risposta: string;
    try {
      risposta = await aggiungiFonte(config, openwa, msg, chat);
    } catch (e) {
      risposta = `Non sono riuscito ad aggiungere la fonte (${descriviErrore(e)}).`;
    }
    log.info(`Fonte dal gruppo: ${risposta}`);
    await inviaTesto(openwa, risposta, msg.id ? { quotedMessageId: msg.id } : {}).catch(async () => {
      await inviaTesto(openwa, risposta);
    });
    return;
  }

  if (!msg.quotedMessage || !msg.body) return;
  const riferimento = trovaRiferimento(msg.quotedMessage, registri);
  if (!riferimento) return;

  const comando = interpretaComando(msg.body);
  if (!comando) return;

  statoComandi.elaborati.push(chiave);
  salvaStatoComandi(statoComandi);

  const rispondi = async (testo: string, parte: MessaggioInviato["parte"], cita = true) => {
    let id: string | undefined;
    try {
      id = await inviaTesto(openwa, testo, cita && msg.id ? { quotedMessageId: msg.id } : {});
    } catch (e) {
      if (!cita) throw e;
      // Se la citazione non è risolvibile, OpenWA rifiuta l'invio: lo rimando senza citazione.
      log.avviso(`Risposta citata non inviata (${descriviErrore(e)}), la mando senza citazione`);
      id = await inviaTesto(openwa, testo);
    }
    if (id) {
      const s = caricaStatoComandi();
      s.messaggi[id] = { bozza: riferimento.bozza, parte, inizio: inizioTesto(testo), data: new Date().toISOString() };
      salvaStatoComandi(s);
    }
  };

  if (comando.tipo === "aiuto") {
    await rispondi(AIUTO, riferimento.parte);
    return;
  }

  const giorno = oggi();
  const fatti = statoComandi.perGiorno[giorno] ?? 0;
  if (fatti >= config.COMANDI_MAX_GIORNO) {
    log.avviso(`Tetto di ${config.COMANDI_MAX_GIORNO} comandi al giorno raggiunto: ignoro "${msg.body}"`);
    return;
  }

  const quale = comando.quale ?? (riferimento.parte === "B" ? "B" : "A");
  const file = trovaBozza(config.SHARED_DIR, riferimento.bozza);
  if (!file) {
    await rispondi(`Non trovo più la bozza ${riferimento.bozza} in 02-bozze/ o 03-approvati/.`, quale);
    return;
  }

  log.info(`Comando su ${riferimento.bozza}, variante ${quale}: "${comando.richiesta}"`);
  try {
    const ctx: Contesto = {
      client: creaClient(config),
      config,
      sharedDir: config.SHARED_DIR,
      lineeGuida: leggiLineeGuida(config.SHARED_DIR),
      log,
    };
    const bozza = leggiBozza(fs.readFileSync(file, "utf8"));
    const sorgente = caricaSorgente(riferimento.bozza);
    const varianti = { variante_a: bozza.varianteA, variante_b: bozza.varianteB };
    const applica = (testo: string) =>
      quale === "A" ? { ...varianti, variante_a: testo } : { ...varianti, variante_b: testo };

    let nuove = applica(await revisionaVariante(ctx, { sorgente, varianti, quale, richiesta: comando.richiesta }));
    let problemi = await verifica(ctx, sorgente, nuove);
    if (problemi.length > 0) {
      log.info(`Revisione non superata (${problemi.length} problemi), riprovo una volta`);
      nuove = applica(
        await revisionaVariante(ctx, { sorgente, varianti: nuove, quale, richiesta: comando.richiesta, problemi }),
      );
      problemi = await verifica(ctx, sorgente, nuove);
    }

    fs.writeFileSync(
      file,
      componiBozza({
        fonte: bozza.fonte,
        analisi: { formato: bozza.formato, perche_funziona: bozza.perche_funziona },
        problemi,
        segnaposto: segnaposto(nuove),
        sorgente: bozza.sorgente,
        varianteA: nuove.variante_a,
        varianteB: nuove.variante_b,
      }),
      "utf8",
    );

    const s = caricaStatoComandi();
    s.perGiorno[giorno] = (s.perGiorno[giorno] ?? 0) + 1;
    salvaStatoComandi(s);

    const righe = [`✏️ Variante ${quale} riscritta (${riferimento.bozza}).`];
    if (!sorgente) righe.push("Post originale non disponibile: controllati solo lunghezza, emoji e formattazione.");
    if (problemi.length === 0) righe.push("Verifica: ok ✅");
    else righe.push("⚠️ Problemi segnalati dalla verifica:", ...problemi.map((p) => `- ${p}`));
    righe.push("Nel prossimo messaggio il testo nuovo. Puoi rispondere anche a quello per altre modifiche.");
    await rispondi(righe.join("\n"), quale);
    await rispondi(testoSemplice(quale === "A" ? nuove.variante_a : nuove.variante_b), quale, false);
    log.info(`Variante ${quale} di ${riferimento.bozza} aggiornata`);
  } catch (e) {
    log.errore(`Comando non eseguito su ${riferimento.bozza}: ${descriviErrore(e)}`);
    try {
      await rispondi(`Non sono riuscito a riscrivere la variante: ${descriviErrore(e).slice(0, 200)}`, quale);
    } catch (e2) {
      log.errore(`Anche la risposta di errore non è partita: ${descriviErrore(e2)}`);
    }
  }
}

