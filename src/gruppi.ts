import { caricaConfig } from "./config.js";
import { descriviErrore } from "./log.js";
import { configOpenWA, elencaGruppi } from "./openwa.js";

/** Elenca i gruppi WhatsApp della sessione OpenWA, per trovare il valore di WHATSAPP_GROUP_ID. */
function idLeggibile(id: unknown): string {
  if (typeof id === "string") return id;
  if (id && typeof id === "object" && "_serialized" in id) return String((id as { _serialized: unknown })._serialized);
  return JSON.stringify(id);
}

async function main(): Promise<void> {
  const cfg = configOpenWA(caricaConfig(), false);
  const risposta = await elencaGruppi(cfg);
  const elenco: unknown[] = Array.isArray(risposta)
    ? risposta
    : risposta && typeof risposta === "object" && "data" in risposta && Array.isArray(risposta.data)
      ? risposta.data
      : [];
  if (elenco.length === 0) {
    console.log("Nessun gruppo trovato. Risposta grezza di OpenWA:");
    console.log(JSON.stringify(risposta, null, 2));
    return;
  }
  for (const g of elenco) {
    const r = (g ?? {}) as Record<string, unknown>;
    const nome = r["name"] ?? r["subject"] ?? r["title"] ?? "(senza nome)";
    console.log(`${idLeggibile(r["id"] ?? r["chatId"] ?? r["jid"])}\t${String(nome)}`);
  }
}

main().catch((e: unknown) => {
  console.error(descriviErrore(e));
  process.exit(1);
});
