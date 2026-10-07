import { caricaConfig } from "./config.js";
import { creaLogger, descriviErrore } from "./log.js";
import { configOpenWA, registraWebhook } from "./openwa.js";

/** Registra in OpenWA il webhook verso il servizio (npm run webhook). Si può rilanciare: aggiorna quello esistente. */
const log = creaLogger("webhook");

async function main(): Promise<void> {
  const config = caricaConfig();
  const openwa = configOpenWA(config);
  if (!config.WEBHOOK_URL) throw new Error("Imposta WEBHOOK_URL nel file .env (es. http://motore:3000/webhook/openwa)");
  if (!config.OPENWA_WEBHOOK_SECRET) {
    throw new Error("Imposta OPENWA_WEBHOOK_SECRET nel file .env (almeno 16 caratteri casuali)");
  }
  const esito = await registraWebhook(openwa, config.WEBHOOK_URL, config.OPENWA_WEBHOOK_SECRET);
  log.info(`Webhook ${esito}: ${config.WEBHOOK_URL} (solo messaggi del gruppo ${openwa.gruppo})`);
}

main().catch((e: unknown) => {
  log.errore(descriviErrore(e));
  process.exit(1);
});
