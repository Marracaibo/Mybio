import type { Config } from "./config.js";

export interface ConfigOpenWA {
  url: string;
  apiKey: string;
  sessione: string;
  gruppo: string;
}

/** Valida la configurazione di OpenWA. Regola 7: si scrive solo a un gruppo (@g.us). */
export function configOpenWA(config: Config, richiediGruppo = true): ConfigOpenWA {
  const richieste: Array<"OPENWA_API_KEY" | "OPENWA_SESSION" | "WHATSAPP_GROUP_ID"> = ["OPENWA_API_KEY", "OPENWA_SESSION"];
  if (richiediGruppo) richieste.push("WHATSAPP_GROUP_ID");
  const mancanti = richieste.filter((k) => !config[k]);
  if (mancanti.length > 0) throw new Error(`Configurazione OpenWA incompleta nel file .env: ${mancanti.join(", ")}`);
  const gruppo = config.WHATSAPP_GROUP_ID ?? "";
  if (richiediGruppo && !/^[\d-]+@g\.us$/.test(gruppo)) {
    throw new Error(`WHATSAPP_GROUP_ID non è l'id di un gruppo (atteso formato 120363…@g.us): ${gruppo}`);
  }
  return {
    url: config.OPENWA_URL.replace(/\/+$/, ""),
    apiKey: config.OPENWA_API_KEY ?? "",
    sessione: config.OPENWA_SESSION ?? "",
    gruppo,
  };
}

async function richiesta(cfg: ConfigOpenWA, metodo: "GET" | "POST", percorso: string, body?: unknown): Promise<unknown> {
  const url = `${cfg.url}/api/sessions/${encodeURIComponent(cfg.sessione)}${percorso}`;
  let risposta: Response;
  try {
    risposta = await fetch(url, {
      method: metodo,
      headers: { "X-API-Key": cfg.apiKey, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    const causa = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
    throw new Error(`OpenWA non risponde su ${cfg.url}: ${causa}`);
  }
  const testo = await risposta.text();
  if (!risposta.ok) {
    throw new Error(`OpenWA ha risposto ${risposta.status} ${risposta.statusText}: ${testo.slice(0, 300)}`);
  }
  try {
    return testo ? (JSON.parse(testo) as unknown) : null;
  } catch {
    return testo;
  }
}

/** Invia un messaggio di testo al gruppo configurato. Nessun nuovo tentativo: in caso di errore lancia. */
export async function inviaTesto(cfg: ConfigOpenWA, testo: string): Promise<void> {
  await richiesta(cfg, "POST", "/messages/send-text", { chatId: cfg.gruppo, text: testo });
}

export async function elencaGruppi(cfg: ConfigOpenWA): Promise<unknown> {
  return richiesta(cfg, "GET", "/groups");
}
