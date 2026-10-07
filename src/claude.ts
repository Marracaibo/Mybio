import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import type { Config } from "./config.js";

/** Errore legato al servizio (chiave, rete, limiti): non dipende dal file, si riprova al giro successivo. */
export class ErroreServizio extends Error {
  override name = "ErroreServizio";
}

/** Errore legato al singolo file: il file va in _errori/ e la coda prosegue. */
export class ErroreFile extends Error {
  override name = "ErroreFile";
}

export type Contenuto = Anthropic.Beta.BetaContentBlockParam[];

export function creaClient(config: Config): Anthropic {
  if (!config.ANTHROPIC_API_KEY) {
    throw new ErroreServizio("ANTHROPIC_API_KEY mancante nel file .env");
  }
  return new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 3 });
}

/**
 * Quale modello usa una chiamata:
 * - "scrittura": l'adattamento, cioè il testo che verrà pubblicato (CLAUDE_MODEL);
 * - "controllo": trascrizione e analisi, compiti semplici affidati a un modello economico
 *   (CLAUDE_MODEL_CONTROLLI) con poco ragionamento (CLAUDE_EFFORT_CONTROLLI);
 * - "verifica": il controllo delle bozze (CLAUDE_MODEL_VERIFICA), con lo stesso ragionamento dei controlli.
 *   Ha un modello a parte perché un modello economico qui dà risultati incostanti e molti falsi allarmi.
 */
export type Ruolo = "scrittura" | "controllo" | "verifica";

const MODELLO: Record<Ruolo, (c: Config) => string> = {
  scrittura: (c) => c.CLAUDE_MODEL,
  controllo: (c) => c.CLAUDE_MODEL_CONTROLLI,
  verifica: (c) => c.CLAUDE_MODEL_VERIFICA,
};

/** Modelli che accettano `output_config.effort` (Haiku 4.5 e Sonnet 4.5 lo rifiutano con un 400). */
const SUPPORTA_EFFORT = /^claude-(fable|mythos|opus-(4-[5-9]|5)|sonnet-(4-6|5))/;
/** Modelli che accettano il fallback lato server `fallbacks: "default"`. */
const SUPPORTA_FALLBACK = /^claude-(fable-5|mythos-5|opus-5|sonnet-5-5)/;

/**
 * Una chiamata a Claude con output JSON vincolato allo schema zod.
 * Il JSON restituito è già validato dall'SDK.
 */
export async function chiediJson<S extends z.ZodType>(
  client: Anthropic,
  config: Config,
  opzioni: { nome: string; ruolo: Ruolo; system: string; contenuto: Contenuto; schema: S },
): Promise<z.infer<S>> {
  const modello = MODELLO[opzioni.ruolo](config);
  const effort =
    opzioni.ruolo !== "scrittura" && SUPPORTA_EFFORT.test(modello) ? { effort: config.CLAUDE_EFFORT_CONTROLLI } : {};
  const fallback =
    config.CLAUDE_FALLBACK === "default" && SUPPORTA_FALLBACK.test(modello)
      ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
      : {};

  let risposta;
  try {
    risposta = await client.beta.messages.parse({
      model: modello,
      max_tokens: 16000,
      // Il system prompt (con le linee guida) è uguale per tutti i file: in cache costa meno.
      system: [{ type: "text", text: opzioni.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: opzioni.contenuto }],
      output_config: { format: betaZodOutputFormat(opzioni.schema), ...effort },
      ...fallback,
    });
  } catch (e) {
    if (
      e instanceof Anthropic.AuthenticationError ||
      e instanceof Anthropic.PermissionDeniedError ||
      e instanceof Anthropic.RateLimitError ||
      e instanceof Anthropic.InternalServerError ||
      e instanceof Anthropic.APIConnectionError
    ) {
      throw new ErroreServizio(`Claude non disponibile (${opzioni.nome}): ${e.message.replace(/\.+$/, "")}`);
    }
    if (e instanceof Anthropic.APIError) {
      throw new ErroreFile(`Errore API di Claude (${opzioni.nome}, ${e.status}): ${e.message}`);
    }
    throw e;
  }

  if (risposta.stop_reason === "refusal") {
    const categoria = risposta.stop_details?.category ?? "non specificata";
    throw new ErroreFile(`Claude ha rifiutato la richiesta (${opzioni.nome}, categoria: ${categoria})`);
  }
  if (risposta.stop_reason === "max_tokens") {
    throw new ErroreFile(`Risposta troncata per limite di token (${opzioni.nome})`);
  }
  if (risposta.parsed_output == null) {
    throw new ErroreFile(`Risposta di Claude non conforme allo schema (${opzioni.nome})`);
  }
  return risposta.parsed_output;
}
