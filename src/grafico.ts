import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { PROJECT_DIR } from "./config.js";

/**
 * Grafici per il maggiordomo (linee o barre), con lo stesso stile delle card di Doublegram News.
 * SVG reso in PNG con resvg e Montserrat, come le card: niente browser né librerie di grafici.
 */

const FONT = ["Montserrat_800ExtraBold.ttf", "Montserrat_600SemiBold.ttf", "Montserrat_500Medium.ttf"].map((f) =>
  path.join(PROJECT_DIR, "assets", "post", f),
);
const COLORI = ["#8f7bff", "#3ddc97", "#ffb547", "#ff6b8b"];

export interface DatiGrafico {
  titolo: string;
  sottotitolo?: string;
  etichette: string[];
  serie: Array<{ nome: string; valori: number[] }>;
  tipo: "linee" | "barre";
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Tacche "tonde" per l'asse Y (1, 2, 2,5 o 5 per una potenza di 10). */
function tacche(min: number, max: number): number[] {
  const da = Math.min(0, min);
  const span = max - da || 1;
  const grezzo = span / 5;
  const p = 10 ** Math.floor(Math.log10(grezzo));
  const passo = [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= grezzo) ?? 10 * p;
  const out: number[] = [];
  for (let v = Math.floor(da / passo) * passo; v <= max + passo * 0.001; v += passo) out.push(Math.round(v * 1e6) / 1e6);
  if (out.at(-1)! < max) out.push(out.at(-1)! + passo);
  return out;
}

const formato = (v: number) =>
  Math.abs(v) >= 10_000 ? `${(v / 1000).toLocaleString("it-IT", { maximumFractionDigits: 1 })}k` : v.toLocaleString("it-IT", { maximumFractionDigits: 2 });

export function creaGrafico(d: DatiGrafico): Buffer {
  const L = 1200;
  const H = 800;
  const sx = 120;
  const dx = 50;
  const su = 190;
  const giu = 110;
  const w = L - sx - dx;
  const h = H - su - giu;
  const serie = d.serie.slice(0, 4).map((s) => ({ ...s, valori: s.valori.slice(0, d.etichette.length).map(Number) }));
  const n = d.etichette.length;
  const tutti = serie.flatMap((s) => s.valori).filter(Number.isFinite);
  const yT = tacche(Math.min(...tutti, 0), Math.max(...tutti, 1));
  const y0 = yT[0]!;
  const y1 = yT.at(-1)!;
  const y = (v: number) => su + h - ((v - y0) / (y1 - y0)) * h;
  const passoX = n > 1 ? w / (d.tipo === "barre" ? n : n - 1) : w;
  const x = (i: number) => (d.tipo === "barre" ? sx + passoX * (i + 0.5) : sx + (n > 1 ? passoX * i : w / 2));
  const ogniEtichetta = Math.max(1, Math.ceil(n / 10));

  const griglia = yT
    .map(
      (v) =>
        `<line x1="${sx}" y1="${y(v)}" x2="${L - dx}" y2="${y(v)}" stroke="#ffffff" stroke-opacity="0.08"/>` +
        `<text x="${sx - 16}" y="${y(v) + 8}" text-anchor="end" font-family="Montserrat" font-weight="500" font-size="22" fill="#a9a3d9">${escape(formato(v))}</text>`,
    )
    .join("");
  const assiX = d.etichette
    .map((e, i) =>
      i % ogniEtichetta === 0 || (i === n - 1 && (n - 1) % ogniEtichetta >= ogniEtichetta / 2)
        ? `<text x="${x(i)}" y="${su + h + 40}" text-anchor="middle" font-family="Montserrat" font-weight="500" font-size="20" fill="#a9a3d9">${escape(e.slice(0, 12))}</text>`
        : "",
    )
    .join("");

  let disegno = "";
  if (d.tipo === "barre") {
    const larghezza = (passoX * 0.7) / serie.length;
    disegno = serie
      .map((s, k) =>
        s.valori
          .map((v, i) => {
            const bx = x(i) - (passoX * 0.7) / 2 + k * larghezza;
            const top = Math.min(y(v), y(0));
            return `<rect x="${bx}" y="${top}" width="${Math.max(2, larghezza - 4)}" height="${Math.abs(y(v) - y(0))}" rx="6" fill="${COLORI[k]}"/>`;
          })
          .join(""),
      )
      .join("");
  } else {
    disegno = serie
      .map((s, k) => {
        const punti = s.valori.map((v, i) => `${x(i)},${y(v)}`).join(" ");
        const area =
          k === 0 && serie.length === 1
            ? `<polygon points="${x(0)},${y(Math.max(y0, 0))} ${punti} ${x(n - 1)},${y(Math.max(y0, 0))}" fill="url(#area)"/>`
            : "";
        const ultimo = s.valori.at(-1) ?? 0;
        return (
          area +
          `<polyline points="${punti}" fill="none" stroke="${COLORI[k]}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>` +
          `<circle cx="${x(n - 1)}" cy="${y(ultimo)}" r="9" fill="${COLORI[k]}" stroke="#0d0b33" stroke-width="3"/>` +
          `<text x="${x(n - 1) - 14}" y="${y(ultimo) - 18}" text-anchor="end" font-family="Montserrat" font-weight="800" font-size="26" fill="${COLORI[k]}">${escape(formato(ultimo))}</text>`
        );
      })
      .join("");
  }
  const legenda =
    serie.length > 1 || d.tipo === "barre"
      ? serie
          .map((s, k) => {
            const lx = sx + k * 260;
            return `<rect x="${lx}" y="${H - 52}" width="22" height="22" rx="5" fill="${COLORI[k]}"/><text x="${lx + 32}" y="${H - 33}" font-family="Montserrat" font-weight="600" font-size="22" fill="#e9e5ff">${escape(s.nome.slice(0, 18))}</text>`;
          })
          .join("")
      : `<text x="${sx}" y="${H - 33}" font-family="Montserrat" font-weight="600" font-size="22" fill="#e9e5ff">${escape(serie[0]?.nome ?? "")}</text>`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${L}" height="${H}" viewBox="0 0 ${L} ${H}">
  <defs>
    <linearGradient id="fondo" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#05061a"/><stop offset="0.6" stop-color="#0d0b33"/><stop offset="1" stop-color="#1c1160"/>
    </linearGradient>
    <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${COLORI[0]}" stop-opacity="0.45"/><stop offset="1" stop-color="${COLORI[0]}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="${L}" height="${H}" fill="url(#fondo)"/>
  <text x="${sx}" y="88" font-family="Montserrat" font-weight="800" font-size="46" fill="#ffffff">${escape(d.titolo.slice(0, 40))}</text>
  ${d.sottotitolo ? `<text x="${sx}" y="132" font-family="Montserrat" font-weight="500" font-size="24" fill="#b9b2ff">${escape(d.sottotitolo.slice(0, 80))}</text>` : ""}
  <text x="${L - dx}" y="${H - 33}" text-anchor="end" font-family="Montserrat" font-weight="600" font-size="22" fill="#a597ff">doublegram.com</text>
  ${griglia}
  ${assiX}
  ${disegno}
  ${legenda}
</svg>`;
  return Buffer.from(
    new Resvg(svg, { fitTo: { mode: "width", value: L }, font: { fontFiles: FONT, loadSystemFonts: false, defaultFontFamily: "Montserrat" } })
      .render()
      .asPng(),
  );
}
