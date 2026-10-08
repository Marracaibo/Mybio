import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { z } from "zod";
import { chiediJson, creaClient } from "./claude.js";
import { PROJECT_DIR, type Config } from "./config.js";

/**
 * Sticker su richiesta: Claude disegna un SVG 512×512 (testo grande, forme, colori Doublegram), lo rendo in PNG
 * trasparente con resvg e OpenWA lo trasforma in sticker WhatsApp. Niente foto né volti di persone reali.
 */

const FONT = ["Montserrat_800ExtraBold.ttf", "Montserrat_600SemiBold.ttf", "Montserrat_500Medium.ttf"].map((f) =>
  path.join(PROJECT_DIR, "assets", "post", f),
);

const StickerSchema = z.object({
  svg: z.string().describe("Il codice SVG completo dello sticker"),
  descrizione: z.string().describe("Cosa rappresenta, in poche parole"),
});

const SISTEMA = `Disegni sticker per WhatsApp in SVG puro.
Regole tecniche (obbligatorie):
- <svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">, sfondo TRASPARENTE (nessun rettangolo che copre tutto).
- Solo forme vettoriali (path, circle, rect, polygon, text, gradienti, filtri semplici). Niente <image>, link esterni, script, foreignObject.
- Testo con font-family="Montserrat" (pesi 500, 600 o 800), al massimo 3 parole per riga e 3 righe, grande e leggibile
  anche piccolo, con un contorno bianco spesso (stroke="#ffffff" stroke-width 10-14, paint-order="stroke").
- Niente emoji nel testo (non si vedono): disegna i simboli con le forme.
- Tutto deve stare dentro un margine di 16 px dal bordo.
Stile: cartoon pulito e simpatico, contorni spessi, colori vivaci; quando ha senso i colori Doublegram (#8f7bff viola, #1c1160 blu notte, #3ddc97 verde, #ffb547 arancio).
Mai volti realistici di persone reali né loghi di altre aziende; persone solo come personaggi stilizzati.`;

/** Toglie dall'SVG tutto ciò che potrebbe caricare roba esterna. */
function ripulisci(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/<image\b[^>]*>/gi, "")
    .replace(/\s(xlink:)?href="(?!#)[^"]*"/gi, "");
}

export async function creaSticker(config: Config, richiesta: string): Promise<{ png: Buffer; descrizione: string }> {
  const esito = await chiediJson(creaClient(config), config, {
    nome: "sticker",
    ruolo: "scrittura",
    system: SISTEMA,
    schema: StickerSchema,
    contenuto: [{ type: "text", text: `Sticker richiesto: ${richiesta}` }],
  });
  const svg = ripulisci(esito.svg);
  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: 512 },
    background: "rgba(0,0,0,0)",
    font: { fontFiles: FONT, loadSystemFonts: false, defaultFontFamily: "Montserrat" },
  })
    .render()
    .asPng();
  return { png: Buffer.from(png), descrizione: esito.descrizione };
}
