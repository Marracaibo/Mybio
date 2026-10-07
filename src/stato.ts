import fs from "node:fs";
import path from "node:path";
import { DATI_DIR } from "./config.js";

/** Un messaggio mandato nel gruppo, per riconoscere a quale bozza si riferisce una risposta. */
export interface MessaggioInviato {
  bozza: string;
  parte: "contesto" | "A" | "B";
  /** Inizio del testo, per riconoscere la citazione anche se l'id cambia formato. */
  inizio: string;
  data: string;
}

/** Stato locale degli invii: sta nel progetto locale (DATI_DIR), mai nella cartella condivisa. */
export interface Stato {
  /** Per nome file della bozza: quanti messaggi sono già partiti e se l'invio è completo. */
  bozze: Record<string, { messaggiInviati: number; completata: boolean; aggiornato: string }>;
  /** Messaggi WhatsApp inviati per giorno (AAAA-MM-GG). */
  messaggiPerGiorno: Record<string, number>;
  /** Id dei messaggi inviati da `invia` (scritto solo da invia). */
  messaggi: Record<string, MessaggioInviato>;
}

/** Stato del servizio comandi (scritto solo dal servizio, così non si sovrascrive con invia). */
export interface StatoComandi {
  /** Id dei messaggi inviati in risposta ai comandi. */
  messaggi: Record<string, MessaggioInviato>;
  /** Comandi eseguiti per giorno, per il tetto di sicurezza. */
  perGiorno: Record<string, number>;
  /** Chiavi di idempotenza dei webhook già elaborati. */
  elaborati: string[];
}

const FILE_STATO = path.join(DATI_DIR, ".stato.json");
const FILE_COMANDI = path.join(DATI_DIR, ".comandi.json");
const MAX_MESSAGGI = 300;

function leggiJson<T>(file: string): Partial<T> {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8")) as Partial<T>;
}

function scriviJson(file: string, dati: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporaneo = file + ".tmp";
  fs.writeFileSync(temporaneo, JSON.stringify(dati, null, 2) + "\n", "utf8");
  fs.renameSync(temporaneo, file);
}

/** Tiene solo le ultime `n` chiavi (in ordine di inserimento). */
function ultime<T>(record: Record<string, T>, n: number): Record<string, T> {
  return Object.fromEntries(Object.entries(record).slice(-n));
}

function ultimiGiorni(record: Record<string, number>, n = 30): void {
  const giorni = Object.keys(record).sort();
  for (const g of giorni.slice(0, Math.max(0, giorni.length - n))) delete record[g];
}

export function caricaStato(): Stato {
  const dati = leggiJson<Stato>(FILE_STATO);
  return { bozze: dati.bozze ?? {}, messaggiPerGiorno: dati.messaggiPerGiorno ?? {}, messaggi: dati.messaggi ?? {} };
}

export function salvaStato(stato: Stato): void {
  ultimiGiorni(stato.messaggiPerGiorno);
  stato.messaggi = ultime(stato.messaggi, MAX_MESSAGGI);
  scriviJson(FILE_STATO, stato);
}

export function caricaStatoComandi(): StatoComandi {
  const dati = leggiJson<StatoComandi>(FILE_COMANDI);
  return { messaggi: dati.messaggi ?? {}, perGiorno: dati.perGiorno ?? {}, elaborati: dati.elaborati ?? [] };
}

export function salvaStatoComandi(stato: StatoComandi): void {
  ultimiGiorni(stato.perGiorno);
  stato.messaggi = ultime(stato.messaggi, MAX_MESSAGGI);
  stato.elaborati = stato.elaborati.slice(-500);
  scriviJson(FILE_COMANDI, stato);
}
