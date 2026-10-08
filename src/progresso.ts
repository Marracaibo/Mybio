import { inviaTesto, modificaMessaggio, eliminaMessaggio, type ConfigOpenWA } from "./openwa.js";

/**
 * "Si vede Jarvis lavorare": un messaggio che si aggiorna da solo con i passaggi in corso
 * (✅ fatti, ⏳ quello attuale) e alla fine diventa la risposta. Le modifiche sono raggruppate
 * (al massimo una ogni 2,5 secondi) per non martellare WhatsApp.
 */
export class Progresso {
  private id: string | undefined;
  private passi: string[] = [];
  private attuale = "";
  private ultimaModifica = 0;
  private inAttesa: ReturnType<typeof setTimeout> | undefined;
  private catena: Promise<void> = Promise.resolve();

  constructor(
    private readonly openwa: ConfigOpenWA,
    private readonly titolo = "🎩 Un istante, Signore…",
    private readonly rispondiA?: string,
  ) {}

  get messaggioId(): string | undefined {
    return this.id;
  }

  async inizia(): Promise<void> {
    const testo = this.titolo;
    this.id = await inviaTesto(this.openwa, testo, this.rispondiA ? { quotedMessageId: this.rispondiA } : {}).catch(() =>
      inviaTesto(this.openwa, testo).catch(() => undefined),
    );
  }

  /** Nuovo passaggio: il precedente diventa ✅. */
  passo(testo: string): void {
    if (this.attuale) this.passi.push(this.attuale);
    this.attuale = testo;
    this.programma();
  }

  private testo(): string {
    const righe = [...this.passi.slice(-8).map((p) => `✅ ${p}`), ...(this.attuale ? [`⏳ ${this.attuale}`] : [])];
    return `${this.titolo}\n\n${righe.join("\n")}`;
  }

  private programma(): void {
    if (!this.id || this.inAttesa) return;
    const attesa = Math.max(0, 2500 - (Date.now() - this.ultimaModifica));
    this.inAttesa = setTimeout(() => {
      this.inAttesa = undefined;
      this.ultimaModifica = Date.now();
      const testo = this.testo();
      this.catena = this.catena.then(() => modificaMessaggio(this.openwa, this.id!, testo).catch(() => undefined));
    }, attesa);
  }

  private async ferma(): Promise<void> {
    if (this.inAttesa) clearTimeout(this.inAttesa);
    this.inAttesa = undefined;
    await this.catena;
  }

  /** Sostituisce il messaggio con il testo finale; se non si può modificare, manda un messaggio nuovo. Restituisce l'id. */
  async fine(testo: string): Promise<string | undefined> {
    await this.ferma();
    if (this.id) {
      try {
        await modificaMessaggio(this.openwa, this.id, testo);
        return this.id;
      } catch {
        // troppo tardi per modificarlo (o modifica non riuscita): messaggio nuovo
      }
    }
    return inviaTesto(this.openwa, testo, this.rispondiA ? { quotedMessageId: this.rispondiA } : {}).catch(() =>
      inviaTesto(this.openwa, testo),
    );
  }

  /** Toglie il messaggio di avanzamento (es. quando la risposta è un vocale). */
  async elimina(): Promise<void> {
    await this.ferma();
    if (this.id) await eliminaMessaggio(this.openwa, this.id).catch(() => undefined);
  }
}

/** Come si chiama, nell'avanzamento, ogni strumento del maggiordomo. */
export function descriviPasso(nome: string, input: Record<string, unknown>): string {
  const q = (k: string) => String(input[k] ?? "").slice(0, 60);
  switch (nome) {
    case "web_search":
      return `🔎 Cerco sul web: “${q("query")}”`;
    case "web_fetch": {
      let host = q("url");
      try {
        host = new URL(String(input["url"])).hostname;
      } catch {
        /* url non valido: lo mostro com'è */
      }
      return `📖 Leggo ${host}`;
    }
    case "leggi_chat":
      return "💬 Rileggo la chat";
    case "cerca_memoria":
      return `🗄️ Cerco nella memoria del gruppo${input["parole"] ? `: “${String(input["parole"]).slice(0, 40)}”` : ""}`;
    case "dati_doublegram":
      return "📊 Consulto i numeri di Doublegram";
    case "assistenza_doublegram":
      return "🎧 Controllo l'assistenza clienti";
    case "invia_grafico":
      return "📈 Disegno il grafico";
    case "invia_card":
      return "🎨 Preparo la card";
    case "crea_sticker":
      return "🖌️ Disegno lo sticker";
    case "invia_sondaggio":
      return "🗳️ Preparo il sondaggio";
    case "programma_promemoria":
    case "elenca_promemoria":
    case "annulla_promemoria":
      return "⏰ Sistemo i promemoria";
    case "linear_crea":
    case "linear_cerca":
    case "linear_aggiorna":
      return "📋 Apro Linear";
    case "chiedi_approvazione":
      return "🗳️ Preparo la proposta";
    case "crea_file":
      return `📎 Avvio la creazione del file ${q("nome_file")}`;
    case "ricerca_approfondita":
      return "🧭 Avvio la ricerca approfondita";
    case "avvia_quiz":
      return "🎲 Preparo il quiz";
    case "ricorda":
    case "dimentica":
      return "📝 Aggiorno le note";
    case "crea_post_canale":
      return "📰 Passo la richiesta alla redazione (/post)";
    default:
      return `⚙️ ${nome}`;
  }
}
