import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { chiediJson } from "./claude.js";
import { DATI_DIR, LINEE_GUIDA, type Config } from "./config.js";
import type { PostSorgente } from "./estrazione.js";
import type { Logger } from "./log.js";
import { promptAdattamento, promptAnalisi, promptVerifica } from "./prompts.js";
import {
  AdattamentoSchema,
  AnalisiSchema,
  RevisioneSchema,
  VerificaSchema,
  type Adattamento,
  type Analisi,
  type Verifica,
} from "./schemi.js";
import { contaEmoji, contaOccorrenze, haMarkdown, SEGNAPOSTO_AUTORE, SEGNAPOSTO_DATO } from "./testo.js";

/** Le chiamate a Claude condivise da `adatta` (Fasi 1-3) e dai comandi nel gruppo (Fase 4). */
export interface Contesto {
  client: Anthropic;
  config: Config;
  sharedDir: string;
  lineeGuida: string;
  log: Logger;
}

export function leggiLineeGuida(sharedDir: string): string {
  return fs.readFileSync(path.join(sharedDir, LINEE_GUIDA), "utf8");
}

export function descriviPost(post: PostSorgente): string {
  const righe = [`Autore: ${post.autore ?? "non indicato"}`, `Link: ${post.link ?? "non indicato"}`];
  if (post.tipo === "newsletter") {
    righe.push(
      "Tipo: articolo di newsletter, non un post LinkedIn. Valuta e riusa l'idea centrale e, se c'è, " +
        "la struttura (hook, sequenza, chiusura); il risultato deve comunque essere un post LinkedIn.",
    );
  }
  righe.push("", "--- POST ORIGINALE (inglese) ---", post.testo, "--- FINE POST ORIGINALE ---");
  return righe.join("\n");
}

function bloccoAnalisi(post: PostSorgente, analisi: Analisi): string[] {
  const parti = ["", "--- ANALISI STRUTTURALE ---", JSON.stringify(analisi, null, 2)];
  if (analisi.idea_originale_di_autore) {
    parti.push(
      "",
      `L'idea centrale è dell'autore originale: va citato in ogni variante` +
        (post.autore ? ` (${post.autore}).` : ` (nome non noto: usa ${SEGNAPOSTO_AUTORE}).`),
    );
  }
  return parti;
}

export async function analizza(ctx: Contesto, post: PostSorgente): Promise<Analisi> {
  return chiediJson(ctx.client, ctx.config, {
    nome: "analisi",
    ruolo: "controllo",
    system: promptAnalisi(ctx.config, ctx.lineeGuida),
    schema: AnalisiSchema,
    contenuto: [{ type: "text", text: descriviPost(post) }],
  });
}

export async function generaVarianti(
  ctx: Contesto,
  post: PostSorgente,
  analisi: Analisi,
  precedente?: { varianti: Adattamento; problemi: string[] },
): Promise<Adattamento> {
  const parti = [descriviPost(post), ...bloccoAnalisi(post, analisi)];
  if (precedente) {
    parti.push(
      "",
      "--- TENTATIVO PRECEDENTE, RESPINTO IN VERIFICA ---",
      `Variante A:\n${precedente.varianti.variante_a}`,
      "",
      `Variante B:\n${precedente.varianti.variante_b}`,
      "",
      "Problemi da correggere:",
      ...precedente.problemi.map((p) => `- ${p}`),
      "",
      "Riscrivi entrambe le varianti risolvendo tutti i problemi.",
    );
  }
  return chiediJson(ctx.client, ctx.config, {
    nome: precedente ? "adattamento (rigenerazione)" : "adattamento",
    ruolo: "scrittura",
    system: promptAdattamento(ctx.config, ctx.lineeGuida),
    schema: AdattamentoSchema,
    contenuto: [{ type: "text", text: parti.join("\n") }],
  });
}

/** Fase 4: riscrive una sola variante secondo la richiesta di chi pubblica. */
export async function revisionaVariante(
  ctx: Contesto,
  dati: {
    sorgente?: { post: PostSorgente; analisi: Analisi };
    varianti: Adattamento;
    quale: "A" | "B";
    richiesta: string;
    problemi?: string[];
  },
): Promise<string> {
  const daRiscrivere = dati.quale === "A" ? dati.varianti.variante_a : dati.varianti.variante_b;
  const altra = dati.quale === "A" ? dati.varianti.variante_b : dati.varianti.variante_a;
  const parti: string[] = dati.sorgente
    ? [descriviPost(dati.sorgente.post), ...bloccoAnalisi(dati.sorgente.post, dati.sorgente.analisi)]
    : ["(Post originale non disponibile: lavora solo sulla variante.)"];
  parti.push(
    "",
    `--- VARIANTE ${dati.quale} DA RISCRIVERE ---`,
    daRiscrivere,
    "",
    "--- ALTRA VARIANTE (solo riferimento, non va riscritta né copiata) ---",
    altra,
    "",
    `Richiesta di chi pubblica: ${dati.richiesta}`,
  );
  if (dati.problemi?.length) {
    parti.push("", "Il tentativo precedente aveva questi problemi, correggili:", ...dati.problemi.map((p) => `- ${p}`));
  }
  const esito = await chiediJson(ctx.client, ctx.config, {
    nome: "revisione",
    ruolo: "scrittura",
    system: promptAdattamento(ctx.config, ctx.lineeGuida, "revisione"),
    schema: RevisioneSchema,
    contenuto: [{ type: "text", text: parti.join("\n") }],
  });
  return esito.testo;
}

/** Controlli deterministici, che non dipendono dal giudizio del modello. */
export function controlliLocali(config: Config, varianti: Adattamento): string[] {
  const problemi: string[] = [];
  const coppie: Array<[string, string]> = [
    ["Variante A", varianti.variante_a],
    ["Variante B", varianti.variante_b],
  ];
  for (const [nome, testo] of coppie) {
    if (!testo.trim()) problemi.push(`${nome}: è vuota`);
    if (testo.length > config.MAX_CARATTERI) {
      problemi.push(`${nome}: ${testo.length} caratteri, oltre il massimo di ${config.MAX_CARATTERI}`);
    }
    const emoji = contaEmoji(testo);
    if (emoji > 3) problemi.push(`${nome}: ${emoji} emoji, il massimo è 3`);
    if (haMarkdown(testo)) problemi.push(`${nome}: contiene formattazione markdown`);
    if (contaOccorrenze(testo.toLowerCase(), "doublegram") > 1) {
      problemi.push(`${nome}: Doublegram è nominato più di una volta`);
    }
  }
  return problemi;
}

function elencoProblemi(verifica: Verifica, locali: string[], varianti: Adattamento): string[] {
  // Il modello a volte elenca anche osservazioni che lui stesso giudica accettabili: restano fuori.
  const problemi = verifica.problemi.filter((p) => p.da_correggere).map((p) => p.testo);
  if (verifica.traduzione_letterale && !problemi.some((p) => /trad[ou]/i.test(p))) {
    problemi.push("Contiene frasi tradotte dall'originale");
  }
  // Il modello a volte riporta numeri dell'originale che nelle varianti non ci sono: si tengono solo quelli presenti.
  const testi = varianti.variante_a + "\n" + varianti.variante_b;
  for (const n of verifica.numeri_non_verificati.filter((n) => n.trim() && testi.includes(n.trim()))) {
    if (!problemi.some((p) => p.includes(n))) problemi.push(`Dato non presente nelle linee guida: ${n}`);
  }
  if (verifica.citazione_mancante && !problemi.some((p) => /cit/i.test(p))) {
    problemi.push("Manca la citazione dell'autore originale");
  }
  for (const p of locali) if (!problemi.includes(p)) problemi.push(p);
  return problemi;
}

/** Chiamata 3 + controlli locali. Senza il post originale restano solo i controlli locali. */
export async function verifica(
  ctx: Contesto,
  sorgente: { post: PostSorgente; analisi: Analisi } | undefined,
  varianti: Adattamento,
): Promise<string[]> {
  const locali = controlliLocali(ctx.config, varianti);
  if (!sorgente) return locali;
  const testo = [
    descriviPost(sorgente.post),
    "",
    "--- ANALISI STRUTTURALE ---",
    JSON.stringify(sorgente.analisi, null, 2),
    "",
    `--- VARIANTE A (${varianti.variante_a.length} caratteri) ---`,
    varianti.variante_a,
    "",
    `--- VARIANTE B (${varianti.variante_b.length} caratteri) ---`,
    varianti.variante_b,
  ].join("\n");
  const esito = await chiediJson(ctx.client, ctx.config, {
    nome: "verifica",
    ruolo: "verifica",
    system: promptVerifica(ctx.config, ctx.lineeGuida),
    schema: VerificaSchema,
    contenuto: [{ type: "text", text: testo }],
  });
  return elencoProblemi(esito, locali, varianti);
}

export function segnaposto(varianti: Adattamento): string[] {
  const risultato: string[] = [];
  for (const [nome, testo] of [
    ["Variante A", varianti.variante_a],
    ["Variante B", varianti.variante_b],
  ] as const) {
    for (const s of [SEGNAPOSTO_DATO, SEGNAPOSTO_AUTORE]) {
      const n = contaOccorrenze(testo, s);
      if (n > 0) risultato.push(`${nome}: ${n} × ${s}`);
    }
  }
  return risultato;
}

/**
 * Copia locale di post originale e analisi per ogni bozza, così i comandi della Fase 4 possono
 * rigenerare e verificare anche dopo che il sorgente è stato spostato. Sta in DATI_DIR, non nel cloud condiviso.
 */
const CARTELLA_SORGENTI = path.join(DATI_DIR, "sorgenti");

export function salvaSorgente(nomeBozza: string, dati: { post: PostSorgente; analisi: Analisi }): void {
  fs.mkdirSync(CARTELLA_SORGENTI, { recursive: true });
  fs.writeFileSync(path.join(CARTELLA_SORGENTI, `${nomeBozza}.json`), JSON.stringify(dati, null, 2), "utf8");
}

export function caricaSorgente(nomeBozza: string): { post: PostSorgente; analisi: Analisi } | undefined {
  const file = path.join(CARTELLA_SORGENTI, `${nomeBozza}.json`);
  if (!fs.existsSync(file)) return undefined;
  const dati = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  const ok = AnalisiSchema.safeParse((dati as { analisi?: unknown })?.analisi);
  const post = (dati as { post?: PostSorgente })?.post;
  return ok.success && post?.testo ? { post, analisi: ok.data } : undefined;
}
