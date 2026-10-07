import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { chiediJson, ErroreFile } from "./claude.js";
import type { Config } from "./config.js";
import { promptTrascrizione } from "./prompts.js";
import { TrascrizioneSchema } from "./schemi.js";

export interface PostSorgente {
  testo: string;
  autore?: string;
  link?: string;
}

const ESTENSIONI_TESTO = new Set([".txt", ".md"]);
const IMMAGINI = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
} as const;

type EstensioneImmagine = keyof typeof IMMAGINI;

function isImmagine(ext: string): ext is EstensioneImmagine {
  return ext in IMMAGINI;
}

const URL_DA_SOLO = /^\s*<?(https?:\/\/\S+?)>?\s*$/;

/**
 * Legge un file .txt/.md. Intestazione opzionale (anche come frontmatter tra ---):
 *
 *   autore: Justin Welsh
 *   link: https://www.linkedin.com/posts/...
 *   ---
 *   testo del post…
 */
export function leggiTestoSorgente(contenuto: string): PostSorgente {
  const righe = contenuto.replace(/^﻿/, "").split(/\r?\n/);
  const meta: { autore?: string; link?: string } = {};
  let i = 0;
  const frontmatter = righe[0]?.trim() === "---";
  if (frontmatter) i = 1;

  for (; i < righe.length; i++) {
    const riga = righe[i] ?? "";
    const m = /^\s*(autore|author|link|url|fonte|source)\s*:\s*(.*)$/i.exec(riga);
    if (m) {
      const chiave = (m[1] ?? "").toLowerCase();
      const valore = (m[2] ?? "").trim();
      if (!valore) continue;
      if (chiave === "link" || chiave === "url" || /^https?:\/\//i.test(valore)) meta.link = valore;
      else meta.autore = valore;
      continue;
    }
    if (riga.trim() === "---") {
      i++;
      break;
    }
    if (riga.trim() === "" && (frontmatter || meta.autore || meta.link)) {
      if (frontmatter) continue;
      i++;
      break;
    }
    break;
  }

  let corpo = righe.slice(i);
  // Un link incollato da solo su una riga (in testa o in coda) è la fonte, non parte del post.
  if (!meta.link) {
    const indice = corpo.findIndex((r) => URL_DA_SOLO.test(r));
    const ultimaPiena = corpo.findLastIndex((r) => r.trim() !== "");
    const primaPiena = corpo.findIndex((r) => r.trim() !== "");
    if (indice !== -1 && (indice === ultimaPiena || indice === primaPiena)) {
      meta.link = URL_DA_SOLO.exec(corpo[indice] ?? "")?.[1];
      corpo = corpo.filter((_, j) => j !== indice);
    }
  }

  return { testo: corpo.join("\n").trim(), ...meta };
}

export function formatoSupportato(file: string): boolean {
  const ext = path.extname(file).toLowerCase();
  return ESTENSIONI_TESTO.has(ext) || isImmagine(ext);
}

/** Estrae il post sorgente da un file di testo o da uno screenshot (con la visione di Claude). */
export async function estraiPost(client: Anthropic, config: Config, file: string): Promise<PostSorgente> {
  const ext = path.extname(file).toLowerCase();

  if (ESTENSIONI_TESTO.has(ext)) {
    const post = leggiTestoSorgente(fs.readFileSync(file, "utf8"));
    if (!post.testo) throw new ErroreFile("Il file non contiene il testo del post");
    return post;
  }

  if (isImmagine(ext)) {
    const dati = fs.readFileSync(file);
    if (dati.length > 5 * 1024 * 1024) {
      throw new ErroreFile("Immagine troppo grande (massimo 5 MB): ritagliala o comprimila");
    }
    const trascrizione = await chiediJson(client, config, {
      nome: "trascrizione",
      system: promptTrascrizione(),
      schema: TrascrizioneSchema,
      contenuto: [
        { type: "image", source: { type: "base64", media_type: IMMAGINI[ext], data: dati.toString("base64") } },
        { type: "text", text: "Trascrivi il post in questo screenshot." },
      ],
    });
    if (!trascrizione.leggibile || !trascrizione.testo.trim()) {
      throw new ErroreFile("Nello screenshot non c'è un post LinkedIn leggibile");
    }
    return { testo: trascrizione.testo.trim(), autore: trascrizione.autore?.trim() || undefined };
  }

  throw new ErroreFile(
    `Formato non supportato (${ext || "senza estensione"}): usa .txt, .md, .png, .jpg, .jpeg o .webp`,
  );
}
