import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { z } from "zod";
import { pulisciEmoji } from "./approvazioni.js";
import { chiediJson, creaClient } from "./claude.js";
import { DATI_DIR, PROJECT_DIR, type Config } from "./config.js";
import { creaCard } from "./grafica.js";
import { descriviErrore, type Logger } from "./log.js";
import { nomeDi } from "./memoria.js";
import { inviaImmagine, inviaSticker, inviaTesto, type ConfigOpenWA } from "./openwa.js";

/**
 * Il quiz di Jarvis, un gioco vero nel gruppo. WhatsApp (via whatsapp-web.js) non passa al motore né i
 * pulsanti interattivi né i voti dei sondaggi, ma passa le REAZIONI: così le 4 reazioni rapide di WhatsApp
 * diventano i pulsanti. Ogni domanda è una card con 4 riquadri colorati (👍 A · ❤️ B · 😂 C · 😮 D):
 * si tiene premuto sulla card e si tocca la reazione. Conta l'ultima reazione prima dello scadere;
 * risposta giusta = 100 punti + fino a 50 di bonus velocità. Classifica della partita e della settimana.
 */

const REAZIONI = ["👍", "❤", "😂", "😮"];
const COLORI = ["#3b82f6", "#ef4444", "#f59e0b", "#10b981"];
const FONT = ["Montserrat_800ExtraBold.ttf", "Montserrat_600SemiBold.ttf", "Montserrat_500Medium.ttf"].map((f) =>
  path.join(PROJECT_DIR, "assets", "post", f),
);

const QuizSchema = z.object({
  titolo: z.string().describe("Nome della partita, breve e simpatico"),
  domande: z.array(
    z.object({
      domanda: z.string().describe("Al massimo 110 caratteri"),
      opzioni: z.array(z.string()).describe("Esattamente 4 risposte, al massimo 38 caratteri ciascuna"),
      corretta: z.number().int().describe("Indice della risposta giusta, da 0 a 3"),
      spiegazione: z.string().describe("Perché è giusta, al massimo 160 caratteri, con un tocco di ironia da maggiordomo"),
    }),
  ),
});
type Domanda = z.infer<typeof QuizSchema>["domande"][number];

interface Partita {
  titolo: string;
  domande: Domanda[];
  indice: number;
  idDomanda?: string;
  inizio: number;
  durata: number;
  risposte: Map<string, { scelta: number; t: number }>;
  punti: Map<string, number>;
  stop: boolean;
}

let partita: Partita | undefined;
const attendi = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chiaveId = (id: string) => id.split("_")[2] ?? id;
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------- Grafica ----------

/** Le 4 icone delle reazioni, disegnate in vettoriale (resvg non ha le emoji a colori). */
function icona(i: number): string {
  const bordo = `stroke="#3b2a00" stroke-width="5" stroke-linejoin="round"`;
  const faccia = `<circle r="44" fill="#ffcc4d" ${bordo}/>`;
  switch (i) {
    case 0: // pollice in su
      return `<g transform="scale(0.95)"><rect x="-44" y="-6" width="22" height="50" rx="5" fill="#ffcc4d" ${bordo}/>
        <path d="M-18,-6 L2,-40 Q10,-54 20,-46 Q26,-40 22,-26 L18,-14 H38 Q52,-14 49,0 L43,32 Q40,44 28,44 H-18 Z" fill="#ffcc4d" ${bordo}/></g>`;
    case 1: // cuore
      return `<path d="M0,40 C-58,4 -42,-46 0,-20 C42,-46 58,4 0,40 Z" fill="#ff3b5c" stroke="#7a0016" stroke-width="5" stroke-linejoin="round"/>`;
    case 2: // risata con le lacrime
      return `${faccia}<path d="M-28,-14 Q-18,-26 -8,-14" fill="none" stroke="#3b2a00" stroke-width="6" stroke-linecap="round"/>
        <path d="M8,-14 Q18,-26 28,-14" fill="none" stroke="#3b2a00" stroke-width="6" stroke-linecap="round"/>
        <path d="M-28,4 H28 Q26,34 0,34 Q-26,34 -28,4 Z" fill="#6b2d00"/>
        <path d="M-44,-4 Q-56,10 -46,18 Q-38,12 -44,-4 Z M44,-4 Q56,10 46,18 Q38,12 44,-4 Z" fill="#5ab8ff"/>`;
    default: // stupore
      return `${faccia}<ellipse cx="-15" cy="-12" rx="7" ry="10" fill="#3b2a00"/><ellipse cx="15" cy="-12" rx="7" ry="10" fill="#3b2a00"/>
        <ellipse cx="0" cy="20" rx="11" ry="14" fill="#6b2d00"/>`;
  }
}

/** Va a capo per parole con una stima della larghezza (Montserrat ~0,58 em per carattere). */
function righe(testo: string, maxPx: number, dimensione: number, maxRighe: number): string[] {
  const perRiga = Math.floor(maxPx / (dimensione * 0.58));
  const out: string[] = [];
  let r = "";
  for (const p of testo.trim().split(/\s+/)) {
    if (r && (r + " " + p).length > perRiga) {
      out.push(r);
      r = p;
    } else r = r ? `${r} ${p}` : p;
  }
  if (r) out.push(r);
  if (out.length > maxRighe) out.splice(maxRighe - 1, out.length, out.slice(maxRighe - 1).join(" ").slice(0, perRiga - 1) + "…");
  return out;
}

export function cardDomanda(d: Domanda, numero: number, totale: number, durata: number): Buffer {
  const L = 1080;
  const dimD = d.domanda.length > 70 ? 50 : 58;
  const rD = righe(d.domanda, 940, dimD, 4);
  const riquadri = d.opzioni.slice(0, 4).map((o, i) => {
    const x = 60 + (i % 2) * 490;
    const y = 470 + Math.floor(i / 2) * 250;
    const r = righe(o, 300, 36, 3);
    return `<g>
      <rect x="${x}" y="${y}" width="470" height="225" rx="34" fill="${COLORI[i]}"/>
      <rect x="${x}" y="${y}" width="470" height="225" rx="34" fill="url(#lucido)"/>
      <g transform="translate(${x + 82},${y + 112})">${icona(i)}</g>
      ${r.map((t, j) => `<text x="${x + 160}" y="${y + 112 + (j - (r.length - 1) / 2) * 44 + 13}" font-family="Montserrat" font-weight="800" font-size="36" fill="#ffffff">${escape(t)}</text>`).join("")}
    </g>`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${L}" height="${L}" viewBox="0 0 ${L} ${L}">
  <defs>
    <linearGradient id="fondo" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#05061a"/><stop offset="0.6" stop-color="#0d0b33"/><stop offset="1" stop-color="#1c1160"/></linearGradient>
    <linearGradient id="lucido" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/><stop offset="0.5" stop-color="#ffffff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="${L}" height="${L}" fill="url(#fondo)"/>
  <text x="60" y="100" font-family="Montserrat" font-weight="600" font-size="30" letter-spacing="6" fill="#b9b2ff">QUIZ DI JARVIS · DOMANDA ${numero}/${totale}</text>
  <rect x="60" y="122" width="${(960 * numero) / totale}" height="8" rx="4" fill="#8f7bff"/>
  ${rD.map((t, i) => `<text x="60" y="${215 + i * dimD * 1.18}" font-family="Montserrat" font-weight="800" font-size="${dimD}" fill="#ffffff">${escape(t)}</text>`).join("")}
  ${riquadri.join("")}
  <text x="60" y="1035" font-family="Montserrat" font-weight="600" font-size="28" fill="#a597ff">Tieni premuto sulla card e scegli la reazione · ${durata} secondi</text>
</svg>`;
  return Buffer.from(
    new Resvg(svg, { fitTo: { mode: "width", value: L }, font: { fontFiles: FONT, loadSystemFonts: false, defaultFontFamily: "Montserrat" } }).render().asPng(),
  );
}

/** Sticker del trofeo con il nome del vincitore. */
function stickerTrofeo(nome: string): Buffer {
  const n = escape(nome.slice(0, 14));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <g stroke="#5a3a00" stroke-width="10" stroke-linejoin="round">
    <path d="M150,70 H362 V170 Q362,280 256,300 Q150,280 150,170 Z" fill="#ffc83d"/>
    <path d="M150,100 H95 Q90,190 165,210 M362,100 H417 Q422,190 347,210" fill="none"/>
    <rect x="226" y="296" width="60" height="60" fill="#ffb000"/>
    <rect x="170" y="352" width="172" height="44" rx="10" fill="#8f7bff"/>
  </g>
  <path d="M200,110 Q205,200 250,250" stroke="#fff3c4" stroke-width="14" fill="none" stroke-linecap="round" opacity="0.8"/>
  <text x="256" y="470" text-anchor="middle" font-family="Montserrat" font-weight="800" font-size="${n.length > 9 ? 52 : 66}" fill="#1c1160" stroke="#ffffff" stroke-width="14" paint-order="stroke">${n.toUpperCase()}</text>
</svg>`;
  return Buffer.from(new Resvg(svg, { background: "rgba(0,0,0,0)", font: { fontFiles: FONT, loadSystemFonts: false, defaultFontFamily: "Montserrat" } }).render().asPng());
}

// ---------- Classifica settimanale ----------

const FILE = path.join(DATI_DIR, ".quiz.json");

function settimana(d = new Date()): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const g = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - g);
  const anno = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-S${Math.ceil(((t.getTime() - anno.getTime()) / 86_400_000 + 1) / 7)}`;
}

function caricaClassifica(): { settimana: string; punti: Record<string, number>; partite: number } {
  try {
    const c = JSON.parse(fs.readFileSync(FILE, "utf8")) as { settimana: string; punti: Record<string, number>; partite: number };
    if (c.settimana === settimana()) return c;
  } catch {
    /* prima partita */
  }
  return { settimana: settimana(), punti: {}, partite: 0 };
}

export function classificaSettimana(): string {
  const c = caricaClassifica();
  const voci = Object.entries(c.punti).sort((a, b) => b[1] - a[1]);
  if (!voci.length) return "🏆 Nessuna partita questa settimana. Si comincia con /quiz!";
  const medaglie = ["🥇", "🥈", "🥉"];
  return `🏆 *Classifica della settimana* (${c.partite} ${c.partite === 1 ? "partita" : "partite"})\n${voci.map(([id, p], i) => `${medaglie[i] ?? `${i + 1}.`} ${nomeDi(id)} – ${p} punti`).join("\n")}`;
}

// ---------- Partita ----------

export function quizInCorso(): boolean {
  return Boolean(partita && !partita.stop);
}

export function fermaQuiz(): boolean {
  if (!partita) return false;
  partita.stop = true;
  return true;
}

/** Una reazione su una domanda in corso: la registra. Restituisce true se riguardava il quiz. */
export function reazioneQuiz(evento: { messageId?: string; reaction?: string; senderId?: string }): boolean {
  const p = partita;
  if (!p?.idDomanda || !evento.messageId || chiaveId(evento.messageId) !== chiaveId(p.idDomanda) || !evento.senderId) return false;
  const t = Date.now() - p.inizio;
  if (t > p.durata * 1000 + 1500) return true; // tempo scaduto
  const scelta = REAZIONI.indexOf(pulisciEmoji(evento.reaction ?? ""));
  if (scelta < 0) p.risposte.delete(evento.senderId); // reazione tolta o non valida
  else p.risposte.set(evento.senderId, { scelta, t });
  return true;
}

const LETTERE = ["A", "B", "C", "D"];

export async function avviaQuiz(
  ctx: { config: Config; log: Logger; openwa: ConfigOpenWA },
  tema: string,
  numero = 5,
  durata = 30,
): Promise<string> {
  if (quizInCorso()) return "C'è già un quiz in corso: aspetti che finisca, o lo fermi con /quiz stop.";
  const { config, log, openwa } = ctx;
  const n = Math.max(3, Math.min(10, Math.trunc(numero) || 5));
  const secondi = Math.max(15, Math.min(60, Math.trunc(durata) || 30));
  const esito = await chiediJson(creaClient(config), config, {
    nome: "quiz",
    ruolo: "scrittura",
    system: `Prepari quiz a scelta multipla per un gruppo di colleghi di una startup (Doublegram, bot per community Telegram).
Domande in italiano, chiare e non ambigue, difficoltà crescente, una sola risposta giusta e 3 sbagliate plausibili.
Solo fatti certi e verificabili (niente notizie recenti di cui non sei sicuro). Su Doublegram usa solo: suite di bot per
Telegram (Security, Scribe, Doublegram AI, Lookup), Free e Premium a 9,99 $/mese, doublegram.com. Varia la posizione della risposta giusta.`,
    schema: QuizSchema,
    contenuto: [{ type: "text", text: `Tema: ${tema || "misto: Telegram, community online, vendite B2B, cultura generale"}\nNumero di domande: ${n}` }],
  });
  const domande = esito.domande.filter((d) => d.opzioni.length === 4 && d.corretta >= 0 && d.corretta <= 3).slice(0, n);
  if (domande.length < 3) return "Non sono riuscito a preparare domande valide: riprovi con un altro tema.";
  partita = { titolo: esito.titolo, domande, indice: 0, inizio: 0, durata: secondi, risposte: new Map(), punti: new Map(), stop: false };
  void giocaPartita(ctx, partita).catch((e) => {
    log.errore(`Quiz: ${descriviErrore(e)}`);
    partita = undefined;
  });
  return `Quiz "${esito.titolo}" avviato: ${domande.length} domande da ${secondi} secondi.`;
}

async function giocaPartita(ctx: { config: Config; log: Logger; openwa: ConfigOpenWA }, p: Partita): Promise<void> {
  const { openwa, log } = ctx;
  await inviaTesto(
    openwa,
    `🎲 *${p.titolo}*\n${p.domande.length} domande, ${p.durata} secondi l'una.\n\n*Come si gioca:* su ogni domanda tieni premuto e scegli la reazione:\n👍 = A · ❤️ = B · 😂 = C · 😮 = D\nConta l'ultima scelta prima dello scadere. Giusta = 100 punti, più un bonus fino a 50 se sei veloce.\n\nSi comincia tra 10 secondi, Signori.`,
  );
  await attendi(10_000);
  for (; p.indice < p.domande.length && !p.stop; p.indice++) {
    const d = p.domande[p.indice]!;
    p.risposte = new Map();
    const card = cardDomanda(d, p.indice + 1, p.domande.length, p.durata);
    p.idDomanda = await inviaImmagine(openwa, card, `❓ ${d.domanda}\n👍 A · ❤️ B · 😂 C · 😮 D  ⏱️ ${p.durata}s`);
    p.inizio = Date.now();
    await attendi((p.durata - 10) * 1000);
    if (!p.stop) await inviaTesto(openwa, "⏳ 10 secondi!").catch(() => undefined);
    await attendi(10_000 + 1500);
    p.idDomanda = undefined;
    if (p.stop) break;
    const giusti: string[] = [];
    const sbagliati: string[] = [];
    for (const [chi, r] of [...p.risposte.entries()].sort((a, b) => a[1].t - b[1].t)) {
      if (r.scelta === d.corretta) {
        const punti = 100 + Math.round(50 * Math.max(0, 1 - r.t / (p.durata * 1000)));
        p.punti.set(chi, (p.punti.get(chi) ?? 0) + punti);
        giusti.push(`${nomeDi(chi)} +${punti}`);
      } else sbagliati.push(nomeDi(chi));
    }
    const classifica = [...p.punti.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    await inviaTesto(
      openwa,
      [
        `✅ Era la *${LETTERE[d.corretta]}* ${REAZIONI[d.corretta] === "❤" ? "❤️" : REAZIONI[d.corretta]}: ${d.opzioni[d.corretta]}`,
        `🎩 ${d.spiegazione}`,
        "",
        giusti.length ? `🏅 ${giusti.join(" · ")}` : "🫥 Nessuno ha indovinato.",
        sbagliati.length ? `😬 ${sbagliati.join(", ")}` : "",
        classifica.length ? `\n📊 ${classifica.map(([c, pt]) => `${nomeDi(c)} ${pt}`).join(" · ")}` : "",
      ]
        .filter((r) => r !== "")
        .join("\n"),
    );
    await attendi(6000);
  }

  const finale = [...p.punti.entries()].sort((a, b) => b[1] - a[1]);
  const c = caricaClassifica();
  for (const [chi, pt] of finale) c.punti[chi] = (c.punti[chi] ?? 0) + pt;
  c.partite += 1;
  fs.mkdirSync(DATI_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(c, null, 2) + "\n", "utf8");
  partita = undefined;
  if (!finale.length) {
    await inviaTesto(openwa, `🎩 Fine del quiz${p.stop ? " (interrotto)" : ""}. Nessun punto assegnato: la prossima volta mi aspetto più entusiasmo, Signori.`);
    return;
  }
  const [primo, punti] = finale[0]!;
  const medaglie = ["🥇", "🥈", "🥉"];
  await inviaImmagine(
    openwa,
    creaCard({ etichetta: "CAMPIONE DEL QUIZ", titolo: nomeDi(primo).slice(0, 22), sottotitolo: `${punti} punti` }, ctx.config.SHARED_DIR),
  );
  await inviaSticker(openwa, stickerTrofeo(nomeDi(primo))).catch((e) => log.avviso(`Quiz, sticker: ${descriviErrore(e)}`));
  await inviaTesto(
    openwa,
    `🏁 *Classifica finale*\n${finale.map(([chi, pt], i) => `${medaglie[i] ?? `${i + 1}.`} ${nomeDi(chi)} – ${pt}`).join("\n")}\n\n🎩 Complimenti a ${nomeDi(primo)}. Agli altri consiglio un ripasso.\n\n${classificaSettimana()}`,
  );
  log.info(`Quiz finito: vince ${nomeDi(primo)} con ${punti} punti`);
}
