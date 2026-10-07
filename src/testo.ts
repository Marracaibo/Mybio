export const SEGNAPOSTO_DATO = "[DATO DA INSERIRE]";
export const SEGNAPOSTO_AUTORE = "[AUTORE DA INSERIRE]";

/** Data locale in formato AAAA-MM-GG. */
export function oggi(data = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${data.getFullYear()}-${p(data.getMonth() + 1)}-${p(data.getDate())}`;
}

export function slug(testo: string, maxParole = 6): string {
  const s = testo
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxParole)
    .join("-");
  return s.slice(0, 60) || "post";
}

/** Conta le emoji (pittogrammi), ignorando cifre e simboli testuali. */
export function contaEmoji(testo: string): number {
  return (testo.match(/\p{Extended_Pictographic}/gu) ?? []).length;
}

export function contaOccorrenze(testo: string, cerca: string): number {
  return testo.split(cerca).length - 1;
}

/**
 * Rimuove tutto ciò che WhatsApp (o LinkedIn) interpreterebbe come formattazione:
 * *grassetto*, _corsivo_, ~barrato~, `monospazio`, titoli markdown.
 */
export function testoSemplice(testo: string): string {
  return testo
    .replace(/```/g, "")
    .replace(/`/g, "")
    .replace(/\*+/g, "")
    .replace(/~+/g, "")
    .replace(/(^|[\s(])_+([^_\n]+?)_+(?=[\s).,;:!?]|$)/gmu, "$1$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Segnala markdown residuo in un testo che dovrebbe essere semplice. */
export function haMarkdown(testo: string): boolean {
  return (
    /\*\*[^*]+\*\*|__[^_]+__|^#{1,6}\s|```/m.test(testo) ||
    /(^|\s)\*[^*\s][^*\n]*?\*(?=\s|[.,;:!?]|$)/m.test(testo)
  );
}

/** Prime parole di un messaggio, normalizzate: servono a riconoscere una citazione su WhatsApp. */
export function inizioTesto(testo: string, lunghezza = 120): string {
  return testo.replace(/\s+/g, " ").trim().slice(0, lunghezza).toLowerCase();
}
