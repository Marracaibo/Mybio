import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { creaClient } from "./claude.js";
import type { Config } from "./config.js";

/**
 * File veri (PowerPoint, Excel, Word, PDF) creati da Claude con le Agent Skills ufficiali di Anthropic:
 * Claude scrive ed esegue il codice nella sua sandbox, controlla il risultato e ci restituisce il file,
 * che scarichiamo con la Files API. Ci vogliono 1-3 minuti: va lanciato in background.
 */

export type TipoFile = "pptx" | "xlsx" | "docx" | "pdf";

const MIME: Record<TipoFile, string> = {
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};

const STILE = `Stile Doublegram: sfondi scuri blu notte (#05061a → #1c1160), accento viola (#8f7bff), verde (#3ddc97) e
arancio (#ffb547) per i grafici, testo bianco o grigio chiaro, titoli in grassetto, molto spazio, niente clipart.
Firma in piccolo "doublegram.com". Lingua italiana salvo richiesta diversa.`;

export interface FileCreato {
  nome: string;
  mimetype: string;
  dati: Buffer;
  nota: string;
}

/** Tutti i file_id prodotti dall'esecuzione di codice in una risposta. */
function fileProdotti(contenuto: unknown, ids: string[] = []): string[] {
  if (contenuto && typeof contenuto === "object") {
    const o = contenuto as Record<string, unknown>;
    if (o["type"] === "bash_code_execution_output" && typeof o["file_id"] === "string") ids.push(o["file_id"]);
    for (const v of Object.values(o)) fileProdotti(v, ids);
  }
  return ids;
}

export async function creaFile(
  config: Config,
  richiesta: { tipo: TipoFile; nomeFile: string; istruzioni: string },
  avanzamento?: (passo: string) => void,
): Promise<FileCreato> {
  const client = creaClient(config);
  const nome = `${path.basename(richiesta.nomeFile).replace(/\.[a-z0-9]+$/i, "").replace(/[^\p{L}\p{N}_ -]/gu, "").trim() || "documento"}.${richiesta.tipo}`;
  let messaggi: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: `Crea il file "${nome}" (${richiesta.tipo.toUpperCase()}) e salvalo come output.\n\n${STILE}\n\nContenuto e istruzioni:\n${richiesta.istruzioni}\n\nUsa SOLO i dati e i fatti forniti qui: non inventare numeri. Controlla il file prima di consegnarlo. Alla fine scrivi in una o due frasi cosa contiene.`,
    },
  ];
  let container: string | undefined;
  let risposta: Anthropic.Beta.BetaMessage | undefined;
  for (let giro = 0; giro < 6; giro++) {
    avanzamento?.(giro === 0 ? `🛠️ Claude scrive e prova il codice del file ${nome}` : `🛠️ Continuo a lavorare su ${nome} (${giro + 1}° giro)`);
    risposta = await client.beta.messages.create({
      model: config.CLAUDE_MODEL_FILE,
      max_tokens: 16000,
      container: { ...(container ? { id: container } : {}), skills: [{ type: "anthropic", skill_id: richiesta.tipo, version: "latest" }] },
      tools: [{ type: "code_execution_20260521", name: "code_execution" }],
      betas: ["code-execution-2025-08-25"],
      messages: messaggi,
    });
    container = risposta.container?.id ?? container;
    if (risposta.stop_reason !== "pause_turn") break;
    messaggi = [...messaggi, { role: "assistant", content: risposta.content }];
  }
  if (!risposta) throw new Error("nessuna risposta da Claude");
  if (risposta.stop_reason === "refusal") throw new Error("Claude ha rifiutato di creare questo file");
  const ids = fileProdotti(risposta.content);
  avanzamento?.("📥 Scarico il file");
  for (const id of ids.reverse()) {
    const meta = await client.files.retrieveMetadata(id);
    if (!meta.filename.toLowerCase().endsWith(`.${richiesta.tipo}`)) continue;
    const scaricato = await client.files.download(id);
    const dati = Buffer.from(await scaricato.arrayBuffer());
    // Nota per il gruppo: l'ultimo testo di Claude, in grassetto WhatsApp, tagliato a fine frase.
    const testo = (risposta.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").at(-1)?.text ?? "")
      .replace(/\*\*(.+?)\*\*/g, "*$1*")
      .replace(/^#+\s*/gm, "")
      .trim();
    const taglio = testo.length <= 500 ? testo.length : Math.max(testo.lastIndexOf(". ", 500), testo.lastIndexOf("\n", 500));
    const nota = testo.slice(0, taglio > 100 ? taglio + 1 : 500).trim();
    return { nome, mimetype: MIME[richiesta.tipo], dati, nota };
  }
  throw new Error(`Claude non ha prodotto un file .${richiesta.tipo}`);
}
