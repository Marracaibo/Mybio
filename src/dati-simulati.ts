/**
 * Dati di Doublegram SIMULATI per il maggiordomo: utenti, abbonati Premium, ricavi, costi, disdette.
 * Sono numeri inventati ma coerenti nel tempo (stesso giorno → stessi numeri), utili per provare domande come
 * "quanti abbonati abbiamo oggi?", "com'è andato il mese?", "perché perdiamo clienti?".
 * Quando ci sarà un accesso ai dati veri, basta sostituire questo modulo con chiamate alle API di Doublegram.
 */

export const AVVISO_SIMULATI = "DATI SIMULATI (non sono i numeri reali di Doublegram)";

const INIZIO = Date.UTC(2025, 2, 1); // 1 marzo 2025
const GIORNO = 86_400_000;
const PREZZO_PREMIUM = 9.99;
const PREZZO_CREDITI = 4.99;

export interface Giorno {
  data: string;
  nuovi_utenti: number;
  utenti_totali: number;
  attivi_30g: number;
  gruppi_gestiti: number;
  nuovi_premium: number;
  disdette_premium: number;
  premium_attivi: number;
  mrr: number;
  vendite_crediti: number;
  ricavi: number;
  costi: number;
}

/** Numero pseudo-casuale in [0, 1) fisso per (giorno, canale). */
function caso(giorno: number, canale: number): number {
  let x = (giorno * 374761393 + canale * 668265263) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

let cache: Giorno[] | undefined;
let cacheGiorno = "";

/** Tutta la storia giorno per giorno, dal lancio a oggi. */
export function storia(oggi = new Date()): Giorno[] {
  const chiave = oggi.toISOString().slice(0, 10);
  if (cache && cacheGiorno === chiave) return cache;
  const fine = Math.floor((Date.UTC(oggi.getUTCFullYear(), oggi.getUTCMonth(), oggi.getUTCDate()) - INIZIO) / GIORNO);
  const out: Giorno[] = [];
  let utenti = 1800;
  let premium = 40;
  for (let t = 0; t <= fine; t++) {
    const data = new Date(INIZIO + t * GIORNO);
    const dow = data.getUTCDay();
    const settimana = dow === 0 || dow === 6 ? 0.72 : 1;
    // Crescita lenta, con un picco a maggio 2026 (Product Hunt) e un rallentamento nelle ultime 3 settimane.
    const recente = t > fine - 21;
    const picco = t >= 430 && t < 437 ? 3.2 : 1;
    const nuovi = Math.round((22 + 0.05 * t) * settimana * picco * (recente ? 0.82 : 1) * (0.75 + 0.5 * caso(t, 1)));
    utenti += nuovi;
    const attivi = Math.round(utenti * (0.36 + 0.04 * Math.sin(t / 40)) * (0.97 + 0.06 * caso(t, 2)));
    const conversioni = nuovi * 0.012 + attivi * 0.00013;
    const nuoviPremium = Math.max(0, Math.round(conversioni * (0.5 + caso(t, 3))));
    // Disdette: ~4,5% al mese, salite a ~8% nelle ultime 3 settimane.
    const tasso = recente ? 0.0027 : 0.0015;
    const disdette = Math.max(0, Math.round(premium * tasso * (0.4 + 1.2 * caso(t, 4))));
    premium = Math.max(0, premium + nuoviPremium - disdette);
    const crediti = Math.round(attivi * 0.0011 * (0.5 + caso(t, 5)));
    const ricavi = (premium * PREZZO_PREMIUM) / 30.4 + crediti * PREZZO_CREDITI;
    // Costi: server e servizi fissi, API AI che crescono con l'uso, marketing (più alto dopo maggio 2026).
    const costi = 70 + attivi * 0.0095 * (0.9 + 0.2 * caso(t, 6)) + (t >= 425 ? 55 : 20);
    out.push({
      data: data.toISOString().slice(0, 10),
      nuovi_utenti: nuovi,
      utenti_totali: utenti,
      attivi_30g: attivi,
      gruppi_gestiti: Math.round(utenti * 0.128),
      nuovi_premium: nuoviPremium,
      disdette_premium: disdette,
      premium_attivi: premium,
      mrr: r2(premium * PREZZO_PREMIUM),
      vendite_crediti: crediti,
      ricavi: r2(ricavi),
      costi: r2(costi),
    });
  }
  cache = out;
  cacheGiorno = chiave;
  return out;
}

/** Quote fisse di contorno (paesi, prodotti, motivi delle disdette), in base allo stato del periodo. */
function contorno(ultimo: Giorno, disdetteRecenti: boolean) {
  return {
    paesi_utenti_pct: { Italia: 21, India: 14, Brasile: 11, "Stati Uniti": 9, Spagna: 7, Indonesia: 6, Germania: 5, altri: 27 },
    uso_prodotti_ultimi_30g: {
      security_gruppi_protetti: Math.round(ultimo.gruppi_gestiti * 0.62),
      scribe_minuti_trascritti: Math.round(ultimo.attivi_30g * 3.4),
      ai_richieste: Math.round(ultimo.attivi_30g * 11.8),
      lookup_ricerche: Math.round(ultimo.attivi_30g * 2.1),
    },
    canali_acquisizione_pct: { "passaparola e gruppi": 38, "ricerca Google": 22, "Telegram Ads": 17, "social e creator": 15, "Product Hunt e directory": 8 },
    motivi_disdetta_pct: disdetteRecenti
      ? { "funzioni ora gratis in Telegram (benvenuto, filtri)": 34, "prezzo": 24, "uso troppo basso": 21, "bug o problemi tecnici": 12, "passato a un concorrente": 9 }
      : { prezzo: 31, "uso troppo basso": 29, "bug o problemi tecnici": 18, "passato a un concorrente": 12, altro: 10 },
  };
}

/** Riepilogo di un periodo (date YYYY-MM-DD, estremi inclusi) per il maggiordomo. */
export function riepilogo(da: string, a: string): Record<string, unknown> {
  const tutti = storia();
  const primo = tutti[0]!.data;
  const ultimoGiorno = tutti.at(-1)!.data;
  const inizio = da < primo ? primo : da;
  const fine = a > ultimoGiorno ? ultimoGiorno : a;
  const giorni = tutti.filter((g) => g.data >= inizio && g.data <= fine);
  if (!giorni.length) return { avviso: AVVISO_SIMULATI, errore: `Nessun dato tra ${da} e ${a}: i dati vanno dal ${primo} al ${ultimoGiorno}.` };
  const prima = tutti[tutti.indexOf(giorni[0]!) - 1] ?? giorni[0]!;
  const ultimo = giorni.at(-1)!;
  const somma = (k: keyof Giorno) => giorni.reduce((s, g) => s + (g[k] as number), 0);
  const ricavi = somma("ricavi");
  const costi = somma("costi");
  const nuoviPremium = somma("nuovi_premium");
  const disdette = somma("disdette_premium");
  const mesi = giorni.length / 30.4;
  const serie =
    giorni.length <= 45
      ? giorni
      : giorni.filter((_, i) => i % 7 === 6 || i === giorni.length - 1); // una riga a settimana
  return {
    avviso: AVVISO_SIMULATI,
    periodo: { da: giorni[0]!.data, a: ultimo.data, giorni: giorni.length },
    all_inizio: { utenti_totali: prima.utenti_totali, premium_attivi: prima.premium_attivi, mrr_usd: prima.mrr },
    alla_fine: {
      utenti_totali: ultimo.utenti_totali,
      attivi_30g: ultimo.attivi_30g,
      gruppi_gestiti: ultimo.gruppi_gestiti,
      premium_attivi: ultimo.premium_attivi,
      mrr_usd: ultimo.mrr,
    },
    totali_periodo: {
      nuovi_utenti: somma("nuovi_utenti"),
      nuovi_premium: nuoviPremium,
      disdette_premium: disdette,
      vendite_pacchetti_crediti_ai: somma("vendite_crediti"),
      ricavi_usd: r2(ricavi),
      costi_usd: r2(costi),
      margine_usd: r2(ricavi - costi),
    },
    indicatori: {
      churn_mensile_pct: r2(((disdette / Math.max(1, (prima.premium_attivi + ultimo.premium_attivi) / 2)) / Math.max(mesi, 1 / 30.4)) * 100),
      conversione_free_premium_pct: r2((nuoviPremium / Math.max(1, somma("nuovi_utenti"))) * 100),
      ricavo_medio_per_premium_usd: PREZZO_PREMIUM,
      costo_medio_per_utente_attivo_usd: r2(costi / Math.max(1, ultimo.attivi_30g)),
    },
    prezzi: { premium_mensile_usd: PREZZO_PREMIUM, pacchetto_crediti_ai_usd: PREZZO_CREDITI },
    ...contorno(ultimo, ultimo.data >= tutti.at(-21)!.data),
    serie: serie.map((g) => ({
      data: g.data,
      nuovi_utenti: g.nuovi_utenti,
      premium_attivi: g.premium_attivi,
      nuovi_premium: g.nuovi_premium,
      disdette: g.disdette_premium,
      ricavi: g.ricavi,
      costi: g.costi,
    })),
  };
}
