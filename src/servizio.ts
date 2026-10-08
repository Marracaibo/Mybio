import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { gestisciMessaggio, type MessaggioRicevuto } from "./comandi.js";
import { gestisciDoublegram } from "./doublegram.js";
import { controllaPromemoria } from "./schiavo.js";
import { caricaConfig, DATI_DIR, PROJECT_DIR, verificaSeparazioneCartelle, type Config } from "./config.js";
import { creaLogger, descriviErrore } from "./log.js";
import { citazioneDaStorico, configOpenWA, inviatoDaQui } from "./openwa.js";
import { oggi } from "./testo.js";

/**
 * Servizio sempre acceso (Fase 4):
 * - riceve dal webhook di OpenWA i messaggi del gruppo e riscrive le bozze su richiesta;
 * - se PIANIFICAZIONE_INTERNA=true lancia rss, adatta e invia agli orari configurati
 *   (al posto dell'Utilità di pianificazione di Windows, utile soprattutto in cloud).
 * Tutto passa da un'unica coda, così due lavori non toccano mai le stesse bozze insieme.
 */

const log = creaLogger("servizio");
const PERCORSO_WEBHOOK = "/webhook/openwa";
const MAX_CORPO = 8 * 1024 * 1024; // gli screenshot arrivano dentro il webhook (base64)
/** Se il servizio riparte dopo l'orario previsto, recupera il lavoro solo entro questa finestra. */
const ORE_RECUPERO = 3;
const FILE_PIANIFICAZIONE = path.join(DATI_DIR, ".servizio.json");

type Lavoro = "rss" | "adatta" | "invia";

let coda: Promise<void> = Promise.resolve();
function inCoda(nome: string, fn: () => Promise<void>): void {
  coda = coda.then(fn).catch((e: unknown) => log.errore(`${nome}: ${descriviErrore(e)}`));
}

function eseguiComando(lavoro: Lavoro, argomenti: string[] = []): Promise<void> {
  return new Promise((risolvi) => {
    log.info(`Avvio ${lavoro}`);
    const figlio = spawn(process.execPath, ["--import", "tsx", path.join(PROJECT_DIR, "src", `${lavoro}.ts`), ...argomenti], {
      cwd: PROJECT_DIR,
      stdio: "inherit",
      env: process.env,
    });
    figlio.on("error", (e) => {
      log.errore(`${lavoro} non partito: ${descriviErrore(e)}`);
      risolvi();
    });
    figlio.on("exit", (codice) => {
      if (codice === 0) log.info(`${lavoro} finito`);
      else log.errore(`${lavoro} finito con codice ${codice}`);
      risolvi();
    });
  });
}

// ---------- Pianificazione interna ----------

function leggiUltimeEsecuzioni(): Partial<Record<Lavoro, string>> {
  try {
    return JSON.parse(fs.readFileSync(FILE_PIANIFICAZIONE, "utf8")) as Partial<Record<Lavoro, string>>;
  } catch {
    return {};
  }
}

function segnaEseguito(lavoro: Lavoro, giorno: string): void {
  const dati = { ...leggiUltimeEsecuzioni(), [lavoro]: giorno };
  fs.mkdirSync(DATI_DIR, { recursive: true });
  fs.writeFileSync(FILE_PIANIFICAZIONE, JSON.stringify(dati, null, 2) + "\n", "utf8");
}

function minutiDelGiorno(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

function avviaPianificazione(config: Config): void {
  const orari: Array<[Lavoro, string]> = [
    ["rss", config.ORARIO_RSS],
    ["adatta", config.ORARIO_ADATTA],
    ["invia", config.ORARIO_INVIA],
  ];
  const inAttesa = new Set<Lavoro>();

  const controlla = () => {
    const ora = new Date();
    const giorno = oggi(ora);
    const ultime = leggiUltimeEsecuzioni();
    for (const [lavoro, hhmm] of orari) {
      if (ultime[lavoro] === giorno || inAttesa.has(lavoro)) continue;
      const [h, m] = hhmm.split(":").map(Number);
      const previsto = (h ?? 0) * 60 + (m ?? 0);
      const adesso = minutiDelGiorno(ora);
      if (adesso < previsto) continue;
      if (adesso - previsto > ORE_RECUPERO * 60) {
        // Troppo tardi per oggi (es. servizio avviato nel pomeriggio): niente invii a sorpresa.
        log.info(`${lavoro}: orario ${hhmm} passato da più di ${ORE_RECUPERO} ore, salto a domani`);
        segnaEseguito(lavoro, giorno);
        continue;
      }
      inAttesa.add(lavoro);
      inCoda(lavoro, async () => {
        segnaEseguito(lavoro, giorno);
        await eseguiComando(lavoro);
        inAttesa.delete(lavoro);
      });
    }
  };

  controlla();
  setInterval(controlla, 20_000).unref();
  log.info(
    `Pianificazione interna attiva (fuso ${Intl.DateTimeFormat().resolvedOptions().timeZone}): ` +
      orari.map(([l, o]) => `${l} ${o}`).join(", "),
  );
}

// ---------- Webhook di OpenWA ----------

function firmaValida(corpo: Buffer, intestazione: string | undefined, segreto: string): boolean {
  if (typeof intestazione !== "string") return false;
  const atteso = "sha256=" + crypto.createHmac("sha256", segreto).update(corpo).digest("hex");
  const a = Buffer.from(intestazione);
  const b = Buffer.from(atteso);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function leggiCorpo(req: http.IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((risolvi, rifiuta) => {
    const pezzi: Buffer[] = [];
    let totale = 0;
    req.on("data", (p: Buffer) => {
      totale += p.length;
      if (totale > MAX_CORPO) {
        risolvi(undefined);
        req.destroy();
        return;
      }
      pezzi.push(p);
    });
    req.on("end", () => risolvi(Buffer.concat(pezzi)));
    req.on("error", rifiuta);
  });
}

function avviaServer(config: Config): http.Server {
  const segreto = config.OPENWA_WEBHOOK_SECRET;
  if (!segreto) {
    log.avviso("OPENWA_WEBHOOK_SECRET non impostato: il webhook accetta richieste non firmate. Impostalo in produzione.");
  }

  const server = http.createServer(async (req, res) => {
    const rispondi = (codice: number, corpo: unknown) => {
      res.writeHead(codice, { "Content-Type": "application/json" });
      res.end(JSON.stringify(corpo));
    };
    try {
      const url = new URL(req.url ?? "/", "http://servizio");
      if (req.method === "GET" && url.pathname === "/salute") {
        rispondi(200, { ok: true, ultimeEsecuzioni: leggiUltimeEsecuzioni() });
        return;
      }
      if (req.method !== "POST" || url.pathname !== PERCORSO_WEBHOOK) {
        rispondi(404, { errore: "non trovato" });
        return;
      }
      const corpo = await leggiCorpo(req);
      if (!corpo) {
        rispondi(413, { errore: "corpo troppo grande" });
        return;
      }
      if (segreto && !firmaValida(corpo, req.headers["x-openwa-signature"] as string | undefined, segreto)) {
        log.avviso("Webhook con firma non valida, scartato");
        rispondi(401, { errore: "firma non valida" });
        return;
      }
      let evento: { event?: string; idempotencyKey?: string; data?: MessaggioRicevuto };
      try {
        evento = JSON.parse(corpo.toString("utf8")) as typeof evento;
      } catch {
        rispondi(400, { errore: "JSON non valido" });
        return;
      }
      // Rispondo subito: OpenWA non deve aspettare Claude (e ritenterebbe la consegna).
      rispondi(200, { ricevuto: true });

      if ((evento.event !== "message.received" && evento.event !== "message.sent") || !evento.data) return;
      const chiave =
        (req.headers["x-openwa-idempotency-key"] as string | undefined) ?? evento.idempotencyKey ?? evento.data.id ?? "";
      const messaggio = evento.data;
      inCoda("comando", async () => {
        // Risposte citate scritte dal numero collegato: la citazione va letta dallo storico (vedi citazioneDaStorico).
        const openwa = configOpenWA(config);
        const chat = messaggio.chatId ?? messaggio.from;
        if (
          messaggio.fromMe &&
          !messaggio.quotedMessage &&
          messaggio.id &&
          chat === openwa.gruppo &&
          (messaggio.body ?? "").trim() &&
          !(messaggio.body ?? "").trim().startsWith("/") &&
          !inviatoDaQui(messaggio.body ?? "")
        ) {
          messaggio.quotedMessage = await citazioneDaStorico(openwa, chat, messaggio.id).catch((e) => {
            log.avviso(`Citazione non letta dallo storico: ${descriviErrore(e)}`);
            return undefined;
          });
        }
        // Prima i bot Doublegram (comandi /…, vocali, Security); se non lo riguardano, il motore LinkedIn.
        if (await gestisciDoublegram({ config, log }, messaggio, chiave)) return;
        const dopo = await gestisciMessaggio({ config, log }, messaggio, chiave);
        // Lavori chiesti dal gruppo: nella stessa coda della pianificazione, mai in parallelo.
        if (dopo?.tipo === "invia") await eseguiComando("invia", ["--subito"]);
        if (dopo?.tipo === "adatta-e-invia") {
          await eseguiComando("adatta");
          await eseguiComando("invia", ["--subito", `--sorgente=${dopo.sorgente}`]);
        }
      });
    } catch (e) {
      log.errore(`Richiesta non gestita: ${descriviErrore(e)}`);
      if (!res.headersSent) rispondi(500, { errore: "errore interno" });
    }
  });

  server.listen(config.PORTA_SERVIZIO, () => {
    log.info(`In ascolto sulla porta ${config.PORTA_SERVIZIO}: webhook su ${PERCORSO_WEBHOOK}, stato su /salute`);
  });
  return server;
}

function main(): void {
  const config = caricaConfig();
  verificaSeparazioneCartelle(config.SHARED_DIR);
  configOpenWA(config); // fallisce subito se OpenWA non è configurato
  const server = avviaServer(config);
  if (config.PIANIFICAZIONE_INTERNA === "true") avviaPianificazione(config);
  else log.info("Pianificazione interna disattivata (PIANIFICAZIONE_INTERNA=false): solo webhook.");
  // Promemoria del maggiordomo (/schiavo ricordami…)
  if (config.DOUBLEGRAM_BOT === "true") {
    const openwa = configOpenWA(config);
    setInterval(() => void controllaPromemoria(openwa, log).catch((e) => log.errore(`Promemoria: ${descriviErrore(e)}`)), 30_000).unref();
  }

  const chiudi = () => {
    log.info("Arresto del servizio");
    server.close();
    void coda.finally(() => process.exit(0));
  };
  process.on("SIGTERM", chiudi);
  process.on("SIGINT", chiudi);
}

try {
  main();
} catch (e) {
  log.errore(descriviErrore(e));
  process.exit(1);
}
