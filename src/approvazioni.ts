import fs from "node:fs";
import path from "node:path";
import { DATI_DIR, type Config } from "./config.js";
import { descriviErrore, type Logger } from "./log.js";
import { creaCompito } from "./linear-simulato.js";
import { cancellaMemoria, nomeDi } from "./memoria.js";
import { inviaTesto, modificaMessaggio, richiesta, type ConfigOpenWA } from "./openwa.js";

/**
 * Approvazioni con una reazione: Jarvis (o /post) manda una proposta, chiunque nel gruppo la approva con 👍
 * (o ✅ 👌 🙏) o la scarta con 👎 (o ❌). Il messaggio della proposta si aggiorna con l'esito.
 * Le proposte scadono dopo 7 giorni.
 */

export type TipoProposta = "promemoria" | "compito" | "sondaggio" | "pubblica_post" | "cancella_memoria";

interface Proposta {
  tipo: TipoProposta;
  descrizione: string;
  parametri: Record<string, unknown>;
  testo: string;
  data: string;
  esito?: string;
}

const FILE = path.join(DATI_DIR, ".approvazioni.json");
const SI = new Set(["👍", "✅", "👌", "🙏", "❤", "🔥"]);
const NO = new Set(["👎", "❌", "🚫"]);

const chiaveId = (id: string) => id.split("_")[2] ?? id;
/** Emoji senza varianti (❤️ → ❤) e senza toni della pelle (👍🏻 → 👍). */
export const pulisciEmoji = (e: string) => e.replace(/[️‍]|\uD83C[\uDFFB-\uDFFF]/g, "");

function carica(): Record<string, Proposta> {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8")) as Record<string, Proposta>;
  } catch {
    return {};
  }
}

function salva(p: Record<string, Proposta>): void {
  const limite = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const tenute = Object.fromEntries(Object.entries(p).filter(([, v]) => v.data >= limite));
  fs.mkdirSync(DATI_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(tenute, null, 2) + "\n", "utf8");
}

/** Manda una proposta nel gruppo e la registra. */
export async function proponi(
  openwa: ConfigOpenWA,
  tipo: TipoProposta,
  descrizione: string,
  parametri: Record<string, unknown>,
): Promise<string> {
  const testo = `🗳️ *Proposta di Jarvis*\n${descrizione}\n\n👍 per approvare · 👎 per scartare`;
  const id = await inviaTesto(openwa, testo);
  if (!id) return "Proposta inviata, ma senza id: non potrò riconoscere le reazioni.";
  const tutte = carica();
  tutte[chiaveId(id)] = { tipo, descrizione, parametri, testo, data: new Date().toISOString() };
  salva(tutte);
  return "Proposta inviata nel gruppo: si approva con 👍.";
}

/** Registra come proposta un messaggio già mandato (es. il testo di un /post). */
export function registraProposta(id: string, tipo: TipoProposta, descrizione: string, parametri: Record<string, unknown>, testo: string): void {
  const tutte = carica();
  tutte[chiaveId(id)] = { tipo, descrizione, parametri, testo, data: new Date().toISOString() };
  salva(tutte);
}

/** Esegue quello che è stato approvato e restituisce l'esito da scrivere. */
async function esegui(ctx: { config: Config; openwa: ConfigOpenWA }, p: Proposta, chi: string): Promise<string> {
  const par = p.parametri;
  switch (p.tipo) {
    case "promemoria": {
      const { aggiungiPromemoria } = await import("./schiavo.js");
      return aggiungiPromemoria(String(par["quando"] ?? ""), String(par["testo"] ?? ""), chi);
    }
    case "compito":
      return `${creaCompito({
        titolo: String(par["titolo"] ?? p.descrizione),
        descrizione: String(par["descrizione"] ?? ""),
        assegnatario: par["assegnatario"] ? String(par["assegnatario"]) : undefined,
        priorita: par["priorita"] ? String(par["priorita"]) : undefined,
        scadenza: par["scadenza"] ? String(par["scadenza"]) : undefined,
        etichette: Array.isArray(par["etichette"]) ? par["etichette"].map(String) : [],
        obiettivo: par["obiettivo"] ? String(par["obiettivo"]) : undefined,
        criteri_accettazione: Array.isArray(par["criteri_accettazione"]) ? par["criteri_accettazione"].map(String) : undefined,
        file_coinvolti: Array.isArray(par["file_coinvolti"]) ? par["file_coinvolti"].map(String) : undefined,
        autore: chi,
      })
        .replace(/^LINEAR SIMULATO[^.]*\.\s*Creato:\s*/, "creato ")
        .replace(/^LINEAR SIMULATO[^.]*\.\s*/, "")} (Linear simulato)`;
    case "sondaggio": {
      const opzioni = (Array.isArray(par["opzioni"]) ? par["opzioni"] : []).map(String).slice(0, 12);
      await richiesta(ctx.openwa, "POST", "/messages/send-poll", {
        chatId: ctx.openwa.gruppo,
        name: String(par["domanda"] ?? "").slice(0, 255),
        options: opzioni,
        allowMultipleAnswers: Boolean(par["scelta_multipla"]),
      });
      return "Sondaggio inviato.";
    }
    case "pubblica_post": {
      // Il canale Telegram non è ancora collegato: il post approvato va in 05-post/approvati, pronto da pubblicare.
      const base = String(par["file"] ?? "");
      const origine = path.join(ctx.config.SHARED_DIR, "05-post");
      const dest = path.join(origine, "approvati");
      fs.mkdirSync(dest, { recursive: true });
      for (const est of [".md", ".png"]) {
        if (base && fs.existsSync(path.join(origine, base + est))) fs.copyFileSync(path.join(origine, base + est), path.join(dest, base + est));
      }
      return "Approvato e messo in 05-post/approvati. Pubblicazione sul canale Telegram: SIMULATA finché non colleghiamo il bot del canale.";
    }
    case "cancella_memoria":
      cancellaMemoria();
      return "Memoria del gruppo cancellata.";
  }
}

/**
 * Gestisce una reazione: se è su una proposta aperta e vale come sì/no, la esegue o la scarta.
 * Restituisce true se la reazione riguardava una proposta.
 */
export async function gestisciReazione(
  ctx: { config: Config; log: Logger; openwa: ConfigOpenWA },
  evento: { messageId?: string; reaction?: string; senderId?: string },
): Promise<boolean> {
  if (!evento.messageId || !evento.reaction) return false;
  const tutte = carica();
  const k = chiaveId(evento.messageId);
  const p = tutte[k];
  if (!p) return false;
  if (p.esito) return true;
  const emoji = pulisciEmoji(evento.reaction);
  const si = SI.has(emoji);
  if (!si && !NO.has(emoji)) return true;
  const chi = nomeDi(evento.senderId);
  let esito: string;
  if (si) {
    try {
      esito = `✅ *Approvata da ${chi}*: ${await esegui(ctx, p, chi)}`;
    } catch (e) {
      esito = `⚠️ Approvata da ${chi}, ma non sono riuscito a eseguirla: ${descriviErrore(e)}`;
    }
  } else {
    esito = `🗑️ *Scartata da ${chi}*.`;
  }
  p.esito = esito;
  salva(tutte);
  ctx.log.info(`Approvazioni: ${p.tipo} ${si ? "approvata" : "scartata"} da ${chi}`);
  if (p.testo.startsWith("🗳️")) {
    const nuovo = `${p.testo.replace(/\n\n👍 per approvare · 👎 per scartare$/, "")}\n\n${esito}`;
    await modificaMessaggio(ctx.openwa, evento.messageId, nuovo).catch(() => inviaTesto(ctx.openwa, esito));
  } else {
    // Proposta che è il contenuto stesso (es. il testo di un post): non lo tocco, rispondo citandolo.
    await inviaTesto(ctx.openwa, esito, { quotedMessageId: evento.messageId }).catch(() => inviaTesto(ctx.openwa, esito));
  }
  return true;
}
