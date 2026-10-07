import fs from "node:fs";
import path from "node:path";
import { componiBozza, descriviFonte } from "./bozza.js";
import { preparaCartellaCondivisa, daIgnorare, percorsoLibero, sposta, spostaConMotivo } from "./cartelle.js";
import { creaClient, ErroreServizio } from "./claude.js";
import { CARTELLE, caricaConfig, LINEE_GUIDA, verificaSeparazioneCartelle } from "./config.js";
import { estraiPost } from "./estrazione.js";
import { creaLogger, descriviErrore } from "./log.js";
import {
  analizza,
  generaVarianti,
  leggiLineeGuida,
  salvaSorgente,
  segnaposto,
  verifica,
  type Contesto,
} from "./pipeline.js";
import { oggi, slug } from "./testo.js";

const log = creaLogger("adatta");

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

  const sorgente = { post, analisi };
  let varianti = await generaVarianti(ctx, post, analisi);
  let problemi = await verifica(ctx, sorgente, varianti);
  if (problemi.length > 0) {
    ctx.log.info(`${nome}: verifica non superata (${problemi.length} problemi), rigenero una volta`);
    varianti = await generaVarianti(ctx, post, analisi, { varianti, problemi });
    problemi = await verifica(ctx, sorgente, varianti);
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
  salvaSorgente(path.basename(destinazione), sorgente);
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
  const lineeGuida = leggiLineeGuida(sharedDir);
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
