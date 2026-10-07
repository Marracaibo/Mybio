/**
 * Lettore minimale di feed RSS 2.0 e Atom, senza dipendenze.
 * Copre i feed delle newsletter (Substack, beehiiv, Ghost, ConvertKit…), non XML arbitrario.
 */

export interface ElementoFeed {
  id: string;
  titolo: string;
  link?: string;
  autore?: string;
  data?: Date;
  testo: string;
}

export interface Feed {
  titolo: string;
  elementi: ElementoFeed[];
}

const ENTITA: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", mdash: "—", ndash: "–",
  bull: "•", middot: "·", eacute: "é", egrave: "è", agrave: "à", ograve: "ò", ugrave: "ù", igrave: "ì",
};

export function decodificaEntita(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (tutto, codice: string) => {
    if (codice[0] === "#") {
      const n = codice[1]?.toLowerCase() === "x" ? parseInt(codice.slice(2), 16) : parseInt(codice.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : tutto;
    }
    return ENTITA[codice.toLowerCase()] ?? tutto;
  });
}

function senzaCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

/** Righe di servizio delle piattaforme di newsletter (pulsanti, inviti): rumore per l'adattamento. */
const RIGHE_DI_SERVIZIO = new RegExp(
  "^(subscribe now|subscribe|leave a comment|share|share this post|read more|upgrade to paid|" +
    "get \\d+% off.*|start writing|get the app|listen now|watch now|" +
    "this (essay|post|article) was originally published here\\.?)$",
  "i",
);

/** Toglie le righe di servizio (Substack, beehiiv…) lasciando intatto il resto del testo. */
export function senzaRigheDiServizio(testo: string): string {
  return testo
    .split("\n")
    .filter((riga) => !RIGHE_DI_SERVIZIO.test(riga.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Converte l'HTML di un articolo in testo semplice, mantenendo paragrafi ed elenchi. */
export function htmlInTesto(html: string): string {
  return decodificaEntita(
    html
      .replace(/<(script|style|figure|figcaption|svg)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<\/li>/gi, "")
      .replace(/<\/(p|div|h[1-6]|ul|ol|blockquote|section|tr)>/gi, "\n\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Contenuto testuale del primo tag `nome` (anche con prefisso, es. content:encoded). */
function tag(xml: string, nome: string): string | undefined {
  const nomeRe = nome.replace(":", "\\:");
  const m = new RegExp(`<${nomeRe}(?:\\s[^>]*)?>([\\s\\S]*?)</${nomeRe}>`, "i").exec(xml);
  return m ? senzaCdata(m[1] ?? "").trim() : undefined;
}

function attributo(xml: string, nomeTag: string, attr: string, filtro?: RegExp): string | undefined {
  const tagRe = new RegExp(`<${nomeTag}\\b[^>]*>`, "gi");
  for (const m of xml.matchAll(tagRe)) {
    if (filtro && !filtro.test(m[0])) continue;
    const a = new RegExp(`\\s${attr}\\s*=\\s*["']([^"']*)["']`, "i").exec(m[0]);
    if (a) return decodificaEntita(a[1] ?? "");
  }
  return undefined;
}

function data(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s.trim());
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function testoSemplice(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  const t = htmlInTesto(s);
  return t || undefined;
}

export function leggiFeed(xml: string): Feed {
  const atom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const bloccoElemento = atom ? "entry" : "item";
  const intestazione = xml.split(new RegExp(`<${bloccoElemento}[\\s>]`, "i"))[0] ?? "";
  const titoloFeed = testoSemplice(tag(intestazione, "title")) ?? "";

  const elementi: ElementoFeed[] = [];
  const re = new RegExp(`<${bloccoElemento}(?:\\s[^>]*)?>([\\s\\S]*?)</${bloccoElemento}>`, "gi");
  for (const m of xml.matchAll(re)) {
    const x = m[1] ?? "";
    const titolo = testoSemplice(tag(x, "title")) ?? "";
    const link = atom
      ? (attributo(x, "link", "href", /rel\s*=\s*["']alternate["']/i) ?? attributo(x, "link", "href"))
      : (testoSemplice(tag(x, "link")) ?? attributo(x, "link", "href"));
    const autore = atom
      ? testoSemplice(tag(tag(x, "author") ?? "", "name"))
      : (testoSemplice(tag(x, "dc:creator")) ?? testoSemplice(tag(x, "author")));
    const contenuto = atom
      ? (tag(x, "content") ?? tag(x, "summary"))
      : (tag(x, "content:encoded") ?? tag(x, "description"));
    const id = (atom ? testoSemplice(tag(x, "id")) : testoSemplice(tag(x, "guid"))) ?? link ?? titolo;
    if (!id) continue;
    elementi.push({
      id,
      titolo,
      link,
      autore,
      data: data(tag(x, atom ? "published" : "pubDate") ?? tag(x, "updated") ?? tag(x, "dc:date")),
      testo: contenuto ? senzaRigheDiServizio(htmlInTesto(decodificaSeEscapato(contenuto))) : "",
    });
  }
  return { titolo: titoloFeed, elementi };
}

/** Molti feed RSS mettono l'HTML nella description come testo escapato (&lt;p&gt;…). */
function decodificaSeEscapato(s: string): string {
  return /&lt;\/?[a-z]/i.test(s) && !/<\/?[a-z]/i.test(s) ? decodificaEntita(s) : s;
}
