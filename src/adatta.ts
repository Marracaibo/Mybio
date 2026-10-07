import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { componiBozza, descriviFonte } from "./bozza.js";
import { preparaCartellaCondivisa, daIgnorare, percorsoLibero, sposta, spostaConMotivo } from "./cartelle.js";
import { chiediJson, creaClient, ErroreServizio } from "./claude.js";
import { CARTELLE, caricaConfig, LINEE_GUIDA, verificaSeparazioneCartelle, type Config } from "./config.js";
import { estraiPost, type PostSorgente } from "./estrazione.js";
import { creaLogger, descriviErrore, type Logger } from "./log.js";
import { promptAdattamento, promptAnalisi, promptVerifica } from "./prompts.js";
import { AdattamentoSchema, AnalisiSchema, VerificaSchema, type Adattamento, type Analisi, type Verifica } from "./schemi.js";
import {
  contaEmoji,
  contaOccorrenze,
  haMarkdown,
  oggi,
  SEGNAPOSTO_AUTORE,
  SEGNAPOSTO_DATO,
  slug,
} from "./testo.js";

const log = creaLogger("adatta");

interface Contesto {
  client: Anthropic;
  config: Config;
  sharedDir: string;
  lineeGuida: string;
  log: Logger;
}

function descriviPost(post: PostSorgente): string {
  return [
    `Autore: ${post.autore ?? "non indicato"}`,
    `Link: ${post.link ?? "non indicato"}`,
    "",
    "--- POST ORIGINALE (inglese) ---",
    post.testo,
    "--- FINE POST ORIGINALE ---",
  ].join("\n");
}

async function analizza(ctx: Contesto, post: PostSorgente): Promise<Analisi> {
  return chiediJson(ctx.client, ctx.config, {
    nome: "analisi",
    ruolo: "controllo",
    system: promptAnalisi(ctx.config, ctx.lineeGuida),
    schema: AnalisiSchema,
    contenuto: [{ type: "text", text: descriviPost(post) }],
  });
}

async function adatta(
  ctx: Contesto,
  post: PostSorgente,
  analisi: Analisi,
  precedente?: { varianti: Adattamento; problemi: string[] },
): Promise<Adattamento> {
  const parti = [
    descriviPost(post),
    "",
    "--- ANALISI STRUTTURALE ---",
    JSON.stringify(analisi, null, 2),
  ];
  if (analisi.idea_originale_di_autore) {
    parti.push(
      "",
      `L'idea centrale è dell'autore originale: citalo in entrambe le varianti` +
        (post.autore ? ` (${post.autore}).` : ` (nome non noto: usa ${SEGNAPOSTO_AUTORE}).`),
    );
  }
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

/** Controlli deterministici, che non dipendono dal giudizio del modello. */
function controlliLocali(config: Config, varianti: Adattamento): string[] {
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

function elencoProblemi(verifica: Verifica, locali: string[]): string[] {
  const problemi = [...verifica.problemi];
  if (verifica.traduzione_letterale && !problemi.some((p) => /trad[ou]/i.test(p))) {
    problemi.push("Contiene frasi tradotte dall'originale");
  }
  for (const n of verifica.numeri_non_verificati) {
    if (!problemi.some((p) => p.includes(n))) problemi.push(`Dato non presente nelle linee guida: ${n}`);
  }
  if (verifica.citazione_mancante && !problemi.some((p) => /cit/i.test(p))) {
    problemi.push("Manca la citazione dell'autore originale");
  }
  for (const p of locali) if (!problemi.includes(p)) problemi.push(p);
  return problemi;
}

async function verifica(
  ctx: Contesto,
  post: PostSorgente,
  analisi: Analisi,
  varianti: Adattamento,
): Promise<string[]> {
  const testo = [
    descriviPost(post),
    "",
    "--- ANALISI STRUTTURALE ---",
    JSON.stringify(analisi, null, 2),
    "",
    `--- VARIANTE A (${varianti.variante_a.length} caratteri) ---`,
    varianti.variante_a,
    "",
    `--- VARIANTE B (${varianti.variante_b.length} caratteri) ---`,
    varianti.variante_b,
  ].join("\n");
  const esito = await chiediJson(ctx.client, ctx.config, {
    nome: "verifica",
    ruolo: "controllo",
    system: promptVerifica(ctx.config, ctx.lineeGuida),
    schema: VerificaSchema,
    contenuto: [{ type: "text", text: testo }],
  });
  return elencoProblemi(esito, controlliLocali(ctx.config, varianti));
}

function segnaposto(varianti: Adattamento): string[] {
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

async function elaboraFile(ctx: Contesto, file: string): Promise<void> {
  const nome = path.basename(file);
  ctx.log.info(`Elaboro ${nome}`);

  const post = await estraiPost(ctx.client, ctx.config, file);
  const analisi = await analizza(ctx, post);

  if (!analisi.adatto) {
    const motivo = [
      `Scartato: ${analisi.motivo_scarto ?? "non adatto al profilo sales"}`,
      "",
      `Fonte: ${descriviFonte(post.autore, post.link)}`,
      `Formato: ${analisi.formato}`,
    ].join("\n");
    spostaConMotivo(file, path.join(ctx.sharedDir, CARTELLE.scartati), motivo);
    ctx.log.info(`Scartato ${nome}: ${analisi.motivo_scarto ?? "non adatto"}`);
    return;
  }

  let varianti = await adatta(ctx, post, analisi);
  let problemi = await verifica(ctx, post, analisi, varianti);
  if (problemi.length > 0) {
    ctx.log.info(`${nome}: verifica non superata (${problemi.length} problemi), rigenero una volta`);
    varianti = await adatta(ctx, post, analisi, { varianti, problemi });
    problemi = await verifica(ctx, post, analisi, varianti);
  }

  const cartellaBozze = path.join(ctx.sharedDir, CARTELLE.bozze);
  const titolo = slug(post.autore ? `${post.autore} ${analisi.formato}` : varianti.variante_a);
  const destinazione = percorsoLibero(cartellaBozze, `${oggi()}_${titolo}.md`);
  const contenuto = componiBozza({
    fonte: descriviFonte(post.autore, post.link),
    analisi,
    problemi,
    segnaposto: segnaposto(varianti),
    sorgente: nome,
    varianteA: varianti.variante_a,
    varianteB: varianti.variante_b,
  });
  fs.writeFileSync(destinazione, contenuto, "utf8");
  sposta(file, path.join(ctx.sharedDir, CARTELLE.elaborati));

  const esito = problemi.length === 0 ? "verifica ok" : `con ${problemi.length} problemi segnalati`;
  ctx.log.info(`Bozza creata: ${path.basename(destinazione)} (${esito})`);
}

async function main(): Promise<number> {
  const config = caricaConfig();
  const sharedDir = config.SHARED_DIR;
  verificaSeparazioneCartelle(sharedDir);
  const { lineeGuidaCreate } = preparaCartellaCondivisa(sharedDir);
  if (lineeGuidaCreate) {
    log.avviso(`Ho creato ${LINEE_GUIDA} di esempio in ${sharedDir}: compilalo prima di usare le bozze.`);
  }
  const lineeGuida = fs.readFileSync(path.join(sharedDir, LINEE_GUIDA), "utf8");
  if (lineeGuida.includes("{{")) {
    log.avviso(`${LINEE_GUIDA} contiene ancora campi da compilare ({{…}}): le bozze saranno meno precise.`);
  }

  const cartellaInput = path.join(sharedDir, CARTELLE.daAdattare);
  const file = fs
    .readdirSync(cartellaInput, { withFileTypes: true })
    .filter((d) => d.isFile() && !daIgnorare(d.name))
    .map((d) => path.join(cartellaInput, d.name))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);

  if (file.length === 0) {
    log.info("Nessun file nuovo in 01-da-adattare/");
    return 0;
  }

  const client = creaClient(config);
  const ctx: Contesto = { client, config, sharedDir, lineeGuida, log };
  let ok = 0;
  let falliti = 0;

  for (const [i, f] of file.entries()) {
    try {
      await elaboraFile(ctx, f);
      ok++;
    } catch (e) {
      if (e instanceof ErroreServizio) {
        // Non è colpa del file: lo lascio in coda insieme agli altri e riprovo al giro successivo.
        log.errore(`${descriviErrore(e)}. Interrompo: ${file.length - i} file restano in coda.`);
        return 1;
      }
      falliti++;
      const motivo = descriviErrore(e);
      log.errore(`${path.basename(f)} spostato in _errori/: ${motivo}`);
      try {
        if (fs.existsSync(f)) spostaConMotivo(f, path.join(sharedDir, CARTELLE.errori), `Errore: ${motivo}`);
      } catch (e2) {
        log.errore(`Impossibile spostare ${path.basename(f)} in _errori/: ${descriviErrore(e2)}`);
      }
    }
  }

  log.info(`Fine: ${ok} elaborati, ${falliti} in errore.`);
  return 0;
}

main().then(
  (codice) => process.exit(codice),
  (e: unknown) => {
    log.errore(descriviErrore(e));
    process.exit(1);
  },
);
