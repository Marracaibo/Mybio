import fs from "node:fs";
import path from "node:path";
import { PROJECT_DIR } from "./config.js";

/** Stato locale degli invii: sta nella cartella del progetto, mai in quella condivisa. */
export interface Stato {
  /** Per nome file della bozza: quanti messaggi sono già partiti e se l'invio è completo. */
  bozze: Record<string, { messaggiInviati: number; completata: boolean; aggiornato: string }>;
  /** Messaggi WhatsApp inviati per giorno (AAAA-MM-GG). */
  messaggiPerGiorno: Record<string, number>;
}

const FILE_STATO = path.join(PROJECT_DIR, ".stato.json");

export function caricaStato(): Stato {
  if (!fs.existsSync(FILE_STATO)) return { bozze: {}, messaggiPerGiorno: {} };
  const dati = JSON.parse(fs.readFileSync(FILE_STATO, "utf8")) as Partial<Stato>;
  return { bozze: dati.bozze ?? {}, messaggiPerGiorno: dati.messaggiPerGiorno ?? {} };
}

export function salvaStato(stato: Stato): void {
  // Tengo solo gli ultimi 30 giorni di contatori.
  const giorni = Object.keys(stato.messaggiPerGiorno).sort();
  for (const g of giorni.slice(0, Math.max(0, giorni.length - 30))) delete stato.messaggiPerGiorno[g];
  const temporaneo = FILE_STATO + ".tmp";
  fs.writeFileSync(temporaneo, JSON.stringify(stato, null, 2) + "\n", "utf8");
  fs.renameSync(temporaneo, FILE_STATO);
}
