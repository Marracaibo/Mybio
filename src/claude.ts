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
 * Una chiamata a Claude con output JSON vincolato allo schema zod.
 * Il JSON restituito è già validato dall'SDK.
 */
export async function chiediJson<S extends z.ZodType>(
  client: Anthropic,
  config: Config,
  opzioni: { nome: string; system: string; contenuto: Contenuto; schema: S },
): Promise<z.infer<S>> {
  const fallback =
    config.CLAUDE_FALLBACK === "default"
      ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
      : {};

  let risposta;
  try {
    risposta = await client.beta.messages.parse({
      model: config.CLAUDE_MODEL,
      max_tokens: 16000,
      // Il system prompt (con le linee guida) è uguale per tutti i file: in cache costa meno.
      system: [{ type: "text", text: opzioni.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: opzioni.contenuto }],
      output_config: { format: betaZodOutputFormat(opzioni.schema) },
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
