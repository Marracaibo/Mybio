import type { Analisi } from "./schemi.js";

export interface Bozza {
  fonte: string;
  formato: string;
  perche_funziona: string;
  /** Vuoto = verifica ok. */
  problemi: string[];
  segnaposto: string[];
  sorgente: string;
  varianteA: string;
  varianteB: string;
}

const unaRiga = (s: string) => s.replace(/\s*\r?\n\s*/g, " ").trim();

export function descriviFonte(autore?: string, link?: string): string {
  return [autore, link].filter(Boolean).join(" / ") || "sconosciuta";
}

export function componiBozza(dati: {
  fonte: string;
  analisi: Analisi;
  problemi: string[];
  segnaposto: string[];
  sorgente: string;
  varianteA: string;
  varianteB: string;
}): string {
  const verifica = dati.problemi.length === 0 ? "ok" : `problemi: ${JSON.stringify(dati.problemi.map(unaRiga))}`;
  const righe = [
    "---",
    `fonte: ${unaRiga(dati.fonte)}`,
    `formato: ${unaRiga(dati.analisi.formato)}`,
    `perche_funziona: ${unaRiga(dati.analisi.perche_funziona)}`,
    `verifica: ${verifica}`,
  ];
  if (dati.segnaposto.length > 0) righe.push(`segnaposto: ${JSON.stringify(dati.segnaposto)}`);
  righe.push(
    `sorgente: ${unaRiga(dati.sorgente)}`,
    "---",
    "## Variante A",
    dati.varianteA.trim(),
    "",
    "## Variante B",
    dati.varianteB.trim(),
    "",
  );
  return righe.join("\n");
}

function leggiListaJson(valore: string | undefined): string[] {
  if (!valore) return [];
  try {
    const lista: unknown = JSON.parse(valore);
    return Array.isArray(lista) ? lista.map(String) : [valore];
  } catch {
    return [valore];
  }
}

/** Legge una bozza scritta da componiBozza (anche se ritoccata a mano). */
export function leggiBozza(contenuto: string): Bozza {
  const testo = contenuto.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(testo);
  const campi: Record<string, string> = {};
  if (fm) {
    for (const riga of (fm[1] ?? "").split("\n")) {
      const idx = riga.indexOf(":");
      if (idx > 0) campi[riga.slice(0, idx).trim()] = riga.slice(idx + 1).trim();
    }
  }
  const corpo = fm ? testo.slice(fm[0].length) : testo;
  const sezioneA = /^##\s*Variante A\s*$/im.exec(corpo);
  const sezioneB = /^##\s*Variante B\s*$/im.exec(corpo);
  if (!sezioneA) throw new Error('Nella bozza manca la sezione "## Variante A"');

  const inizioA = sezioneA.index + sezioneA[0].length;
  const fineA = sezioneB && sezioneB.index > sezioneA.index ? sezioneB.index : corpo.length;
  const varianteA = corpo.slice(inizioA, fineA).trim();
  const varianteB = sezioneB ? corpo.slice(sezioneB.index + sezioneB[0].length).trim() : "";
  if (!varianteA) throw new Error("La Variante A è vuota");

  const verifica = campi["verifica"] ?? "";
  const problemi = /^ok$/i.test(verifica) ? [] : leggiListaJson(verifica.replace(/^problemi:\s*/i, ""));

  return {
    fonte: campi["fonte"] ?? "sconosciuta",
    formato: campi["formato"] ?? "",
    perche_funziona: campi["perche_funziona"] ?? "",
    problemi,
    segnaposto: leggiListaJson(campi["segnaposto"]),
    sorgente: campi["sorgente"] ?? "",
    varianteA,
    varianteB,
  };
}
