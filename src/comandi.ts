import fs from "node:fs";
import path from "node:path";
import { componiBozza, leggiBozza } from "./bozza.js";
import { creaClient } from "./claude.js";
import { CARTELLE, type Config } from "./config.js";
import { descriviErrore, type Logger } from "./log.js";
import { configOpenWA, inviaTesto } from "./openwa.js";
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

/** Il messaggio che arriva da OpenWA con l'evento message.received (solo i campi che usiamo). */
export interface MessaggioRicevuto {
  id?: string;
  chatId?: string;
  from?: string;
  body?: string;
  fromMe?: boolean;
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
  if (msg.fromMe || chat !== openwa.gruppo || !msg.quotedMessage || !msg.body) return;

  const statoComandi = caricaStatoComandi();
  if (statoComandi.elaborati.includes(chiave)) return; // consegna duplicata
  const registri = [caricaStato().messaggi, statoComandi.messaggi];
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

