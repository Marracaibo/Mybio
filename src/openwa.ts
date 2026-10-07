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

async function richiesta(
  cfg: ConfigOpenWA,
  metodo: "GET" | "POST" | "PUT",
  percorso: string,
  body?: unknown,
): Promise<unknown> {
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

/**
 * Invia un messaggio di testo al gruppo configurato e restituisce l'id del messaggio (serve alla Fase 4).
 * Nessun nuovo tentativo: in caso di errore lancia.
 */
export async function inviaTesto(
  cfg: ConfigOpenWA,
  testo: string,
  opzioni: { quotedMessageId?: string } = {},
): Promise<string | undefined> {
  const corpo: Record<string, string> = { chatId: cfg.gruppo, text: testo };
  if (opzioni.quotedMessageId) corpo["quotedMessageId"] = opzioni.quotedMessageId;
  const risposta = await richiesta(cfg, "POST", "/messages/send-text", corpo);
  const id = (risposta as { messageId?: unknown } | null)?.messageId;
  return typeof id === "string" ? id : undefined;
}

export async function elencaGruppi(cfg: ConfigOpenWA): Promise<unknown> {
  return richiesta(cfg, "GET", "/groups");
}

/**
 * Registra (o aggiorna) il webhook che porta al servizio i messaggi del gruppo.
 * OpenWA filtra già a monte: arrivano solo i messaggi ricevuti nel gruppo configurato.
 */
export async function registraWebhook(cfg: ConfigOpenWA, url: string, secret: string): Promise<"creato" | "aggiornato"> {
  const corpo = {
    url,
    events: ["message.received"],
    secret,
    filters: { conditions: [{ field: "chatId", operator: "is", value: [cfg.gruppo] }] },
    retryCount: 3,
  };
  const esistenti = await richiesta(cfg, "GET", "/webhooks");
  const elenco: unknown[] = Array.isArray(esistenti)
    ? esistenti
    : esistenti && typeof esistenti === "object" && "data" in esistenti && Array.isArray(esistenti.data)
      ? esistenti.data
      : [];
  const stesso = elenco.find((w) => (w as { url?: unknown })?.url === url) as { id?: unknown } | undefined;
  if (stesso && typeof stesso.id === "string") {
    await richiesta(cfg, "PUT", `/webhooks/${encodeURIComponent(stesso.id)}`, { ...corpo, active: true });
    return "aggiornato";
  }
  await richiesta(cfg, "POST", "/webhooks", corpo);
  return "creato";
}
