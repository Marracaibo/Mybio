import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { chiediJson, creaClient } from "./claude.js";
import { DATI_DIR, type Config } from "./config.js";
import { creaCard } from "./grafica.js";
import type { Logger } from "./log.js";
import { inviaImmagine, inviaTesto, type ConfigOpenWA } from "./openwa.js";
import { leggiLineeGuida } from "./pipeline.js";
import { inizioTesto, oggi, slug } from "./testo.js";

/**
 * /post nel gruppo: post per il canale Telegram nello stile di Doublegram News (testo + card).
 * Se mancano informazioni Claude fa le domande; si risponde citando il suo messaggio.
 * Citando il post o la card con una richiesta ("più corto", "cambia titolo") lo si rifà.
 */

const PostSchema = z.object({
  servono_informazioni: z.boolean().describe("true se mancano fatti indispensabili e bisogna chiederli"),
  domande: z.array(z.string()).describe("Domande in italiano, solo se servono_informazioni; al massimo 4"),
  etichetta: z.string().describe("1-3 parole per la card, es. LAUNCH ALERT, NOW LIVE, NEW FEATURE"),
  titolo_immagine: z.string().describe("Titolo grande della card, al massimo 22 caratteri"),
  sottotitolo_immagine: z.string().describe("Riga sotto il titolo, al massimo 45 caratteri, oppure vuota"),
  testo_post: z.string().describe("Il post completo per il canale Telegram"),
});
type Post = z.infer<typeof PostSchema>;

const ESEMPI = `Esempio 1 (card: LAUNCH ALERT / JUNE 21st / doublegram.com):
💎 **Hello everyone!**

We've been quiet, but we've been working on the **biggest update Doublegram has ever seen!**

We think our users deserve a **better experience on Telegram**, and we've been working very hard on our platform to bring a **fresh experience**, with **new tools and features** for our users.

We thank **each and every one of you** for supporting us and believing in us.

» **See you on June 21st** with the latest news!

Esempio 2 (card: illustrazione di Scribe):
Doublegram Scribe now **transcribes messages with higher accuracy** — and **transcriptions are free in your groups**.

We've also introduced the ability for Core members to decide whether to **enable AI features in their groups**, and we've introduced new features to **decide how many AI credits users in a group can use and over what period**.

Many more updates coming! 💎`;

function sistema(lineeGuida: string): string {
  return `Sei il social media manager di Doublegram e scrivi i post del canale Telegram "Doublegram News".
Doublegram è una suite di bot per Telegram: Security (captcha e anti-raid), Scribe (trascrizione dei vocali e AI nei gruppi),
Doublegram AI (assistente e creazione di contenuti per i canali), Lookup (informazioni su utenti, gruppi e canali).
Piano Free e Premium a 9,99 $/mese; sito doublegram.com.

Stile (vedi esempi): frasi brevi e calde, paragrafi corti separati da una riga vuota, le parti chiave in **grassetto**
(sintassi **testo**, che Telegram converte), qualche emoji senza esagerare, chiusura con un invito o un "stay tuned".
Lingua: inglese, come il canale, a meno che la richiesta chieda un'altra lingua. Massimo 900 caratteri.

Regole sui fatti:
- Non inventare date, prezzi, numeri, nomi di funzioni o link. Usa solo quello che è nella richiesta, nelle risposte
  del team, qui sopra o nelle linee guida.
- Se manca qualcosa di indispensabile per un buon post (es. cos'è il prodotto, la data di uscita, le 2-3 novità
  principali, il link), metti servono_informazioni a true e fai domande precise in italiano (al massimo 4).
  In quel caso compila comunque gli altri campi con una prima proposta.
- Se le informazioni bastano, servono_informazioni è false e domande è vuota.

La card (immagine 1:1) ha: etichetta spaziata in maiuscolo, un titolo enorme (una data, il nome del prodotto o 2-3 parole),
un sottotitolo facoltativo e doublegram.com in basso.

${ESEMPI}

--- LINEE GUIDA DEL PROFILO (fatti verificati su Doublegram) ---
${lineeGuida.trim()}
--- FINE LINEE GUIDA ---`;
}

interface Lavoro {
  richiesta: string;
  scambi: string[];
  ultimo?: Post;
  file?: string;
  data: string;
}

interface StatoPost {
  /** chiave: id del messaggio del bot, oppure "inizio:<testo>" per riconoscerlo dal testo citato */
  lavori: Record<string, Lavoro>;
}

const FILE_STATO = path.join(DATI_DIR, ".post.json");

function caricaStato(): StatoPost {
  try {
    return { lavori: (JSON.parse(fs.readFileSync(FILE_STATO, "utf8")) as StatoPost).lavori ?? {} };
  } catch {
    return { lavori: {} };
  }
}

function salvaStato(s: StatoPost): void {
  const voci = Object.entries(s.lavori).sort((a, b) => a[1].data.localeCompare(b[1].data)).slice(-200);
  fs.mkdirSync(DATI_DIR, { recursive: true });
  fs.writeFileSync(FILE_STATO, JSON.stringify({ lavori: Object.fromEntries(voci) }, null, 2) + "\n", "utf8");
}

const chiaveId = (id: string) => {
  const parti = id.split("_");
  return parti.length >= 3 ? (parti[2] ?? id) : id;
};

/** Il lavoro a cui si riferisce un messaggio citato (domande, card o testo di un post), se c'è. */
export function lavoroCitato(citato: { id?: string; body?: string } | undefined): Lavoro | undefined {
  if (!citato) return undefined;
  const { lavori } = caricaStato();
  if (citato.id) {
    if (lavori[citato.id]) return lavori[citato.id];
    const k = chiaveId(citato.id);
    const trovato = Object.entries(lavori).find(([id]) => !id.startsWith("inizio:") && chiaveId(id) === k);
    if (trovato) return trovato[1];
  }
  if (citato.body && citato.body.length >= 20) {
    const inizio = inizioTesto(citato.body);
    const trovato = Object.entries(lavori)
      .reverse()
      .find(([id]) => id.startsWith("inizio:") && (inizio.startsWith(id.slice(7)) || id.slice(7).startsWith(inizio)));
    if (trovato) return trovato[1];
  }
  return undefined;
}

function registra(lavoro: Lavoro, id: string | undefined, testo: string): void {
  const s = caricaStato();
  if (id) s.lavori[id] = lavoro;
  if (testo) s.lavori[`inizio:${inizioTesto(testo)}`] = lavoro;
  salvaStato(s);
}

/**
 * Crea o rifà un post. `lavoro` esistente: si aggiungono le risposte o la richiesta di modifica (`aggiunta`).
 */
export async function lavoraPost(
  ctx: { config: Config; log: Logger; openwa: ConfigOpenWA },
  richiesta: string,
  lavoro?: Lavoro,
  aggiunta?: string,
  rispondiA?: string,
): Promise<void> {
  const { config, log, openwa } = ctx;
  const corrente: Lavoro = lavoro
    ? { ...lavoro, scambi: [...lavoro.scambi, aggiunta ?? ""], data: new Date().toISOString() }
    : { richiesta, scambi: [], data: new Date().toISOString() };

  const parti = [`Richiesta del team: ${corrente.richiesta}`];
  if (corrente.ultimo) {
    parti.push(
      "",
      "Ultima versione proposta:",
      `Card: ${corrente.ultimo.etichetta} / ${corrente.ultimo.titolo_immagine} / ${corrente.ultimo.sottotitolo_immagine}`,
      corrente.ultimo.testo_post,
    );
  }
  for (const s of corrente.scambi) parti.push("", `Il team aggiunge: ${s}`);
  if (corrente.scambi.length >= 2) parti.push("", "Hai già chiesto informazioni: ora scrivi il post con quello che hai.");

  const esito = await chiediJson(creaClient(config), config, {
    nome: "post-canale",
    ruolo: "scrittura",
    system: sistema(leggiLineeGuida(config.SHARED_DIR)),
    schema: PostSchema,
    contenuto: [{ type: "text", text: parti.join("\n") }],
  });
  corrente.ultimo = esito;
  const opzioni = rispondiA ? { quotedMessageId: rispondiA } : {};

  if (esito.servono_informazioni && esito.domande.length && corrente.scambi.length < 2) {
    const testo = [
      "📝 Per scrivere bene il post mi servono ancora:",
      ...esito.domande.slice(0, 4).map((d, i) => `${i + 1}. ${d}`),
      "",
      "Rispondi citando questo messaggio (anche tutto in un messaggio solo).",
    ].join("\n");
    const id = await inviaTesto(openwa, testo, opzioni).catch(() => inviaTesto(openwa, testo));
    registra(corrente, id, testo);
    log.info(`Post: chieste ${esito.domande.length} informazioni`);
    return;
  }

  const card = creaCard(
    { etichetta: esito.etichetta, titolo: esito.titolo_immagine, sottotitolo: esito.sottotitolo_immagine || undefined },
    config.SHARED_DIR,
  );
  const cartella = path.join(config.SHARED_DIR, "05-post");
  fs.mkdirSync(cartella, { recursive: true });
  const base = corrente.file ?? `${oggi()}_${slug(esito.titolo_immagine || corrente.richiesta)}`;
  corrente.file = base;
  fs.writeFileSync(path.join(cartella, `${base}.png`), card);
  fs.writeFileSync(path.join(cartella, `${base}.md`), `${esito.testo_post.trim()}\n`, "utf8");

  const idCard = await inviaImmagine(openwa, card);
  const testo = esito.testo_post.trim();
  const idTesto = await inviaTesto(openwa, testo);
  const nota = "✏️ Per modificarlo rispondi citando la card o il testo (es. \"più corto\", \"cambia titolo in …\", \"in italiano\").";
  await inviaTesto(openwa, nota).catch(() => undefined);
  registra(corrente, idCard, "");
  registra(corrente, idTesto, testo);
  log.info(`Post: creato ${base} (card + testo)`);
}
