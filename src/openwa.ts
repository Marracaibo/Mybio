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

export async function richiesta(
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
  // Niente anteprima dei link: su whatsapp-web.js generarla può far fallire l'invio (500) e i link
  // delle fonti nel messaggio di contesto non hanno bisogno di anteprima.
  const corpo: Record<string, string | boolean> = { chatId: cfg.gruppo, text: testo, linkPreview: false };
  if (opzioni.quotedMessageId) corpo["quotedMessageId"] = opzioni.quotedMessageId;
  const risposta = await richiesta(cfg, "POST", "/messages/send-text", corpo);
  ricordaInviato(testo);
  const id = (risposta as { messageId?: unknown } | null)?.messageId;
  return typeof id === "string" ? id : undefined;
}

/** Inizio dei testi spediti da questo processo: col numero personale tornano indietro come message.sent. */
const inviatiDiRecente: string[] = [];
const inizioInviato = (t: string) => t.replace(/\s+/g, " ").trim().slice(0, 120);
function ricordaInviato(testo: string): void {
  inviatiDiRecente.push(inizioInviato(testo));
  if (inviatiDiRecente.length > 200) inviatiDiRecente.shift();
}
export function inviatoDaQui(testo: string): boolean {
  return inviatiDiRecente.includes(inizioInviato(testo));
}

/**
 * Il messaggio citato da un proprio messaggio. Con il numero personale le risposte scritte dal telefono
 * arrivano come message.sent, e OpenWA (whatsapp-web.js) non vi mette la citazione: la leggo dallo storico
 * della chat, che invece la risolve.
 */
export async function citazioneDaStorico(
  cfg: ConfigOpenWA,
  chatId: string,
  messageId: string,
): Promise<{ id?: string; body?: string } | undefined> {
  for (let tentativo = 0; tentativo < 3; tentativo++) {
    const storico = (await richiesta(cfg, "GET", `/messages/${encodeURIComponent(chatId)}/history?limit=15`)) as
      | Array<{ id?: string; quotedMessage?: { id?: string; body?: string } }>
      | null;
    const trovato = Array.isArray(storico) ? storico.find((m) => m.id === messageId) : undefined;
    if (trovato) return trovato.quotedMessage;
    await attendi(1500);
  }
  return undefined;
}

const attendi = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function statoSessione(cfg: ConfigOpenWA): Promise<string> {
  const s = (await richiesta(cfg, "GET", "")) as { status?: unknown } | null;
  return typeof s?.status === "string" ? s.status : "";
}

/** Attende che la sessione sia "ready" (fino a `secondi`); false se resta scollegata o chiede il QR. */
async function attendiPronta(cfg: ConfigOpenWA, secondi: number): Promise<boolean> {
  for (let t = 0; t < secondi; t += 5) {
    const s = await statoSessione(cfg).catch(() => "");
    if (s === "ready") return true;
    if (s === "qr_ready" || s === "failed") return false;
    await attendi(5000);
  }
  return false;
}

/**
 * Se la sessione WhatsApp non è pronta (es. dopo un riavvio del server) la avvia e attende.
 * Con `forza` la ferma e la riavvia: rimedio all'errore di whatsapp-web.js "called before startComms",
 * quando la sessione risulta collegata ma non riesce a spedire. Dopo il riavvio lascia un minuto
 * a WhatsApp Web per finire la sincronizzazione. Restituisce false se non torna pronta.
 */
export async function preparaSessione(cfg: ConfigOpenWA, opzioni: { forza?: boolean } = {}): Promise<boolean> {
  if (!opzioni.forza && (await statoSessione(cfg)) === "ready") return true;
  if (opzioni.forza) {
    await richiesta(cfg, "POST", "/stop").catch(() => undefined);
    await attendi(15_000);
  }
  await richiesta(cfg, "POST", "/start").catch(() => undefined);
  if (!(await attendiPronta(cfg, 240))) return false;
  await attendi(60_000);
  return true;
}

/** Invia un'immagine (base64) al gruppo, con didascalia facoltativa; restituisce l'id del messaggio. */
export async function inviaImmagine(cfg: ConfigOpenWA, png: Buffer, didascalia?: string): Promise<string | undefined> {
  const corpo: Record<string, string> = { chatId: cfg.gruppo, base64: png.toString("base64"), mimetype: "image/png" };
  if (didascalia) corpo["caption"] = didascalia.slice(0, 1024);
  const risposta = await richiesta(cfg, "POST", "/messages/send-image", corpo);
  const id = (risposta as { messageId?: unknown } | null)?.messageId;
  return typeof id === "string" ? id : undefined;
}

/** Manda un vocale (Ogg/Opus) nel gruppo, eventualmente citando un messaggio. */
export async function inviaVocale(cfg: ConfigOpenWA, ogg: Buffer, quotedMessageId?: string): Promise<string | undefined> {
  const corpo: Record<string, string | boolean> = {
    chatId: cfg.gruppo,
    base64: ogg.toString("base64"),
    mimetype: "audio/ogg; codecs=opus",
    ptt: true,
  };
  if (quotedMessageId) corpo["quotedMessageId"] = quotedMessageId;
  const risposta = await richiesta(cfg, "POST", "/messages/send-audio", corpo);
  const id = (risposta as { messageId?: unknown } | null)?.messageId;
  return typeof id === "string" ? id : undefined;
}

/** Scarica il file allegato a un messaggio (quando il webhook non lo porta già dentro). */
export async function scaricaMedia(cfg: ConfigOpenWA, chatId: string, messageId: string): Promise<Buffer> {
  const url = `${cfg.url}/api/sessions/${encodeURIComponent(cfg.sessione)}/messages/${encodeURIComponent(chatId)}/${encodeURIComponent(messageId)}/media`;
  const risposta = await fetch(url, { headers: { "X-API-Key": cfg.apiKey }, signal: AbortSignal.timeout(60_000) });
  if (!risposta.ok) throw new Error(`OpenWA ha risposto ${risposta.status} scaricando l'allegato`);
  return Buffer.from(await risposta.arrayBuffer());
}

/** Reazione a un messaggio del gruppo (emoji vuota per toglierla). Errori ignorati: è solo cortesia. */
export async function reagisci(cfg: ConfigOpenWA, messageId: string, emoji: string): Promise<void> {
  await richiesta(cfg, "POST", "/messages/react", { chatId: cfg.gruppo, messageId, emoji }).catch(() => undefined);
}

/**
 * Mostra "sta scrivendo…" nel gruppo finché `lavoro` non finisce (WhatsApp lo spegne da solo dopo ~25 s,
 * quindi lo ripeto). Errori ignorati.
 */
export async function scrivendoMentre<T>(cfg: ConfigOpenWA, lavoro: () => Promise<T>): Promise<T> {
  const segnala = (state: string) =>
    richiesta(cfg, "POST", "/chats/typing", { chatId: cfg.gruppo, state }).catch(() => undefined);
  void segnala("typing");
  const timer = setInterval(() => void segnala("typing"), 20_000);
  try {
    return await lavoro();
  } finally {
    clearInterval(timer);
    void segnala("paused");
  }
}

/** Come scaricaMedia, con il tipo dichiarato da OpenWA. */
export async function scaricaMediaConTipo(
  cfg: ConfigOpenWA,
  chatId: string,
  messageId: string,
): Promise<{ dati: Buffer; mimetype: string }> {
  const url = `${cfg.url}/api/sessions/${encodeURIComponent(cfg.sessione)}/messages/${encodeURIComponent(chatId)}/${encodeURIComponent(messageId)}/media`;
  const risposta = await fetch(url, { headers: { "X-API-Key": cfg.apiKey }, signal: AbortSignal.timeout(60_000) });
  if (!risposta.ok) throw new Error(`OpenWA ha risposto ${risposta.status} scaricando l'allegato`);
  const mimetype = (risposta.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
  return { dati: Buffer.from(await risposta.arrayBuffer()), mimetype };
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
    // message.sent: con il numero personale i messaggi scritti dal telefono collegato sono "inviati",
    // non "ricevuti"; senza, i comandi e le fonti mandate da chi ha collegato il numero non arrivano.
    events: ["message.received", "message.sent"],
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
