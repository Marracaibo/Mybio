import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

/** Cartella del progetto locale: qui stanno .env, .stato.json e i log. */
export const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

dotenv.config({ path: path.join(PROJECT_DIR, ".env"), quiet: true });

/** Dove stanno stato, log e copie dei sorgenti: di default il progetto locale (in Docker un volume). */
export const DATI_DIR = path.resolve(process.env["DATI_DIR"]?.trim() || PROJECT_DIR);

const orario = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "formato HH:MM");

const vuotoComeAssente = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.preprocess(vuotoComeAssente, z.string().optional()),
  CLAUDE_MODEL: z.preprocess(vuotoComeAssente, z.string().default("claude-sonnet-5-5")),
  CLAUDE_MODEL_CONTROLLI: z.preprocess(vuotoComeAssente, z.string().default("claude-haiku-5-5")),
  CLAUDE_MODEL_VERIFICA: z.preprocess(vuotoComeAssente, z.string().default("claude-sonnet-5-5")),
  CLAUDE_EFFORT_CONTROLLI: z.preprocess(vuotoComeAssente, z.enum(["low", "medium", "high"]).default("low")),
  CLAUDE_FALLBACK: z.preprocess(vuotoComeAssente, z.enum(["default", "off"]).default("default")),
  SHARED_DIR: z.preprocess(vuotoComeAssente, z.string().default("G:\\Il mio Drive\\Doublegram-LinkedIn")),
  PROFILO_NOME: z.preprocess(vuotoComeAssente, z.string().default("[NOME COGNOME]")),
  PROFILO_RUOLO: z.preprocess(vuotoComeAssente, z.string().default("Sales / Partnership @ Doublegram")),
  PROFILO_PUBBLICO: z.preprocess(
    vuotoComeAssente,
    z
      .string()
      .default(
        "admin e owner di community Telegram, progetti crypto, creator, aziende che usano Telegram per il supporto, founder di startup e chi lavora nella vendita B2B",
      ),
  ),
  MAX_CARATTERI: z.preprocess(vuotoComeAssente, z.coerce.number().int().positive().default(1300)),
  OPENWA_URL: z.preprocess(vuotoComeAssente, z.string().default("http://localhost:2785")),
  OPENWA_API_KEY: z.preprocess(vuotoComeAssente, z.string().optional()),
  OPENWA_SESSION: z.preprocess(vuotoComeAssente, z.string().optional()),
  WHATSAPP_GROUP_ID: z.preprocess(vuotoComeAssente, z.string().optional()),
  INVIA_VARIANTE_B: z.preprocess(vuotoComeAssente, z.enum(["true", "false"]).default("true")),
  RSS_MAX_PER_FEED: z.preprocess(vuotoComeAssente, z.coerce.number().int().positive().default(3)),
  RSS_GIORNI: z.preprocess(vuotoComeAssente, z.coerce.number().int().positive().default(7)),
  RSS_MAX_CARATTERI: z.preprocess(vuotoComeAssente, z.coerce.number().int().min(1000).default(20000)),
  // Fase 4: servizio sempre acceso (webhook di OpenWA + pianificazione interna)
  PORTA_SERVIZIO: z.preprocess(vuotoComeAssente, z.coerce.number().int().min(1).max(65535).default(3000)),
  WEBHOOK_URL: z.preprocess(vuotoComeAssente, z.string().url().optional()),
  OPENWA_WEBHOOK_SECRET: z.preprocess(vuotoComeAssente, z.string().min(16, "almeno 16 caratteri").optional()),
  COMANDI_MAX_GIORNO: z.preprocess(vuotoComeAssente, z.coerce.number().int().positive().default(20)),
  // Prototipo dei bot Doublegram su WhatsApp (src/doublegram.ts): /ai, /lookup, Scribe, Security, Shop
  DOUBLEGRAM_BOT: z.preprocess(vuotoComeAssente, z.enum(["true", "false"]).default("true")),
  DOUBLEGRAM_MAX_GIORNO: z.preprocess(vuotoComeAssente, z.coerce.number().int().positive().default(100)),
  GROQ_API_KEY: z.preprocess(vuotoComeAssente, z.string().optional()),
  SCRIBE_URL: z.preprocess(vuotoComeAssente, z.string().default("https://api.groq.com/openai/v1/audio/transcriptions")),
  SCRIBE_MODELLO: z.preprocess(vuotoComeAssente, z.string().default("whisper-large-v3-turbo")),
  PIANIFICAZIONE_INTERNA: z.preprocess(vuotoComeAssente, z.enum(["true", "false"]).default("true")),
  ORARIO_RSS: z.preprocess(vuotoComeAssente, orario.default("07:00")),
  ORARIO_ADATTA: z.preprocess(vuotoComeAssente, orario.default("07:30")),
  ORARIO_INVIA: z.preprocess(vuotoComeAssente, orario.default("08:30")),
});

export type Config = z.infer<typeof EnvSchema>;

export function caricaConfig(): Config {
  const risultato = EnvSchema.safeParse(process.env);
  if (!risultato.success) {
    const dettagli = risultato.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Configurazione non valida nel file .env: ${dettagli}`);
  }
  return risultato.data;
}

export const CARTELLE = {
  daAdattare: "01-da-adattare",
  elaborati: path.join("01-da-adattare", "_elaborati"),
  bozze: "02-bozze",
  approvati: "03-approvati",
  pubblicati: "04-pubblicati",
  scartati: "_scartati",
  errori: "_errori",
} as const;

export const LINEE_GUIDA = "linee-guida.md";
export const FONTI = "fonti.txt";

function contiene(padre: string, figlio: string): boolean {
  const rel = path.relative(path.resolve(padre), path.resolve(figlio));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Regola 6: segreti e dati di sessione solo nel progetto locale.
 * Blocca l'esecuzione se il progetto è dentro la cartella condivisa (o viceversa)
 * o se nella cartella condivisa compaiono file che non dovrebbero esserci.
 */
export function verificaSeparazioneCartelle(sharedDir: string): void {
  if (contiene(sharedDir, PROJECT_DIR) || contiene(PROJECT_DIR, sharedDir) || contiene(sharedDir, DATI_DIR)) {
    throw new Error(
      `SHARED_DIR (${sharedDir}) e la cartella del progetto (${PROJECT_DIR}) non devono essere una dentro l'altra: ` +
        "il file .env e i dati di sessione finirebbero nel cloud.",
    );
  }
  const vietati = [".env", ".stato.json", ".rss-visti.json", ".comandi.json", "openwa-data", ".wwebjs_auth", "rclone.conf"];
  const trovati = vietati.filter((nome) => fs.existsSync(path.join(sharedDir, nome)));
  if (trovati.length > 0) {
    throw new Error(
      `Nella cartella condivisa ci sono file riservati (${trovati.join(", ")}). ` +
        "Spostali nella cartella del progetto locale e rimuovili da SHARED_DIR prima di continuare.",
    );
  }
}
