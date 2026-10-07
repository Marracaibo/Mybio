import { z } from "zod";

/** Trascrizione di uno screenshot di un post LinkedIn. */
export const TrascrizioneSchema = z.object({
  leggibile: z.boolean().describe("true se l'immagine contiene un post LinkedIn leggibile"),
  testo: z.string().describe("Testo integrale del post, con gli a capo originali. Vuoto se non leggibile."),
  autore: z.string().optional().describe("Nome dell'autore se visibile nello screenshot"),
});
export type Trascrizione = z.infer<typeof TrascrizioneSchema>;

/** Chiamata 1: analisi strutturale del post sorgente. */
export const AnalisiSchema = z.object({
  adatto: z.boolean(),
  motivo_scarto: z.string().optional(),
  formato: z.string().describe("Es. lista, storia, controcorrente, prima/dopo, errori comuni, framework"),
  hook: z.string().describe("Descrizione del meccanismo dell'hook (non la sua traduzione)"),
  struttura: z.array(z.string()).describe("Blocchi del post in ordine, descritti in modo astratto"),
  cta: z.string().describe("Tipo di chiusura / call to action"),
  perche_funziona: z.string().describe("1-2 righe"),
  idea_originale_di_autore: z.boolean(),
});
export type Analisi = z.infer<typeof AnalisiSchema>;

/** Chiamata 2: due varianti italiane. */
export const AdattamentoSchema = z.object({
  variante_a: z.string(),
  variante_b: z.string(),
});
export type Adattamento = z.infer<typeof AdattamentoSchema>;

/** Fase 4: una variante riscritta su richiesta. */
export const RevisioneSchema = z.object({
  testo: z.string(),
});

/** Chiamata 3: verifica delle varianti. */
export const VerificaSchema = z.object({
  traduzione_letterale: z.boolean(),
  numeri_non_verificati: z.array(z.string()),
  citazione_mancante: z.boolean(),
  ok: z.boolean(),
  problemi: z.array(z.string()),
});
export type Verifica = z.infer<typeof VerificaSchema>;
