import fs from "node:fs";
import path from "node:path";
import { CARTELLE, LINEE_GUIDA, PROJECT_DIR } from "./config.js";

/** Crea la struttura della cartella condivisa e copia il modello di linee-guida.md se manca. */
export function preparaCartellaCondivisa(sharedDir: string): { lineeGuidaCreate: boolean } {
  if (!fs.existsSync(sharedDir)) {
    throw new Error(`La cartella condivisa non esiste: ${sharedDir} (controlla SHARED_DIR nel file .env)`);
  }
  for (const rel of Object.values(CARTELLE)) {
    fs.mkdirSync(path.join(sharedDir, rel), { recursive: true });
  }
  const lineeGuida = path.join(sharedDir, LINEE_GUIDA);
  if (!fs.existsSync(lineeGuida)) {
    fs.copyFileSync(path.join(PROJECT_DIR, "modello-cartella-condivisa", LINEE_GUIDA), lineeGuida);
    return { lineeGuidaCreate: true };
  }
  return { lineeGuidaCreate: false };
}

/** File da ignorare: temporanei di Drive/Office, nascosti, desktop.ini. */
export function daIgnorare(nome: string): boolean {
  const n = nome.toLowerCase();
  return n.startsWith(".") || n.startsWith("~$") || n === "desktop.ini" || n.endsWith(".tmp") || n.endsWith(".motivo.txt");
}

/** Restituisce un percorso libero nella cartella, aggiungendo -2, -3… se il nome è già usato. */
export function percorsoLibero(cartella: string, nome: string): string {
  const ext = path.extname(nome);
  const base = path.basename(nome, ext);
  let candidato = path.join(cartella, nome);
  for (let i = 2; fs.existsSync(candidato); i++) {
    candidato = path.join(cartella, `${base}-${i}${ext}`);
  }
  return candidato;
}

/** Sposta un file (anche tra dischi diversi) senza sovrascrivere nulla. Restituisce il nuovo percorso. */
export function sposta(file: string, cartellaDestinazione: string): string {
  fs.mkdirSync(cartellaDestinazione, { recursive: true });
  const destinazione = percorsoLibero(cartellaDestinazione, path.basename(file));
  try {
    fs.renameSync(file, destinazione);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    fs.copyFileSync(file, destinazione);
    fs.unlinkSync(file);
  }
  return destinazione;
}

/** Sposta il file e gli affianca un `<nome>.motivo.txt` con la spiegazione. */
export function spostaConMotivo(file: string, cartellaDestinazione: string, motivo: string): string {
  const destinazione = sposta(file, cartellaDestinazione);
  const motivoFile = destinazione + ".motivo.txt";
  const testo = `File: ${path.basename(file)}\nData: ${new Date().toISOString()}\n\n${motivo.trim()}\n`;
  fs.writeFileSync(motivoFile, testo, "utf8");
  return destinazione;
}
