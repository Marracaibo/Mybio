import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATI_DIR, type Config } from "./config.js";
import type { Logger } from "./log.js";
import { richiesta, type ConfigOpenWA } from "./openwa.js";

/**
 * Memoria del gruppo, protetta: ogni messaggio (e la trascrizione dei vocali) è salvato cifrato con
 * AES-256-GCM in /dati/memoria/messaggi.enc (una riga cifrata per voce, file leggibile solo dal motore).
 * La chiave è MEMORIA_CHIAVE nel .env; se manca ne genero una in /dati/memoria/.chiave (meglio di niente,
 * ma chi ha il disco ha anche la chiave: per una protezione vera va nel .env).
 * Si conservano MEMORIA_GIORNI giorni; /memoria off la sospende, /memoria cancella (con 👍) la svuota.
 * Solo il gruppo configurato: OpenWA filtra già a monte, e qui non entra nient'altro.
 */

export interface Voce {
  id: string;
  data: string;
  autore: string;
  testo: string;
  tipo?: string;
}

interface Riga {
  /** "m" messaggio, "t" trascrizione di un vocale già salvato */
  k: "m" | "t";
  v: Voce;
}

const CARTELLA = path.join(DATI_DIR, "memoria");
const FILE = path.join(CARTELLA, "messaggi.enc");
const FILE_NOMI = path.join(CARTELLA, "nomi.json");
const FILE_STATO = path.join(CARTELLA, "stato.json");

let chiave: Buffer | undefined;
let chiaveDaEnv = false;

function prendiChiave(config: Config): Buffer {
  if (chiave) return chiave;
  fs.mkdirSync(CARTELLA, { recursive: true, mode: 0o700 });
  if (config.MEMORIA_CHIAVE) {
    chiave = crypto.createHash("sha256").update(config.MEMORIA_CHIAVE).digest();
    chiaveDaEnv = true;
  } else {
    const file = path.join(CARTELLA, ".chiave");
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString("base64"), { mode: 0o600 });
    chiave = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
  }
  return chiave;
}

function cifra(k: Buffer, testo: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", k, iv);
  const dati = Buffer.concat([c.update(testo, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), dati]).toString("base64");
}

function decifra(k: Buffer, riga: string): string | undefined {
  try {
    const b = Buffer.from(riga, "base64");
    const d = crypto.createDecipheriv("aes-256-gcm", k, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return undefined; // riga corrotta o chiave diversa
  }
}

interface StatoMemoria {
  attiva: boolean;
  importata?: boolean;
  ultimaPulizia?: string;
}

function stato(): StatoMemoria {
  try {
    return { attiva: true, ...(JSON.parse(fs.readFileSync(FILE_STATO, "utf8")) as Partial<StatoMemoria>) };
  } catch {
    return { attiva: true };
  }
}

function salvaStatoMemoria(s: StatoMemoria): void {
  fs.mkdirSync(CARTELLA, { recursive: true, mode: 0o700 });
  fs.writeFileSync(FILE_STATO, JSON.stringify(s), { mode: 0o600 });
}

const chiaveId = (id: string) => id.split("_")[2] ?? id;

// ---------- Nomi ----------

let nomi: Record<string, string> | undefined;

function caricaNomi(): Record<string, string> {
  if (nomi) return nomi;
  try {
    nomi = JSON.parse(fs.readFileSync(FILE_NOMI, "utf8")) as Record<string, string>;
  } catch {
    nomi = {};
  }
  return nomi;
}

const cifre = (s: string) => s.replace(/@.*/, "").replace(/\D/g, "");

/** Ricorda il nome visualizzato di chi scrive (serve a quiz, approvazioni e memoria). */
export function ricordaNome(idAutore: string | undefined, nome: string | undefined): void {
  if (!idAutore || !nome) return;
  const n = caricaNomi();
  const k = cifre(idAutore) || idAutore;
  if (n[k] === nome) return;
  n[k] = nome;
  fs.mkdirSync(CARTELLA, { recursive: true, mode: 0o700 });
  fs.writeFileSync(FILE_NOMI, JSON.stringify(n), { mode: 0o600 });
}

let titolare = "Titolare del numero";

/** Nome e numero di chi ha collegato il numero (dalla sessione OpenWA). */
export function impostaTitolare(telefono: string | undefined | null, nome: string | undefined | null): void {
  if (nome) titolare = nome;
  if (telefono && nome) ricordaNome(telefono, nome);
}

export function nomeTitolare(): string {
  return titolare;
}

/** Il nome di chi ha questo id WhatsApp, o le ultime cifre del numero. */
export function nomeDi(idAutore: string | undefined): string {
  if (!idAutore) return "qualcuno";
  const k = cifre(idAutore) || idAutore;
  return caricaNomi()[k] ?? `…${k.slice(-4)}`;
}

// ---------- Scrittura ----------

function aggiungi(config: Config, righe: Riga[]): void {
  if (!righe.length) return;
  const k = prendiChiave(config);
  fs.mkdirSync(CARTELLA, { recursive: true, mode: 0o700 });
  fs.appendFileSync(FILE, righe.map((r) => cifra(k, JSON.stringify(r))).join("\n") + "\n", { mode: 0o600 });
}

/** Salva un messaggio del gruppo. */
export function memorizza(config: Config, voce: Voce): void {
  if (config.MEMORIA !== "on" || !stato().attiva || !voce.id) return;
  aggiungi(config, [{ k: "m", v: { ...voce, testo: voce.testo.slice(0, 4000) } }]);
}

/** Aggiunge la trascrizione di un vocale già salvato. */
export function memorizzaTrascrizione(config: Config, id: string, testo: string): void {
  if (config.MEMORIA !== "on" || !stato().attiva) return;
  aggiungi(config, [{ k: "t", v: { id, data: new Date().toISOString(), autore: "", testo: testo.slice(0, 4000) } }]);
}

// ---------- Lettura ----------

function leggiTutto(config: Config): Voce[] {
  if (!fs.existsSync(FILE)) return [];
  const k = prendiChiave(config);
  const perId = new Map<string, Voce>();
  const trascrizioni = new Map<string, string>();
  for (const riga of fs.readFileSync(FILE, "utf8").split("\n")) {
    if (!riga) continue;
    const chiaro = decifra(k, riga);
    if (!chiaro) continue;
    const r = JSON.parse(chiaro) as Riga;
    if (r.k === "t") trascrizioni.set(chiaveId(r.v.id), r.v.testo);
    else perId.set(chiaveId(r.v.id), r.v);
  }
  const voci = [...perId.entries()].map(([k2, v]) => {
    const t = trascrizioni.get(k2);
    return t ? { ...v, testo: `[vocale] ${t}` } : v;
  });
  return voci.sort((a, b) => a.data.localeCompare(b.data));
}

const normalizza = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

const riga = (v: Voce) =>
  `[${new Date(v.data).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" })}] ${v.autore}: ${v.testo.slice(0, 500)}`;

/**
 * Cerca nella memoria: parole (tutte o alcune), periodo, autore. Restituisce i messaggi trovati con
 * un messaggio di contesto prima e dopo, i più pertinenti per primi (al massimo `max`).
 * Senza parole restituisce il periodo (per "cosa ci siamo detti a settembre?").
 */
export function cercaMemoria(
  config: Config,
  q: { parole?: string; da?: string; a?: string; autore?: string; max?: number },
): string {
  if (config.MEMORIA !== "on") return "La memoria del gruppo è disattivata (MEMORIA=off).";
  const tutte = leggiTutto(config);
  if (!tutte.length) return "La memoria è ancora vuota.";
  const max = Math.min(Math.max(q.max ?? 40, 5), 150);
  const da = q.da ? `${q.da}T00:00:00` : "";
  const a = q.a ? `${q.a}T23:59:59` : "￿";
  const autore = q.autore ? normalizza(q.autore) : "";
  const nelPeriodo = tutte.filter((v) => v.data >= da && v.data <= a && (!autore || normalizza(v.autore).includes(autore)));
  const parole = normalizza(q.parole ?? "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((p) => p.length >= 3);
  const intro = `Memoria: ${tutte.length} messaggi dal ${tutte[0]!.data.slice(0, 10)} al ${tutte.at(-1)!.data.slice(0, 10)}.`;
  if (!parole.length) {
    const scelte = nelPeriodo.slice(-max);
    return `${intro} Nel periodo: ${nelPeriodo.length}${nelPeriodo.length > max ? ` (mostro gli ultimi ${max})` : ""}.\n${scelte.map(riga).join("\n")}`;
  }
  const punteggi = nelPeriodo
    .map((v, i) => {
      const t = normalizza(v.testo);
      return { i, p: parole.reduce((s, p) => s + (t.includes(p) ? 1 : 0), 0) };
    })
    .filter((x) => x.p > 0)
    .sort((x, y) => y.p - x.p || y.i - x.i)
    .slice(0, Math.ceil(max / 3));
  if (!punteggi.length) return `${intro} Nessun messaggio con: ${parole.join(", ")}.`;
  const scelti = new Set<number>();
  for (const { i } of punteggi) for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < nelPeriodo.length) scelti.add(j);
  const elenco = [...scelti].sort((x, y) => x - y).map((j) => nelPeriodo[j]!);
  return `${intro} Trovati ${punteggi.length} messaggi pertinenti (con il contesto):\n${elenco.map(riga).join("\n")}`;
}

export function statoMemoria(config: Config): string {
  if (config.MEMORIA !== "on") return "🗄️ La memoria del gruppo è disattivata (MEMORIA=off nel .env).";
  const tutte = leggiTutto(config);
  const s = stato();
  prendiChiave(config);
  return [
    `🗄️ *Memoria del gruppo*: ${s.attiva ? "attiva" : "sospesa"}`,
    `Messaggi: ${tutte.length}${tutte.length ? ` (dal ${tutte[0]!.data.slice(0, 10)})` : ""}`,
    `Protezione: cifratura AES-256-GCM, ${chiaveDaEnv ? "chiave nel .env (MEMORIA_CHIAVE)" : "chiave generata sul server (per più sicurezza mettila nel .env come MEMORIA_CHIAVE)"}`,
    `Conservazione: ${config.MEMORIA_GIORNI} giorni · solo questo gruppo`,
    "",
    "/memoria off · /memoria on · /memoria cancella (con conferma 👍)",
  ].join("\n");
}

export function sospendiMemoria(attiva: boolean): void {
  salvaStatoMemoria({ ...stato(), attiva });
}

export function cancellaMemoria(): void {
  fs.rmSync(FILE, { force: true });
  salvaStatoMemoria({ ...stato(), importata: true });
}

/** Toglie i messaggi più vecchi di MEMORIA_GIORNI (una volta al giorno). */
export function puliziaMemoria(config: Config, log: Logger): void {
  const s = stato();
  const oggi = new Date().toISOString().slice(0, 10);
  if (config.MEMORIA !== "on" || s.ultimaPulizia === oggi || !fs.existsSync(FILE)) return;
  const limite = new Date(Date.now() - config.MEMORIA_GIORNI * 86_400_000).toISOString();
  const k = prendiChiave(config);
  const righe = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean);
  const tenute = righe.filter((r) => {
    const chiaro = decifra(k, r);
    return chiaro ? (JSON.parse(chiaro) as Riga).v.data >= limite : false;
  });
  if (tenute.length !== righe.length) {
    fs.writeFileSync(FILE + ".nuovo", tenute.join("\n") + (tenute.length ? "\n" : ""), { mode: 0o600 });
    fs.renameSync(FILE + ".nuovo", FILE);
    log.info(`Memoria: tolti ${righe.length - tenute.length} messaggi più vecchi di ${config.MEMORIA_GIORNI} giorni`);
  }
  salvaStatoMemoria({ ...s, ultimaPulizia: oggi });
}

/** Al primo avvio importa i messaggi già presenti nel gruppo (fino a 1000), così Jarvis ricorda anche il passato. */
export async function importaStorico(config: Config, openwa: ConfigOpenWA, log: Logger): Promise<void> {
  const s = stato();
  if (config.MEMORIA !== "on" || s.importata) return;
  salvaStatoMemoria({ ...s, importata: true });
  try {
    const storico = (await richiesta(
      openwa,
      "GET",
      `/messages/${encodeURIComponent(openwa.gruppo)}/history?limit=1000&deep=true`,
    )) as Array<{
      id?: string;
      body?: string;
      type?: string;
      fromMe?: boolean;
      author?: string;
      timestamp?: number;
      contact?: { pushName?: string; name?: string };
    }> | null;
    if (!Array.isArray(storico)) return;
    const righe: Riga[] = [];
    for (const m of storico) {
      if (!m.id || !m.timestamp) continue;
      const nome = m.contact?.name ?? m.contact?.pushName;
      if (!m.fromMe) ricordaNome(m.author, nome);
      righe.push({
        k: "m",
        v: {
          id: m.id,
          data: new Date(m.timestamp * 1000).toISOString(),
          autore: m.fromMe ? `${titolare} (o Jarvis)` : (nome ?? nomeDi(m.author)),
          testo: (m.body ?? "").trim() || `[${m.type ?? "messaggio"}]`,
          tipo: m.type,
        },
      });
    }
    aggiungi(config, righe);
    log.info(`Memoria: importati ${righe.length} messaggi già presenti nel gruppo`);
  } catch (e) {
    log.avviso(`Memoria: storico non importato (${e instanceof Error ? e.message : String(e)})`);
  }
}
