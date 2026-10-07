import path from "node:path";
import { preparaCartellaCondivisa } from "./cartelle.js";
import { CARTELLE, caricaConfig, LINEE_GUIDA, verificaSeparazioneCartelle } from "./config.js";
import { creaLogger, descriviErrore } from "./log.js";

/** Crea le cartelle nella cartella condivisa e il file linee-guida.md di esempio. */
const log = creaLogger("inizializza");

try {
  const config = caricaConfig();
  verificaSeparazioneCartelle(config.SHARED_DIR);
  const { lineeGuidaCreate } = preparaCartellaCondivisa(config.SHARED_DIR);
  for (const rel of Object.values(CARTELLE)) log.info(`Cartella pronta: ${path.join(config.SHARED_DIR, rel)}`);
  log.info(
    lineeGuidaCreate
      ? `Creato ${LINEE_GUIDA} di esempio: compilalo prima di lanciare npm run adatta.`
      : `${LINEE_GUIDA} esiste già: non l'ho toccato.`,
  );
} catch (e) {
  log.errore(descriviErrore(e));
  process.exit(1);
}
