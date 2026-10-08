import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { chiediJson, creaClient } from "./claude.js";
import { DATI_DIR, type Config } from "./config.js";
import type { Logger } from "./log.js";
import { descriviErrore } from "./log.js";
import { configOpenWA, inviaTesto, richiesta, scaricaMedia, type ConfigOpenWA } from "./openwa.js";
import { oggi } from "./testo.js";

/**
 * Prototipo dei bot Doublegram adattati a WhatsApp, attivi solo nel gruppo configurato:
 * - Doublegram AI: /ai <domanda> (anche rispondendo a un messaggio) → risponde Claude;
 * - Scribe: trascrive i vocali del gruppo (Whisper via API compatibile OpenAI, di default Groq);
 * - Lookup: /lookup <numero> o con @menzione → informazioni pubbliche sull'account WhatsApp;
 * - Security: antilink e parole vietate, spento finché qualcuno non scrive /security on;
 * - Shop: /shop, /aggiungi, /carrello, /ordina con i piani veri di Doublegram.
 * Nessun messaggio privato: tutto avviene nel gruppo.
 */

export interface MessaggioDoublegram {
  id?: string;
  chatId?: string;
  from?: string;
  author?: string;
  body?: string;
  fromMe?: boolean;
  type?: string;
  mentionedIds?: string[];
  media?: { mimetype?: string; data?: string; omitted?: boolean };
  quotedMessage?: { id?: string; body?: string };
}

// ---------- Stato ----------

interface Voce {
  codice: string;
  nome: string;
  /** null: prezzo non pubblicato, da confermare. */
  prezzo: number | null;
  periodo?: string;
  descrizione: string;
}

interface Catalogo {
  valuta: string;
  link: string;
  prodotti: Voce[];
}

interface Ordine {
  numero: number;
  cliente: string;
  voci: Array<{ codice: string; nome: string; quantita: number; prezzo: number | null }>;
  totale: number;
  daConfermare: boolean;
  data: string;
}

interface StatoDoublegram {
  security: { attiva: boolean; paroleVietate: string[] };
  scribe: { attiva: boolean };
  carrelli: Record<string, Record<string, number>>;
  ordini: Ordine[];
  perGiorno: Record<string, number>;
  elaborati: string[];
}

const FILE_STATO = path.join(DATI_DIR, ".doublegram.json");

function caricaStato(): StatoDoublegram {
  let d: Partial<StatoDoublegram> = {};
  try {
    d = JSON.parse(fs.readFileSync(FILE_STATO, "utf8")) as Partial<StatoDoublegram>;
  } catch {
    // primo avvio
  }
  return {
    security: { attiva: d.security?.attiva ?? false, paroleVietate: d.security?.paroleVietate ?? [] },
    scribe: { attiva: d.scribe?.attiva ?? true },
    carrelli: d.carrelli ?? {},
    ordini: d.ordini ?? [],
    perGiorno: d.perGiorno ?? {},
    elaborati: d.elaborati ?? [],
  };
}

function salvaStato(s: StatoDoublegram): void {
  s.elaborati = s.elaborati.slice(-500);
  const giorni = Object.keys(s.perGiorno).sort();
  for (const g of giorni.slice(0, -7)) delete s.perGiorno[g];
  fs.mkdirSync(DATI_DIR, { recursive: true });
  fs.writeFileSync(FILE_STATO, JSON.stringify(s, null, 2) + "\n", "utf8");
}

/**
 * Catalogo dei piani veri (doublegram.com/pricing, ottobre 2026). Si può sovrascrivere con
 * catalogo-doublegram.json nella cartella condivisa. I prezzi non pubblicati restano null.
 */
const CATALOGO_PREDEFINITO: Catalogo = {
  valuta: "$",
  link: "https://account.doublegram.com/signup",
  prodotti: [
    {
      codice: "free",
      nome: "Doublegram Free",
      prezzo: 0,
      descrizione:
        "Verifica d'ingresso nei gruppi, 50 trascrizioni vocali all'ora, post manuali con media, bottoni e sondaggi, 5 ricerche Lookup al giorno, 100 crediti AI all'iscrizione.",
    },
    {
      codice: "premium",
      nome: "Doublegram Premium (mensile)",
      prezzo: 9.99,
      periodo: "al mese",
      descrizione:
        "Tutte le funzioni di tutti i bot e 1.000 crediti AI al mese: antiraid, antiflood, antispam, parole vietate, filtro immagini, firewall per paese, Scribe con AI nei gruppi, Lookup illimitato.",
    },
    {
      codice: "premium-anno",
      nome: "Doublegram Premium (annuale)",
      prezzo: null,
      periodo: "all'anno",
      descrizione: "Come il mensile, con 2 mesi gratis. Prezzo sul sito.",
    },
    {
      codice: "crediti",
      nome: "Ricarica crediti AI",
      prezzo: null,
      descrizione: "Crediti extra per Doublegram AI e Scribe, si ricaricano dalla dashboard. Prezzo sul sito.",
    },
  ],
};

function caricaCatalogo(config: Config): Catalogo {
  const file = path.join(config.SHARED_DIR, "catalogo-doublegram.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Catalogo;
  } catch {
    return CATALOGO_PREDEFINITO;
  }
}

// ---------- Utilità ----------

const normalizza = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

const soloCifre = (s: string) => s.replace(/\D/g, "");

/** Numero di telefono da testo: cifre, con 39 davanti ai cellulari italiani scritti senza prefisso. */
function numeroDaTesto(testo: string): string | undefined {
  const cifre = soloCifre(testo);
  if (!/^\d{8,15}$/.test(cifre)) return undefined;
  return /^3\d{9}$/.test(cifre) ? `39${cifre}` : cifre;
}

const euro = (n: number, valuta: string) => `${valuta}${n.toFixed(2).replace(".", ",")}`;

const LINK = /(https?:\/\/|www\.|\bt\.me\/|chat\.whatsapp\.com)/i;

const MENU = [
  "🤖 *Doublegram per WhatsApp* (prototipo) – comandi nel gruppo:",
  "",
  "*AI*  /ai <domanda> – risponde l'assistente (rispondendo a un messaggio, lo usa come contesto)",
  "*Scribe*  i vocali del gruppo vengono trascritti in automatico · /scribe on | off",
  "*Lookup*  /lookup <numero> oppure /lookup @persona – info sull'account WhatsApp",
  "*Security*  /security on | off | stato · /vieta <parola> · /consenti <parola>",
  "*Shop*  /shop · /aggiungi <n> [quantità] · /togli <n> · /carrello · /svuota · /ordina",
  "",
  "Il motore LinkedIn resta com'è: adatta, adatta subito, manda bozza, aiuto (citando una bozza).",
].join("\n");

// ---------- Funzioni dei bot ----------

const RispostaAI = z.object({ risposta: z.string() });

async function rispondiAI(config: Config, domanda: string, contesto?: string): Promise<string> {
  const client = creaClient(config);
  const system =
    "Sei Doublegram AI, l'assistente di Doublegram dentro un gruppo WhatsApp di lavoro. " +
    "Rispondi in italiano, in modo diretto e pratico, al massimo 1200 caratteri. " +
    "Testo semplice adatto a WhatsApp: niente titoli markdown né tabelle; puoi usare elenchi con trattini. " +
    "Se non sai qualcosa o serve un dato aggiornato che non hai, dillo invece di inventare.";
  const testo = contesto ? `Messaggio citato:\n${contesto}\n\nRichiesta: ${domanda}` : domanda;
  const esito = await chiediJson(client, config, {
    nome: "doublegram-ai",
    ruolo: "scrittura",
    system,
    schema: RispostaAI,
    contenuto: [{ type: "text", text: testo }],
  });
  return esito.risposta.trim();
}

async function trascrivi(config: Config, audio: Buffer, mimetype: string): Promise<string> {
  // Scribe locale (deploy/scribe, Whisper small sul server): l'audio va così com'è, senza chiavi.
  if (/\/trascrivi\/?$/.test(config.SCRIBE_URL)) {
    const risposta = await fetch(config.SCRIBE_URL, {
      method: "POST",
      headers: { "Content-Type": mimetype || "audio/ogg" },
      body: new Uint8Array(audio),
      signal: AbortSignal.timeout(300_000),
    });
    const corpo = await risposta.text();
    if (!risposta.ok) throw new Error(`trascrizione non riuscita (${risposta.status}): ${corpo.slice(0, 200)}`);
    return ((JSON.parse(corpo) as { text?: string }).text ?? "").trim();
  }
  // Altrimenti un servizio compatibile OpenAI (es. Groq), con chiave.
  if (!config.GROQ_API_KEY) throw new Error("manca GROQ_API_KEY nel file .env");
  const estensione = mimetype.includes("ogg") ? "ogg" : mimetype.includes("mpeg") ? "mp3" : mimetype.includes("mp4") ? "m4a" : "ogg";
  const modulo = new FormData();
  modulo.append("file", new Blob([new Uint8Array(audio)], { type: mimetype || "audio/ogg" }), `vocale.${estensione}`);
  modulo.append("model", config.SCRIBE_MODELLO);
  modulo.append("language", "it");
  modulo.append("response_format", "json");
  const risposta = await fetch(config.SCRIBE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.GROQ_API_KEY}` },
    body: modulo,
    signal: AbortSignal.timeout(120_000),
  });
  const corpo = await risposta.text();
  if (!risposta.ok) throw new Error(`trascrizione non riuscita (${risposta.status}): ${corpo.slice(0, 200)}`);
  return ((JSON.parse(corpo) as { text?: string }).text ?? "").trim();
}

async function lookup(openwa: ConfigOpenWA, numero: string): Promise<string> {
  const verifica = (await richiesta(openwa, "GET", `/contacts/check/${encodeURIComponent(numero)}`)) as {
    exists?: boolean;
    whatsappId?: string | null;
  } | null;
  if (!verifica?.exists || !verifica.whatsappId) return `🔎 +${numero}: non risulta registrato su WhatsApp.`;
  const contatto = (await richiesta(openwa, "GET", `/contacts/${encodeURIComponent(verifica.whatsappId)}`).catch(
    () => null,
  )) as { name?: string; pushName?: string; isMyContact?: boolean; isBlocked?: boolean; profilePicUrl?: string } | null;
  const foto = (await richiesta(openwa, "GET", `/contacts/${encodeURIComponent(verifica.whatsappId)}/profile-picture`).catch(
    () => null,
  )) as { url?: string | null; profilePicUrl?: string | null } | null;
  const haFoto = Boolean(contatto?.profilePicUrl || foto?.url || foto?.profilePicUrl);
  return [
    `🔎 *Lookup* +${numero}`,
    `- Su WhatsApp: sì (${verifica.whatsappId})`,
    `- Nome pubblico: ${contatto?.pushName || "non visibile"}`,
    `- Nella tua rubrica: ${contatto?.isMyContact ? `sì${contatto.name ? `, come "${contatto.name}"` : ""}` : "no"}`,
    `- Foto profilo: ${haFoto ? "sì" : "no o non visibile"}`,
    ...(contatto?.isBlocked ? ["- ⚠️ Lo hai bloccato"] : []),
    "Un nome uguale a quello di un admin ma un numero diverso è il segnale tipico di un clone.",
  ].join("\n");
}

/** Admin del gruppo (per numero), con cache di 10 minuti: a loro Security non cancella nulla. */
let cacheAdmin: { quando: number; numeri: Set<string> } | undefined;
async function adminDelGruppo(openwa: ConfigOpenWA): Promise<Set<string>> {
  if (cacheAdmin && Date.now() - cacheAdmin.quando < 10 * 60_000) return cacheAdmin.numeri;
  const info = (await richiesta(openwa, "GET", `/groups/${encodeURIComponent(openwa.gruppo)}`).catch(() => null)) as {
    participants?: Array<{ id?: string; number?: string; isAdmin?: boolean; isSuperAdmin?: boolean }>;
  } | null;
  const numeri = new Set(
    (info?.participants ?? []).filter((p) => p.isAdmin || p.isSuperAdmin).map((p) => soloCifre(p.number ?? p.id ?? "")),
  );
  cacheAdmin = { quando: Date.now(), numeri };
  return numeri;
}

function testoShop(catalogo: Catalogo): string {
  const righe = ["🛒 *Doublegram Shop* – i piani (per ora i bot sono su Telegram):", ""];
  catalogo.prodotti.forEach((p, i) => {
    const prezzo = p.prezzo === null ? "prezzo sul sito" : p.prezzo === 0 ? "gratis" : `${euro(p.prezzo, catalogo.valuta)} ${p.periodo ?? ""}`.trim();
    righe.push(`${i + 1}. *${p.nome}* – ${prezzo}`, `   ${p.descrizione}`);
  });
  righe.push("", "Aggiungi con: /aggiungi <numero> [quantità] · poi /carrello e /ordina");
  return righe.join("\n");
}

function riepilogo(carrello: Record<string, number>, catalogo: Catalogo): { testo: string; totale: number; daConfermare: boolean } {
  let totale = 0;
  let daConfermare = false;
  const righe: string[] = [];
  for (const [codice, quantita] of Object.entries(carrello)) {
    const p = catalogo.prodotti.find((x) => x.codice === codice);
    if (!p || quantita <= 0) continue;
    if (p.prezzo === null) {
      daConfermare = true;
      righe.push(`- ${quantita} × ${p.nome}: prezzo da confermare`);
    } else {
      totale += p.prezzo * quantita;
      righe.push(`- ${quantita} × ${p.nome}: ${euro(p.prezzo * quantita, catalogo.valuta)}`);
    }
  }
  if (righe.length === 0) return { testo: "Il carrello è vuoto. Scrivi /shop per vedere i piani.", totale: 0, daConfermare: false };
  righe.push(`Totale: ${euro(totale, catalogo.valuta)}${daConfermare ? " + voci con prezzo da confermare" : ""}`);
  return { testo: righe.join("\n"), totale, daConfermare };
}

// ---------- Ingresso ----------

export interface ServizioDoublegram {
  config: Config;
  log: Logger;
}

/**
 * Gestisce i messaggi del gruppo che riguardano i bot Doublegram. Restituisce true se il messaggio
 * è stato gestito (comando, vocale trascritto o messaggio rimosso da Security): in quel caso il motore
 * LinkedIn non lo guarda.
 */
export async function gestisciDoublegram(srv: ServizioDoublegram, msg: MessaggioDoublegram, chiave: string): Promise<boolean> {
  const { config, log } = srv;
  if (config.DOUBLEGRAM_BOT !== "true") return false;
  const openwa = configOpenWA(config);
  const chat = msg.chatId ?? msg.from;
  if (chat !== openwa.gruppo) return false;

  const testo = (msg.body ?? "").trim();
  const comando = /^\/([a-z]+)\b\s*([\s\S]*)$/i.exec(testo);
  const vocale = ["voice", "audio", "ptt"].includes(msg.type ?? "") || (msg.media?.mimetype ?? "").startsWith("audio/");
  const stato = caricaStato();
  if (chiave && stato.elaborati.includes(chiave)) return Boolean(comando) || vocale;

  const rispondi = async (risposta: string) => {
    await inviaTesto(openwa, risposta, msg.id ? { quotedMessageId: msg.id } : {}).catch(async () => {
      await inviaTesto(openwa, risposta);
    });
  };
  const segna = () => {
    if (chiave) stato.elaborati.push(chiave);
  };
  const giorno = oggi();
  const sottoTetto = () => {
    const n = stato.perGiorno[giorno] ?? 0;
    if (n >= config.DOUBLEGRAM_MAX_GIORNO) return false;
    stato.perGiorno[giorno] = n + 1;
    return true;
  };

  // --- Scribe: vocali (anche i propri)
  if (vocale && !comando) {
    segna();
    if (!stato.scribe.attiva) {
      salvaStato(stato);
      return true;
    }
    if (!sottoTetto()) {
      salvaStato(stato);
      log.avviso("Doublegram: tetto giornaliero raggiunto, vocale non trascritto");
      return true;
    }
    salvaStato(stato);
    try {
      const audio =
        msg.media?.data && !msg.media.omitted
          ? Buffer.from(msg.media.data, "base64")
          : msg.id
            ? await scaricaMedia(openwa, chat, msg.id)
            : Buffer.alloc(0);
      if (!audio.length) throw new Error("audio non disponibile");
      const trascritto = await trascrivi(config, audio, msg.media?.mimetype ?? "audio/ogg");
      log.info(`Scribe: vocale trascritto (${trascritto.length} caratteri)`);
      await rispondi(trascritto ? `🎙️ ${trascritto}` : "🎙️ (vocale senza parole riconoscibili)");
    } catch (e) {
      log.errore(`Scribe: ${descriviErrore(e)}`);
      const locale = /\/trascrivi\/?$/.test(config.SCRIBE_URL);
      if (!locale && !config.GROQ_API_KEY) return true; // non configurato: niente messaggi d'errore nel gruppo
      await rispondi(`🎙️ Non sono riuscito a trascrivere questo vocale (${descriviErrore(e)}).`);
    }
    return true;
  }

  // --- Security: messaggi normali degli altri, quando è accesa
  if (!comando) {
    if (!stato.security.attiva || msg.fromMe || !msg.id) return false;
    const autore = soloCifre(msg.author ?? "");
    if (autore && (await adminDelGruppo(openwa)).has(autore)) return false;
    const parola = stato.security.paroleVietate.find((p) => new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(normalizza(testo)));
    const motivo = LINK.test(testo) ? "link non consentiti" : parola ? `parola vietata "${parola}"` : undefined;
    if (!motivo) return false;
    segna();
    salvaStato(stato);
    try {
      await richiesta(openwa, "POST", "/messages/delete", { chatId: chat, messageId: msg.id, forEveryone: true });
      log.info(`Security: messaggio rimosso (${motivo})`);
      await inviaTesto(openwa, `🛡️ Messaggio rimosso: ${motivo}. (Doublegram Security)`);
    } catch (e) {
      log.avviso(`Security: non riesco a cancellare (${descriviErrore(e)})`);
      await inviaTesto(openwa, `🛡️ Avrei rimosso un messaggio (${motivo}), ma per cancellare il numero collegato deve essere admin del gruppo.`);
    }
    return true;
  }

  // --- Comandi
  const nome = (comando[1] ?? "").toLowerCase();
  const argomento = (comando[2] ?? "").trim();
  const noti = ["doublegram", "aiuto", "help", "menu", "ai", "lookup", "scribe", "security", "vieta", "consenti", "shop", "aggiungi", "togli", "carrello", "svuota", "ordina"];
  if (!noti.includes(nome)) return false;
  segna();
  const cliente = msg.fromMe ? "io" : soloCifre(msg.author ?? msg.from ?? "") || "sconosciuto";

  try {
    switch (nome) {
      case "doublegram":
      case "aiuto":
      case "help":
      case "menu":
        salvaStato(stato);
        await rispondi(MENU);
        return true;

      case "ai": {
        if (!argomento && !msg.quotedMessage?.body) {
          salvaStato(stato);
          await rispondi("🤖 Scrivi la domanda dopo /ai, per esempio: /ai scrivimi 3 idee di post per la community");
          return true;
        }
        if (!sottoTetto()) {
          salvaStato(stato);
          await rispondi("🤖 Limite giornaliero di richieste raggiunto, riprova domani.");
          return true;
        }
        salvaStato(stato);
        const r = await rispondiAI(config, argomento || "Riassumi e commenta questo messaggio.", msg.quotedMessage?.body);
        await rispondi(`🤖 ${r}`);
        return true;
      }

      case "lookup": {
        const daMenzione = msg.mentionedIds?.[0] ? soloCifre(msg.mentionedIds[0]) : undefined;
        const numero = numeroDaTesto(argomento) ?? daMenzione;
        if (!numero) {
          salvaStato(stato);
          await rispondi("🔎 Scrivi /lookup seguito da un numero (es. /lookup +39 333 1234567) o menziona una persona con @.");
          return true;
        }
        if (!sottoTetto()) {
          salvaStato(stato);
          await rispondi("🔎 Limite giornaliero di richieste raggiunto, riprova domani.");
          return true;
        }
        salvaStato(stato);
        await rispondi(await lookup(openwa, numero));
        return true;
      }

      case "scribe": {
        const on = /^(on|si|sì|attiva)/i.test(argomento);
        const off = /^(off|no|spegni|disattiva)/i.test(argomento);
        if (on || off) stato.scribe.attiva = on;
        salvaStato(stato);
        await rispondi(
          `🎙️ Scribe è ${stato.scribe.attiva ? "attivo: trascrivo i vocali del gruppo" : "spento"}.` +
            (stato.scribe.attiva && !/\/trascrivi\/?$/.test(config.SCRIBE_URL) && !config.GROQ_API_KEY
              ? " ⚠️ Manca GROQ_API_KEY nel .env: per ora non posso trascrivere."
              : ""),
        );
        return true;
      }

      case "security": {
        if (/^on|^attiva/i.test(argomento)) stato.security.attiva = true;
        if (/^off|^spegni|^disattiva/i.test(argomento)) stato.security.attiva = false;
        salvaStato(stato);
        await rispondi(
          [
            `🛡️ Security è ${stato.security.attiva ? "*attiva*" : "*spenta*"}.`,
            "Quando è attiva rimuove link e parole vietate scritti da chi non è admin (serve che il numero collegato sia admin).",
            `Parole vietate: ${stato.security.paroleVietate.length ? stato.security.paroleVietate.join(", ") : "nessuna"}.`,
          ].join("\n"),
        );
        return true;
      }

      case "vieta":
      case "consenti": {
        const parola = normalizza(argomento).trim();
        if (!parola) {
          salvaStato(stato);
          await rispondi(`🛡️ Scrivi la parola dopo /${nome}.`);
          return true;
        }
        const lista = new Set(stato.security.paroleVietate);
        if (nome === "vieta") lista.add(parola);
        else lista.delete(parola);
        stato.security.paroleVietate = [...lista].sort();
        salvaStato(stato);
        await rispondi(`🛡️ Parole vietate: ${stato.security.paroleVietate.join(", ") || "nessuna"}.`);
        return true;
      }

      case "shop":
        salvaStato(stato);
        await rispondi(testoShop(caricaCatalogo(config)));
        return true;

      case "aggiungi":
      case "togli": {
        const catalogo = caricaCatalogo(config);
        const [primo, secondo] = argomento.split(/\s+/);
        const indice = Number(primo) - 1;
        const prodotto = catalogo.prodotti[indice] ?? catalogo.prodotti.find((p) => p.codice === normalizza(primo ?? ""));
        if (!prodotto) {
          salvaStato(stato);
          await rispondi(`🛒 Non trovo il prodotto "${primo ?? ""}". Scrivi /shop per l'elenco.`);
          return true;
        }
        const carrello = (stato.carrelli[cliente] ??= {});
        const quantita = Math.max(1, Math.min(99, Number(secondo) || 1));
        carrello[prodotto.codice] = Math.max(0, (carrello[prodotto.codice] ?? 0) + (nome === "aggiungi" ? quantita : -quantita));
        if (!carrello[prodotto.codice]) delete carrello[prodotto.codice];
        salvaStato(stato);
        await rispondi(`🛒 ${nome === "aggiungi" ? "Aggiunto" : "Tolto"}: ${prodotto.nome}.\n${riepilogo(carrello, catalogo).testo}`);
        return true;
      }

      case "carrello":
        salvaStato(stato);
        await rispondi(`🛒 Il tuo carrello:\n${riepilogo(stato.carrelli[cliente] ?? {}, caricaCatalogo(config)).testo}`);
        return true;

      case "svuota":
        delete stato.carrelli[cliente];
        salvaStato(stato);
        await rispondi("🛒 Carrello svuotato.");
        return true;

      case "ordina": {
        const catalogo = caricaCatalogo(config);
        const carrello = stato.carrelli[cliente] ?? {};
        const r = riepilogo(carrello, catalogo);
        if (r.totale === 0 && !r.daConfermare && !Object.keys(carrello).length) {
          salvaStato(stato);
          await rispondi(r.testo);
          return true;
        }
        const numero = (stato.ordini.at(-1)?.numero ?? 0) + 1;
        stato.ordini.push({
          numero,
          cliente,
          voci: Object.entries(carrello).map(([codice, quantita]) => {
            const p = catalogo.prodotti.find((x) => x.codice === codice);
            return { codice, nome: p?.nome ?? codice, quantita, prezzo: p?.prezzo ?? null };
          }),
          totale: r.totale,
          daConfermare: r.daConfermare,
          data: new Date().toISOString(),
        });
        delete stato.carrelli[cliente];
        salvaStato(stato);
        log.info(`Shop: ordine #${numero} di ${cliente}, totale ${r.totale}`);
        await rispondi(
          [
            `🧾 *Ordine #${numero}* registrato`,
            r.testo,
            "",
            `Per attivarlo: ${catalogo.link}`,
            "(Prototipo: il pagamento si completa sul sito di Doublegram; l'ordine resta salvato sul server.)",
          ].join("\n"),
        );
        return true;
      }
    }
  } catch (e) {
    log.errore(`Doublegram /${nome}: ${descriviErrore(e)}`);
    salvaStato(stato);
    await rispondi(`⚠️ /${nome} non è riuscito: ${descriviErrore(e)}`).catch(() => undefined);
    return true;
  }
  return false;
}
