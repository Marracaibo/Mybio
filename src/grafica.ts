import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { PROJECT_DIR } from "./config.js";

/**
 * Card per i post del canale nello stile di Doublegram News: sfondo blu-viola con luce, logo bianco,
 * etichetta spaziata ("— LAUNCH ALERT —"), titolo grande, sottotitolo e doublegram.com.
 * È un modello grafico (SVG reso in PNG con resvg): i testi li sceglie Claude, il disegno è sempre lo stesso.
 */

const ASSET = path.join(PROJECT_DIR, "assets", "post");
const FONT = ["Montserrat_800ExtraBold.ttf", "Montserrat_600SemiBold.ttf", "Montserrat_500Medium.ttf"].map((f) =>
  path.join(ASSET, f),
);

export interface DatiCard {
  etichetta: string;
  titolo: string;
  sottotitolo?: string;
  sito?: string;
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Divide il testo in righe di al massimo `max` caratteri (stima: Montserrat è larga ~0,62 em per carattere). */
function righe(testo: string, max: number): string[] {
  const parole = testo.trim().split(/\s+/);
  const out: string[] = [];
  let riga = "";
  for (const p of parole) {
    if (riga && (riga + " " + p).length > max) {
      out.push(riga);
      riga = p;
    } else riga = riga ? `${riga} ${p}` : p;
  }
  if (riga) out.push(riga);
  return out;
}

/** Logo: quello nella cartella condivisa se c'è (logo-post.png), altrimenti quello del progetto. */
function logoBase64(cartellaCondivisa?: string): string {
  const personalizzato = cartellaCondivisa ? path.join(cartellaCondivisa, "logo-post.png") : "";
  const file = personalizzato && fs.existsSync(personalizzato) ? personalizzato : path.join(ASSET, "logo.png");
  return fs.readFileSync(file).toString("base64");
}

/** Larghezza reale di una riga di testo, misurata con resvg sugli stessi font. */
function larghezza(testo: string, dimensione: number, peso: number, spaziatura = 0): number {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="400"><text x="10" y="300" font-family="Montserrat" font-weight="${peso}" font-size="${dimensione}" letter-spacing="${spaziatura}">${escape(testo)}</text></svg>`;
  const box = new Resvg(svg, { font: { fontFiles: FONT, loadSystemFonts: false, defaultFontFamily: "Montserrat" } }).getBBox();
  return box?.width ?? testo.length * dimensione * 0.75;
}

/** Il titolo più grande possibile entro `max` px: una riga, o due se una sola lo renderebbe troppo piccolo. */
function impaginaTitolo(titolo: string, max: number): { righe: string[]; dimensione: number } {
  const BASE = 190;
  const una = Math.min(BASE, Math.floor((BASE * max) / larghezza(titolo, BASE, 800)));
  const parole = titolo.split(/\s+/);
  if (una >= 120 || parole.length < 2) return { righe: [titolo], dimensione: Math.max(60, una) };
  let migliore = { righe: [titolo], dimensione: una };
  for (let i = 1; i < parole.length; i++) {
    const r = [parole.slice(0, i).join(" "), parole.slice(i).join(" ")];
    const d = Math.min(BASE, ...r.map((x) => Math.floor((BASE * max) / larghezza(x, BASE, 800))));
    if (d > migliore.dimensione) migliore = { righe: r, dimensione: d };
  }
  return migliore;
}

export function creaCard(dati: DatiCard, cartellaCondivisa?: string): Buffer {
  const L = 1080;
  const { righe: righeTitolo, dimensione: dimTitolo } = impaginaTitolo(dati.titolo.trim(), 940);
  const righeSotto = dati.sottotitolo ? righe(dati.sottotitolo, 38).slice(0, 2) : [];
  const etichetta = dati.etichetta.trim().toUpperCase();
  const sito = dati.sito ?? "doublegram.com";

  // Impaginazione verticale: logo in alto, poi etichetta, titolo, sottotitolo; il sito resta sempre dentro.
  const altezzaTitolo = dimTitolo * 0.74 + (righeTitolo.length - 1) * dimTitolo * 0.95;
  const altezzaSotto = righeSotto.length ? 50 + (righeSotto.length - 1) * 50 : 0;
  const blocco = 34 + 50 + altezzaTitolo + (righeSotto.length ? 40 : 0) + altezzaSotto;
  const yEtichetta = Math.max(500, Math.min(560, 470 + (560 - blocco) / 2));
  const yTitolo0 = yEtichetta + 50 + dimTitolo * 0.74;
  const yTitoloFine = yTitolo0 + (righeTitolo.length - 1) * dimTitolo * 0.95;
  const ySotto0 = yTitoloFine + 40 + 40;
  const ySito = Math.min(1015, Math.max(ySotto0 + righeSotto.length * 50 + 45, 930));
  const larghezzaEtichetta = larghezza(etichetta, 34, 500, 10);
  const lineaX = larghezzaEtichetta / 2 + 30;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${L}" height="${L}" viewBox="0 0 ${L} ${L}">
  <defs>
    <linearGradient id="fondo" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#05061a"/>
      <stop offset="0.55" stop-color="#0d0b33"/>
      <stop offset="1" stop-color="#1c1160"/>
    </linearGradient>
    <radialGradient id="luce" cx="0.85" cy="0.45" r="0.6">
      <stop offset="0" stop-color="#7d5cff" stop-opacity="0.75"/>
      <stop offset="0.45" stop-color="#4b33c9" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#1c1160" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="luce2" cx="0.15" cy="0.95" r="0.5">
      <stop offset="0" stop-color="#3a2a9e" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#05061a" stop-opacity="0"/>
    </radialGradient>
    <filter id="soloBianco" color-interpolation-filters="sRGB">
      <!-- Il logo del sito ha lo sfondo viola: tengo solo le parti chiare, in bianco. -->
      <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 3.2 0 0 -0.55"/>
    </filter>
    <filter id="alone" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="18"/>
    </filter>
  </defs>
  <rect width="${L}" height="${L}" fill="url(#fondo)"/>
  <rect width="${L}" height="${L}" fill="url(#luce)"/>
  <rect width="${L}" height="${L}" fill="url(#luce2)"/>
  <g opacity="0.55" filter="url(#alone)">
    <image x="${L / 2 - 120}" y="170" width="240" height="240" xlink:href="data:image/png;base64,${logoBase64(cartellaCondivisa)}" filter="url(#soloBianco)"/>
  </g>
  <image x="${L / 2 - 120}" y="170" width="240" height="240" xlink:href="data:image/png;base64,${logoBase64(cartellaCondivisa)}" filter="url(#soloBianco)"/>
  <line x1="${L / 2 - lineaX - 70}" y1="${yEtichetta - 12}" x2="${L / 2 - lineaX}" y2="${yEtichetta - 12}" stroke="#b9b2ff" stroke-width="3"/>
  <line x1="${L / 2 + lineaX}" y1="${yEtichetta - 12}" x2="${L / 2 + lineaX + 70}" y2="${yEtichetta - 12}" stroke="#b9b2ff" stroke-width="3"/>
  <text x="${L / 2}" y="${yEtichetta}" text-anchor="middle" font-family="Montserrat" font-weight="500" font-size="34" letter-spacing="10" fill="#d9d4ff">${escape(etichetta)}</text>
  ${righeTitolo
    .map(
      (r, i) =>
        `<text x="${L / 2}" y="${yTitolo0 + i * dimTitolo * 0.95}" text-anchor="middle" font-family="Montserrat" font-weight="800" font-size="${dimTitolo}" fill="#ffffff">${escape(r)}</text>`,
    )
    .join("\n  ")}
  ${righeSotto
    .map(
      (r, i) =>
        `<text x="${L / 2}" y="${ySotto0 + i * 50}" text-anchor="middle" font-family="Montserrat" font-weight="600" font-size="40" fill="#e9e5ff">${escape(r)}</text>`,
    )
    .join("\n  ")}
  <text x="${L / 2}" y="${ySito}" text-anchor="middle" font-family="Montserrat" font-weight="600" font-size="32" fill="#a597ff">${escape(sito)}</text>
</svg>`;

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: L },
    font: { fontFiles: FONT, loadSystemFonts: false, defaultFontFamily: "Montserrat" },
  });
  return Buffer.from(resvg.render().asPng());
}
