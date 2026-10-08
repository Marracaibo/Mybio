import fs from "node:fs";
import path from "node:path";
import { DATI_DIR } from "./config.js";

/**
 * Linear SIMULATO: compiti con id DG-xxx, stati, assegnatari, scadenze ed etichette, salvati in /dati/.linear.json.
 * Ha la stessa forma dei compiti decisi dal team (per l'etichetta "agent": obiettivo, criteri di accettazione,
 * file coinvolti), così quando lo colleghiamo all'API vera di Linear cambia solo questo modulo.
 */

export const AVVISO_LINEAR = "LINEAR SIMULATO (i compiti non sono ancora su Linear vero)";

export type Stato = "Backlog" | "Todo" | "In Progress" | "In Review" | "Done" | "Canceled";
const STATI: Stato[] = ["Backlog", "Todo", "In Progress", "In Review", "Done", "Canceled"];

export interface Compito {
  id: string;
  titolo: string;
  descrizione: string;
  stato: Stato;
  assegnatario: string;
  priorita: "Urgente" | "Alta" | "Media" | "Bassa" | "Nessuna";
  scadenza?: string;
  etichette: string[];
  obiettivo?: string;
  criteri_accettazione?: string[];
  file_coinvolti?: string[];
  creato: string;
  aggiornato: string;
  commenti: Array<{ autore: string; testo: string; data: string }>;
}

interface Archivio {
  prossimo: number;
  compiti: Compito[];
}

const FILE = path.join(DATI_DIR, ".linear.json");

function giorni(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
}

/** Qualche compito di partenza, coerente con quello che si dice nel gruppo e con i dati simulati. */
function iniziale(): Archivio {
  const ora = new Date().toISOString();
  const base = (c: Partial<Compito> & Pick<Compito, "titolo">, n: number): Compito => ({
    id: `DG-${100 + n}`,
    descrizione: "",
    stato: "Todo",
    assegnatario: "da assegnare",
    priorita: "Media",
    etichette: [],
    creato: ora,
    aggiornato: ora,
    commenti: [],
    ...c,
  });
  const compiti = [
    base({ titolo: "Captcha di Security non compare su Android", stato: "In Progress", priorita: "Urgente", etichette: ["bug", "security"], scadenza: giorni(2), descrizione: "Dall'ultimo aggiornamento i nuovi membri su Android restano bloccati." }, 1),
    base({ titolo: "Slide della dashboard per la demo", priorita: "Alta", etichette: ["vendite"], scadenza: giorni(1) }, 2),
    base({ titolo: "Logo definitivo di Telegarden", etichette: ["design", "telegarden"], scadenza: giorni(3) }, 3),
    base({ titolo: "Rinnovo del server di test", priorita: "Bassa", etichette: ["infra"], scadenza: giorni(20) }, 4),
    base({ titolo: "Piano annuale scontato: proposta prezzi", stato: "Backlog", etichette: ["prodotto", "pricing"] }, 5),
    base({
      titolo: "Risposta automatica del bot di supporto per i ticket sul captcha",
      stato: "Backlog",
      etichette: ["agent", "supporto"],
      obiettivo: "Ridurre i ticket ripetuti sul captcha Android finché il bug non è risolto",
      criteri_accettazione: ["Chi scrive 'captcha' riceve subito la soluzione temporanea", "I ticket sul captcha calano di almeno il 50%"],
      file_coinvolti: ["support-bot/risposte.yml"],
    }, 6),
  ];
  return { prossimo: 107, compiti };
}

function carica(): Archivio {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8")) as Archivio;
  } catch {
    const a = iniziale();
    salva(a);
    return a;
  }
}

function salva(a: Archivio): void {
  fs.mkdirSync(DATI_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(a, null, 2) + "\n", "utf8");
}

const breve = (c: Compito) =>
  `${c.id} [${c.stato}] ${c.titolo} · ${c.assegnatario} · priorità ${c.priorita}${c.scadenza ? ` · scade ${c.scadenza}` : ""}${c.etichette.length ? ` · #${c.etichette.join(" #")}` : ""}`;

export function creaCompito(dati: {
  titolo: string;
  descrizione?: string;
  assegnatario?: string;
  priorita?: string;
  scadenza?: string;
  etichette?: string[];
  obiettivo?: string;
  criteri_accettazione?: string[];
  file_coinvolti?: string[];
  autore?: string;
}): string {
  const a = carica();
  const ora = new Date().toISOString();
  const priorita = (["Urgente", "Alta", "Media", "Bassa", "Nessuna"] as const).find((p) => p.toLowerCase() === (dati.priorita ?? "").toLowerCase()) ?? "Media";
  const etichette = (dati.etichette ?? []).map((e) => e.toLowerCase().replace(/^#/, "")).filter(Boolean);
  if (etichette.includes("agent") && (!dati.obiettivo || !dati.criteri_accettazione?.length)) {
    return `${AVVISO_LINEAR}. Regola del team: i compiti con l'etichetta "agent" devono avere obiettivo e criteri di accettazione (e i file coinvolti, se noti).`;
  }
  const c: Compito = {
    id: `DG-${a.prossimo++}`,
    titolo: dati.titolo.slice(0, 200),
    descrizione: dati.descrizione ?? "",
    stato: "Todo",
    assegnatario: dati.assegnatario?.trim() || "da assegnare",
    priorita,
    scadenza: /^\d{4}-\d{2}-\d{2}$/.test(dati.scadenza ?? "") ? dati.scadenza : undefined,
    etichette,
    obiettivo: dati.obiettivo || undefined,
    criteri_accettazione: dati.criteri_accettazione?.length ? dati.criteri_accettazione : undefined,
    file_coinvolti: dati.file_coinvolti?.length ? dati.file_coinvolti : undefined,
    creato: ora,
    aggiornato: ora,
    commenti: dati.autore ? [{ autore: dati.autore, testo: "Creato dal gruppo WhatsApp tramite Jarvis", data: ora }] : [],
  };
  a.compiti.push(c);
  salva(a);
  return `${AVVISO_LINEAR}. Creato: ${breve(c)}`;
}

export function cercaCompiti(filtro: { testo?: string; stato?: string; assegnatario?: string; in_scadenza_giorni?: number }): string {
  const a = carica();
  const t = (filtro.testo ?? "").toLowerCase();
  const limite = filtro.in_scadenza_giorni ? giorni(filtro.in_scadenza_giorni) : "";
  const trovati = a.compiti.filter(
    (c) =>
      (!t || `${c.id} ${c.titolo} ${c.descrizione} ${c.etichette.join(" ")}`.toLowerCase().includes(t)) &&
      (!filtro.stato || c.stato.toLowerCase() === filtro.stato.toLowerCase() || (filtro.stato === "aperti" && !["Done", "Canceled"].includes(c.stato))) &&
      (!filtro.assegnatario || c.assegnatario.toLowerCase().includes(filtro.assegnatario.toLowerCase())) &&
      (!limite || (c.scadenza !== undefined && c.scadenza <= limite && !["Done", "Canceled"].includes(c.stato))),
  );
  if (!trovati.length) return `${AVVISO_LINEAR}. Nessun compito trovato.`;
  return `${AVVISO_LINEAR}. ${trovati.length} compiti:\n${trovati
    .map((c) => {
      const extra = [
        c.descrizione && `  descrizione: ${c.descrizione.slice(0, 200)}`,
        c.obiettivo && `  obiettivo: ${c.obiettivo}`,
        c.criteri_accettazione && `  criteri: ${c.criteri_accettazione.join("; ")}`,
        c.file_coinvolti && `  file: ${c.file_coinvolti.join(", ")}`,
        c.commenti.length > 0 && `  ultimo commento: ${c.commenti.at(-1)!.autore}: ${c.commenti.at(-1)!.testo.slice(0, 120)}`,
      ].filter(Boolean);
      return [breve(c), ...extra].join("\n");
    })
    .join("\n")}`;
}

export function aggiornaCompito(dati: { id: string; stato?: string; assegnatario?: string; priorita?: string; scadenza?: string; commento?: string; autore?: string }): string {
  const a = carica();
  const c = a.compiti.find((x) => x.id.toLowerCase() === dati.id.trim().toLowerCase());
  if (!c) return `${AVVISO_LINEAR}. Non trovo il compito ${dati.id}.`;
  const stato = STATI.find((s) => s.toLowerCase() === (dati.stato ?? "").toLowerCase());
  if (stato) c.stato = stato;
  if (dati.assegnatario) c.assegnatario = dati.assegnatario;
  const priorita = (["Urgente", "Alta", "Media", "Bassa", "Nessuna"] as const).find((p) => p.toLowerCase() === (dati.priorita ?? "").toLowerCase());
  if (priorita) c.priorita = priorita;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dati.scadenza ?? "")) c.scadenza = dati.scadenza;
  if (dati.commento) c.commenti.push({ autore: dati.autore ?? "Jarvis", testo: dati.commento, data: new Date().toISOString() });
  c.aggiornato = new Date().toISOString();
  salva(a);
  return `${AVVISO_LINEAR}. Aggiornato: ${breve(c)}`;
}
