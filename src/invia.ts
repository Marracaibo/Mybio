import fs from "node:fs";
import path from "node:path";
import { leggiBozza, type Bozza } from "./bozza.js";
import { daIgnorare, spostaConMotivo } from "./cartelle.js";
import { CARTELLE, caricaConfig, verificaSeparazioneCartelle } from "./config.js";
import { creaLogger, descriviErrore } from "./log.js";
import { configOpenWA, inviaTesto, preparaSessione } from "./openwa.js";
import { caricaStato, salvaStato } from "./stato.js";
import { inizioTesto, oggi, testoSemplice } from "./testo.js";

const log = creaLogger("invia");

/** Regola 7: mai più di 3 messaggi al giorno. */
const MASSIMO_MESSAGGI_GIORNO = 3;

function messaggioContesto(nomeFile: string, bozza: Bozza, conVarianteB: boolean): string {
  const righe = [
    `📝 Nuova bozza LinkedIn: ${nomeFile}`,
    "",
    `Fonte: ${bozza.fonte}`,
  ];
  if (bozza.formato) righe.push(`Formato: ${bozza.formato}`);
  if (bozza.perche_funziona) righe.push(`Perché funziona: ${bozza.perche_funziona}`);
  righe.push("");
  if (bozza.problemi.length === 0) {
    righe.push("Verifica: ok ✅");
  } else {
    righe.push("⚠️ Problemi segnalati dalla verifica:", ...bozza.problemi.map((p) => `- ${p}`));
  }
  if (bozza.segnaposto.length > 0) {
    righe.push("", "Da completare prima di pubblicare:", ...bozza.segnaposto.map((s) => `- ${s}`));
  }
  righe.push(
    "",
    conVarianteB
      ? "Nei prossimi due messaggi la Variante A e poi la Variante B, pronte da copiare su LinkedIn."
      : "Nel prossimo messaggio il post pronto da copiare su LinkedIn.",
  );
  return righe.join("\n");
}

/** Bozze in 02-bozze/ dalla più vecchia: prima per data nel nome (AAAA-MM-GG_), poi per data di modifica. */
function bozzeInOrdine(cartella: string): string[] {
  const dataNelNome = (n: string) => /^(\d{4}-\d{2}-\d{2})_/.exec(n)?.[1] ?? "9999-99-99";
  return fs
    .readdirSync(cartella, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".md") && !daIgnorare(d.name))
    .map((d) => ({ nome: d.name, data: dataNelNome(d.name), mtime: fs.statSync(path.join(cartella, d.name)).mtimeMs }))
    .sort((a, b) => a.data.localeCompare(b.data) || a.mtime - b.mtime || a.nome.localeCompare(b.nome))
    .map((b) => b.nome);
}

async function main(): Promise<number> {
  const config = caricaConfig();
  const openwa = configOpenWA(config);
  const sharedDir = config.SHARED_DIR;
  verificaSeparazioneCartelle(sharedDir);

  const cartellaBozze = path.join(sharedDir, CARTELLE.bozze);
  if (!fs.existsSync(cartellaBozze)) {
    log.info(`Cartella ${CARTELLE.bozze}/ assente: esegui prima npm run adatta`);
    return 0;
  }

  const stato = caricaStato();
  const giorno = oggi();
  const inviatiOggi = stato.messaggiPerGiorno[giorno] ?? 0;
  const disponibili = MASSIMO_MESSAGGI_GIORNO - inviatiOggi;
  if (disponibili <= 0) {
    log.info(`Limite di ${MASSIMO_MESSAGGI_GIORNO} messaggi al giorno già raggiunto: riprovo domani.`);
    return 0;
  }

  for (const nome of bozzeInOrdine(cartellaBozze)) {
    if (stato.bozze[nome]?.completata) continue;
    const file = path.join(cartellaBozze, nome);

    let bozza: Bozza;
    try {
      bozza = leggiBozza(fs.readFileSync(file, "utf8"));
    } catch (e) {
      // Una bozza illeggibile non deve bloccare le altre.
      const motivo = descriviErrore(e);
      log.errore(`${nome} spostata in _errori/: ${motivo}`);
      spostaConMotivo(file, path.join(sharedDir, CARTELLE.errori), `Bozza non inviabile: ${motivo}`);
      continue;
    }

    const conVarianteB = config.INVIA_VARIANTE_B === "true" && bozza.varianteB.trim() !== "";
    const messaggi = [messaggioContesto(nome, bozza, conVarianteB), testoSemplice(bozza.varianteA)];
    if (conVarianteB) messaggi.push(testoSemplice(bozza.varianteB));

    const giaInviati = stato.bozze[nome]?.messaggiInviati ?? 0;
    let daInviare = messaggi.slice(giaInviati);
    // Contesto e Variante A sono obbligatori; la Variante B si salta se il limite giornaliero non basta.
    const obbligatori = Math.max(0, 2 - giaInviati);
    if (obbligatori > disponibili) {
      log.info(`Servono ${obbligatori} messaggi per ${nome} ma oggi ne restano ${disponibili}: riprovo domani.`);
      return 0;
    }
    if (daInviare.length > disponibili) {
      log.info(`Limite giornaliero: per ${nome} salto la Variante B.`);
      daInviare = daInviare.slice(0, disponibili);
    }

    if (!(await preparaSessione(openwa).catch(() => false))) {
      log.errore("La sessione WhatsApp non è pronta (scollegata o in attesa del QR). Si riprova al prossimo giro.");
      return 1;
    }
    log.info(`Invio ${nome} (${daInviare.length} messaggi)`);
    let riavviata = false;
    const parti = ["contesto", "A", "B"] as const;
    let inviati = giaInviati;
    for (const testo of daInviare) {
      let id: string | undefined;
      try {
        id = await inviaTesto(openwa, testo);
      } catch (e) {
        // Una sola volta: la sessione può risultare collegata senza riuscire a spedire (whatsapp-web.js
        // dopo un riavvio o un aggiornamento di WhatsApp Web). Riavviarla di solito basta.
        if (riavviata || !/ 5\d\d /.test(descriviErrore(e))) {
          log.errore(`Invio interrotto: ${descriviErrore(e)}. Si riprova al prossimo giro.`);
          return 1;
        }
        riavviata = true;
        log.avviso(`Invio non riuscito (${descriviErrore(e)}): riavvio la sessione WhatsApp e riprovo una volta.`);
        try {
          if (!(await preparaSessione(openwa, { forza: true }))) throw new Error("la sessione non è tornata pronta");
          id = await inviaTesto(openwa, testo);
        } catch (e2) {
          log.errore(`Invio interrotto anche dopo il riavvio: ${descriviErrore(e2)}. Si riprova al prossimo giro.`);
          return 1;
        }
      }
      if (id) {
        // Fase 4: chi risponde citando questo messaggio sta parlando di questa bozza.
        stato.messaggi[id] = { bozza: nome, parte: parti[inviati] ?? "contesto", inizio: inizioTesto(testo), data: new Date().toISOString() };
      }
      inviati++;
      stato.messaggiPerGiorno[giorno] = (stato.messaggiPerGiorno[giorno] ?? 0) + 1;
      // Completata quando sono partiti contesto e Variante A e tutto ciò che era previsto per oggi.
      const completata = inviati >= 2 && inviati === giaInviati + daInviare.length;
      stato.bozze[nome] = { messaggiInviati: inviati, completata, aggiornato: new Date().toISOString() };
      salvaStato(stato);
    }
    log.info(`Inviata ${nome}`);
    return 0;
  }

  log.info("Nessuna bozza nuova da inviare.");
  return 0;
}

main().then(
  (codice) => process.exit(codice),
  (e: unknown) => {
    log.errore(descriviErrore(e));
    process.exit(1);
  },
);
