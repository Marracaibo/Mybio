import fs from "node:fs";
import path from "node:path";
import { percorsoLibero, preparaCartellaCondivisa } from "./cartelle.js";
import { CARTELLE, caricaConfig, DATI_DIR, FONTI, verificaSeparazioneCartelle } from "./config.js";
import { leggiFeed, type ElementoFeed } from "./feed.js";
import { creaLogger, descriviErrore } from "./log.js";
import { oggi, slug } from "./testo.js";

const log = creaLogger("rss");

/** Articoli già importati, per feed. Sta nel progetto locale, mai nella cartella condivisa. */
const FILE_VISTI = path.join(DATI_DIR, ".rss-visti.json");
const MAX_ID_PER_FEED = 500;

interface Fonte {
  nome?: string;
  url: string;
}

export function leggiFonti(contenuto: string): Fonte[] {
  const fonti: Fonte[] = [];
  for (const riga of contenuto.replace(/^﻿/, "").split(/\r?\n/)) {
    const r = riga.trim();
    if (!r || r.startsWith("#")) continue;
    const [prima, seconda] = r.split("|").map((p) => p.trim());
    fonti.push(seconda ? { nome: prima, url: seconda } : { url: prima ?? "" });
  }
  return fonti;
}

/** Regola 1: niente LinkedIn, solo feed http(s). */
function controllaUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`indirizzo non valido: ${url}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`protocollo non ammesso: ${url}`);
  if (/(^|\.)linkedin\.com$|(^|\.)lnkd\.in$/i.test(u.hostname)) {
    throw new Error(`i link a LinkedIn non sono ammessi in ${FONTI}: ${url}`);
  }
  return u;
}

function caricaVisti(): Record<string, string[]> {
  if (!fs.existsSync(FILE_VISTI)) return {};
  return JSON.parse(fs.readFileSync(FILE_VISTI, "utf8")) as Record<string, string[]>;
}

function salvaVisti(visti: Record<string, string[]>): void {
  const temporaneo = FILE_VISTI + ".tmp";
  fs.writeFileSync(temporaneo, JSON.stringify(visti, null, 2) + "\n", "utf8");
  fs.renameSync(temporaneo, FILE_VISTI);
}

async function scarica(url: URL): Promise<string> {
  let risposta: Response;
  try {
    risposta = await fetch(url, {
      headers: {
        "User-Agent": "doublegram-linkedin-engine/0.1 (lettore RSS)",
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    const causa = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
    throw new Error(`feed non raggiungibile: ${causa}`);
  }
  if (!risposta.ok) throw new Error(`il feed ha risposto ${risposta.status} ${risposta.statusText}`);
  return risposta.text();
}

function contenutoFile(fonte: Fonte, titoloFeed: string, e: ElementoFeed): string {
  const righe = [`autore: ${fonte.nome ?? e.autore ?? titoloFeed ?? ""}`.trim()];
  if (e.link) righe.push(`link: ${e.link}`);
  righe.push("tipo: newsletter", "---", e.titolo, "", e.testo, "");
  return righe.join("\n");
}

async function main(): Promise<number> {
  const config = caricaConfig();
  const sharedDir = config.SHARED_DIR;
  verificaSeparazioneCartelle(sharedDir);
  preparaCartellaCondivisa(sharedDir);

  const fonti = leggiFonti(fs.readFileSync(path.join(sharedDir, FONTI), "utf8"));
  if (fonti.length === 0) {
    log.info(`Nessun feed in ${FONTI}: niente da fare.`);
    return 0;
  }

  const visti = caricaVisti();
  const limite = Date.now() - config.RSS_GIORNI * 24 * 60 * 60 * 1000;
  const cartellaInput = path.join(sharedDir, CARTELLE.daAdattare);
  let totale = 0;
  let falliti = 0;

  for (const fonte of fonti) {
    const etichetta = fonte.nome ? `${fonte.nome} (${fonte.url})` : fonte.url;
    try {
      const url = controllaUrl(fonte.url);
      const feed = leggiFeed(await scarica(url));
      if (feed.elementi.length === 0) throw new Error("nessun articolo trovato: è davvero un feed RSS o Atom?");

      const giaVisti = new Set(visti[fonte.url] ?? []);
      const nuovi = feed.elementi
        .filter((e) => !giaVisti.has(e.id) && (!e.data || e.data.getTime() >= limite))
        .sort((a, b) => (b.data?.getTime() ?? 0) - (a.data?.getTime() ?? 0))
        .slice(0, config.RSS_MAX_PER_FEED);

      for (const e of nuovi) {
        if (e.testo.trim()) {
          const nome = `rss_${oggi()}_${slug(`${fonte.nome ?? ""} ${e.titolo}`)}.md`;
          const destinazione = percorsoLibero(cartellaInput, nome);
          fs.writeFileSync(destinazione, contenutoFile(fonte, feed.titolo, e), "utf8");
          totale++;
          log.info(`Nuovo da ${etichetta}: ${path.basename(destinazione)}`);
        } else {
          log.avviso(`Articolo senza testo nel feed, saltato: ${e.titolo || e.id}`);
        }
        giaVisti.add(e.id);
      }
      visti[fonte.url] = [...giaVisti].slice(-MAX_ID_PER_FEED);
      salvaVisti(visti);
    } catch (e) {
      // Un feed che non funziona non blocca gli altri.
      falliti++;
      log.errore(`${etichetta}: ${descriviErrore(e)}`);
    }
  }

  log.info(`Fine: ${totale} articoli nuovi in ${CARTELLE.daAdattare}/, ${falliti} feed in errore.`);
  return 0;
}

main().then(
  (codice) => process.exit(codice),
  (e: unknown) => {
    log.errore(descriviErrore(e));
    process.exit(1);
  },
);
