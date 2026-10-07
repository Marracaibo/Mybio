import fs from "node:fs";
import path from "node:path";
import { PROJECT_DIR } from "./config.js";

const LOG_DIR = path.join(PROJECT_DIR, "logs");

function scrivi(livello: "INFO" | "AVVISO" | "ERRORE", comando: string, messaggio: string): void {
  const ora = new Date();
  const riga = `${ora.toISOString()} [${comando}] ${livello} ${messaggio}`;
  if (livello === "ERRORE") console.error(riga);
  else console.log(riga);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${ora.toISOString().slice(0, 7)}.log`);
    fs.appendFileSync(file, riga + "\n", "utf8");
  } catch {
    // Un log non scrivibile non deve fermare la pipeline.
  }
}

export function creaLogger(comando: string) {
  return {
    info: (m: string) => scrivi("INFO", comando, m),
    avviso: (m: string) => scrivi("AVVISO", comando, m),
    errore: (m: string) => scrivi("ERRORE", comando, m),
  };
}

export type Logger = ReturnType<typeof creaLogger>;

export function descriviErrore(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
