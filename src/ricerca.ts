import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { chiediJson, creaClient } from "./claude.js";
import type { Config } from "./config.js";
import { creaFile } from "./file-claude.js";
import { descriviErrore, type Logger } from "./log.js";
import { inviaDocumento, type ConfigOpenWA } from "./openwa.js";
import { leggiLineeGuida } from "./pipeline.js";
import { Progresso } from "./progresso.js";
import { oggi, slug } from "./testo.js";

/**
 * Ricerca approfondita: un "capo ricerca" divide il tema in 4-6 filoni, altrettanti agenti cercano sul web in
 * parallelo (ognuno con le sue fonti), poi un redattore scrive il rapporto e Claude lo impagina in PDF.
 * Tutto in background, con l'avanzamento che si aggiorna nel gruppo. Salvato in 07-ricerche/.
 */

const PianoSchema = z.object({
  titolo: z.string().describe("Titolo del rapporto"),
  filoni: z
    .array(z.object({ nome: z.string().describe("2-4 parole"), istruzioni: z.string().describe("Cosa cercare, in concreto") }))
    .describe("Da 4 a 6 filoni indipendenti"),
});

const CONTESTO = `Lavori per Doublegram (suite di bot per community Telegram: Security, Scribe, Doublegram AI, Lookup;
piano Free e Premium a 9,99 $/mese; doublegram.com). Il team è piccolo: servono informazioni concrete e utilizzabili.`;

async function agente(client: Anthropic, config: Config, tema: string, filone: { nome: string; istruzioni: string }): Promise<string> {
  let messaggi: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: `Tema generale: ${tema}\nIl tuo filone: ${filone.nome}\n${filone.istruzioni}\n\nCerca sul web (fonti recenti e affidabili, almeno 4), poi scrivi in italiano i risultati: fatti, numeri con data, esempi, citazioni brevi. Ogni affermazione con la sua fonte (titolo + URL). Distingui i fatti dalle tue deduzioni. Al massimo 3500 caratteri.`,
    },
  ];
  let r: Anthropic.Beta.BetaMessage | undefined;
  for (let giro = 0; giro < 4; giro++) {
    r = await client.beta.messages.create({
      model: config.CLAUDE_MODEL_FILE,
      max_tokens: 8000,
      system: CONTESTO,
      tools: [
        { type: "web_search_20260209", name: "web_search", max_uses: 6 },
        { type: "web_fetch_20260209", name: "web_fetch", max_uses: 4 },
      ],
      messages: messaggi,
      output_config: { effort: "medium" },
    });
    if (r.stop_reason !== "pause_turn") break;
    messaggi = [...messaggi, { role: "assistant", content: r.content }];
  }
  return (r?.content ?? [])
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

export async function ricercaApprofondita(
  ctx: { config: Config; log: Logger; openwa: ConfigOpenWA },
  tema: string,
  rispondiA?: string,
): Promise<void> {
  const { config, log, openwa } = ctx;
  const client = creaClient(config);
  const progresso = new Progresso(openwa, `🧭 *Ricerca approfondita*: ${tema.slice(0, 80)}`, rispondiA);
  await progresso.inizia();
  try {
    progresso.passo("🗺️ Divido il tema in filoni di ricerca");
    const piano = await chiediJson(client, config, {
      nome: "ricerca-piano",
      ruolo: "scrittura",
      system: `${CONTESTO}\nSei il capo ricerca: dividi il tema in 4-6 filoni indipendenti, ognuno affidabile a un ricercatore diverso.`,
      schema: PianoSchema,
      contenuto: [{ type: "text", text: `Tema: ${tema}\nData di oggi: ${oggi()}` }],
    });
    const filoni = piano.filoni.slice(0, 6);
    progresso.passo(`🔎 ${filoni.length} ricercatori al lavoro in parallelo: ${filoni.map((f) => f.nome).join(" · ")}`);
    let finiti = 0;
    const risultati = await Promise.all(
      filoni.map(async (f) => {
        try {
          const testo = await agente(client, config, tema, f);
          finiti++;
          progresso.passo(`📚 ${finiti}/${filoni.length} filoni completati (ultimo: ${f.nome})`);
          return `## ${f.nome}\n${testo}`;
        } catch (e) {
          log.avviso(`Ricerca, filone "${f.nome}": ${descriviErrore(e)}`);
          return `## ${f.nome}\n(ricerca non riuscita: ${descriviErrore(e)})`;
        }
      }),
    );

    progresso.passo("✍️ Scrivo il rapporto");
    const redazione = await client.beta.messages.create({
      model: config.CLAUDE_MODEL_SCHIAVO,
      max_tokens: 16000,
      system: `${CONTESTO}\nLinee guida del team:\n${leggiLineeGuida(config.SHARED_DIR).slice(0, 3000)}`,
      messages: [
        {
          role: "user",
          content: `Scrivi in italiano il rapporto "${piano.titolo}" a partire da questi appunti dei ricercatori.
Struttura: Sintesi (5 punti chiave) · un capitolo per filone · Cosa significa per Doublegram · Raccomandazioni (azioni concrete con priorità) · Fonti (elenco numerato con URL).
Cita le fonti nel testo con [n]. Non aggiungere fatti che non sono negli appunti. Usa Markdown (titoli ##, elenchi, tabelle se utili). 2500-5000 parole.

${risultati.join("\n\n")}`,
        },
      ],
      output_config: { effort: "medium" },
    });
    const rapporto = redazione.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    const cartella = path.join(config.SHARED_DIR, "07-ricerche");
    fs.mkdirSync(cartella, { recursive: true });
    const base = `${oggi()}_${slug(piano.titolo).slice(0, 60) || "ricerca"}`;
    fs.writeFileSync(path.join(cartella, `${base}.md`), rapporto + "\n", "utf8");

    progresso.passo("📄 Impagino il PDF");
    const pdf = await creaFile(
      config,
      {
        tipo: "pdf",
        nomeFile: base,
        istruzioni: `Impagina il rapporto (file rapporto.md, in Markdown) come PDF professionale: copertina con titolo "${piano.titolo}", data ${oggi()} e "Ricerca di Jarvis per Doublegram"; indice; titoli, elenchi e tabelle curati; numeri di pagina; fonti in fondo con link cliccabili. Il testo va riportato fedelmente e per intero.`,
        allegati: [{ nome: "rapporto.md", testo: rapporto }],
      },
      (p) => progresso.passo(p),
    ).catch(async (e: unknown) => {
      // Ripiego: il rapporto c'è comunque, lo mando come testo.
      log.avviso(`Ricerca: PDF non riuscito (${descriviErrore(e)}), mando il rapporto in Markdown`);
      await inviaDocumento(openwa, Buffer.from(rapporto, "utf8"), `${base}.md`, "text/markdown", `📄 ${piano.titolo} (testo)`);
      return undefined;
    });
    if (!pdf) {
      await progresso.fine(`🧭 *${piano.titolo}*\n\nIl rapporto è pronto, Signore, ma l'impaginazione in PDF non è riuscita: le mando il testo completo qui sotto (salvato anche in 07-ricerche/).`);
      return;
    }
    fs.writeFileSync(path.join(cartella, `${base}.pdf`), pdf.dati);
    await inviaDocumento(openwa, pdf.dati, `${base}.pdf`, pdf.mimetype, `📄 ${piano.titolo}`);
    const sintesi = /##\s*Sintesi[\s\S]*?(?=\n##\s)/i.exec(rapporto)?.[0]?.replace(/^##\s*Sintesi\s*/i, "").trim() ?? "";
    await progresso.fine(
      `🧭 *${piano.titolo}*\n\n${sintesi.replace(/\*\*/g, "*").slice(0, 1800)}\n\n📄 Il rapporto completo, con le fonti, è il PDF qui sotto (salvato anche in 07-ricerche/).`,
    );
    log.info(`Ricerca approfondita: ${base} (${filoni.length} filoni)`);
  } catch (e) {
    log.errore(`Ricerca approfondita: ${descriviErrore(e)}`);
    await progresso.fine(`🧭 Mi rincresce, Signore: la ricerca si è interrotta (${descriviErrore(e)}).`);
  }
}
