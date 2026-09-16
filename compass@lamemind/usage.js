// usage.js — consumo dell'account Claude nella top bar
//
// ⚠️ MOCK — nessuna fonte collegata. I numeri sono finti e ciclano fra quattro
// scenari (§MOCK_SAMPLES) per rendere visibili tutti e quattro i livelli di
// enfasi senza dover consumare budget vero. La sostituzione con la fonte reale
// tocca solo `startMock`: la fonte è `GET https://api.anthropic.com/api/oauth/usage`
// (token in `~/.claude/.credentials.json`), che risponde `five_hour` e
// `seven_day`, ognuno con `utilization` e `resets_at` — esattamente le due cifre
// che `set()` già riceve per finestra, con `resets_at` da convertire da ISO 8601
// a secondi unix (`GLib.DateTime.new_from_iso8601(s, null).to_unix()`).
//
// Il dato è di ACCOUNT, non di progetto: vive accanto all'icona, fuori dai
// cappelli progetto del menu.
//
// Foglia del grafo dei moduli: non importa nessun fratello, quindi non gli serve
// il preambolo di cache-busting (`_Q`) che gli altri file portano in testa.

import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

// ── Livelli — soglia dinamica sull'autonomia residua ─────────────────────────
//
// L'enfasi NON sta sulla percentuale consumata: sta su quanto il budget rimasto
// copre il tempo che manca al reset. È la stessa formula della status line
// (`~/.claude/scripts/status-line.sh`), e la ragione per cui la percentuale nuda
// non basta si vede sui due estremi: 90% consumato a quattro minuti dal reset è
// tranquillità, 40% consumato nella prima mezz'ora è un ritmo che ti lascia a
// secco molto prima della fine.
//
//   burn  = pct / trascorso            quota bruciata al secondo
//   ttl   = (100 - pct) / burn         quanto dura ancora il budget a questo ritmo
//   cover = ttl / rimanente            quanta parte dell'attesa il budget copre
//
// `cover` sotto il 100% significa deficit: resti a secco prima del reset.
// Il grassetto è ESCLUSIVO del livello 3, e non si estende al 2: ambra e rosso
// sono adiacenti sull'asse che l'occhio distingue peggio a distanza, quindi se
// li porta entrambi il peso resta identico alla vista e i due livelli si
// confondono. Con il peso su uno solo la differenza si legge anche quando il
// colore non arriva.
const LEVELS = [
    {minCover: 150, color: 'rgba(255,255,255,0.55)', weight: 'normal'}, // quiete
    {minCover: 100, color: 'rgba(255,255,255,0.95)', weight: 'normal'}, // in pari
    {minCover:  60, color: '#e5a50a',                weight: 'normal'}, // deficit
    {minCover:  -1, color: '#f66151',                weight: 'bold'},   // a secco presto
];

// Ritorna l'indice in LEVELS, 0 = quiete … 3 = a secco presto.
//
// Degrada a 0 quando l'autonomia non è calcolabile: niente `resets_at`, orologio
// fuori sincrono, dato stantio con reset già passato. Un livello inventato su
// numeri incoerenti colorerebbe di rosso una situazione tranquilla, e chi guarda
// non ha modo di accorgersene — meglio nessuna enfasi che un'enfasi falsa.
export function levelOf(pct, remainingSeconds, windowSeconds) {
    if (!(remainingSeconds > 0) || remainingSeconds >= windowSeconds) return 0;
    if (!(pct > 0)) return 0;

    const elapsedSeconds = windowSeconds - remainingSeconds;
    const timeToLive     = (100 - pct) * elapsedSeconds / pct;
    const cover          = timeToLive * 100 / remainingSeconds;

    return LEVELS.findIndex(l => cover >= l.minCover);
}

// Lo stile è inline e non nello `stylesheet.css` per una ragione di sviluppo: il
// foglio di stile resta in cache nel loader anche dopo `compass reload` e
// richiederebbe un relogin a ogni ritocco di colore, mentre `impl.js` e i suoi
// fratelli si ricaricano a caldo. Per un mock che esiste per essere guardato e
// corretto, il relogin a ogni giro è il costo che conta.
const KEY_STYLE = 'font-size: 0.85em; color: rgba(255,255,255,0.45); ' +
                  'margin-left: 8px; margin-right: 4px;';

function valueStyle(level) {
    const {color, weight} = LEVELS[level];
    return `font-size: 1em; font-weight: ${weight}; color: ${color};`;
}

// Durata delle due finestre, in secondi: la sessione da 5 ore e la settimana.
const FIVE_HOUR_WINDOW = 5 * 3600;
const SEVEN_DAY_WINDOW = 7 * 86400;

// ── Widget ───────────────────────────────────────────────────────────────────

// Costruisce il gruppo `5h <pct>  7d <pct>` e restituisce la maniglia per
// aggiornarlo. Etichetta e valore sono due label distinte per poterle colorare
// in modo indipendente: l'etichetta resta un'ancora fissa e spenta, l'enfasi sta
// tutta sulla cifra.
export function buildUsage() {
    const box = new St.BoxLayout({
        y_expand: true,
        y_align:  Clutter.ActorAlign.CENTER,
    });

    const mkLabel = (text, style) => new St.Label({
        text,
        style,
        y_expand: true,
        y_align:  Clutter.ActorAlign.CENTER,
    });

    const fiveKey    = mkLabel('5h', KEY_STYLE);
    const fiveValue  = mkLabel('--', valueStyle(0));
    const sevenKey   = mkLabel('7d', KEY_STYLE);
    const sevenValue = mkLabel('--', valueStyle(0));

    box.add_child(fiveKey);
    box.add_child(fiveValue);
    box.add_child(sevenKey);
    box.add_child(sevenValue);

    // Ogni finestra arriva come {pct, resetsAt} — `resetsAt` in secondi unix.
    // L'API manda `utilization` in float (4.0), quindi l'arrotondamento sta qui
    // e non nel chiamante.
    const apply = (label, window, data) => {
        const pct       = Math.min(100, Math.round(data.pct));
        const remaining = data.resetsAt - (GLib.get_real_time() / 1e6);
        label.text  = `${pct}%`;
        label.style = valueStyle(levelOf(pct, remaining, window));
    };

    return {
        actor: box,
        set(fiveHour, sevenDay) {
            apply(fiveValue,  FIVE_HOUR_WINDOW, fiveHour);
            apply(sevenValue, SEVEN_DAY_WINDOW, sevenDay);
        },
    };
}

// ── Mock ─────────────────────────────────────────────────────────────────────

// Uno scenario per livello di enfasi, così il giro completo mostra l'intera
// scala. Ogni voce porta la percentuale e i secondi che mancano al reset: senza
// il secondo numero il livello non è calcolabile, ed è il punto del criterio —
// la stessa percentuale cade in due livelli diversi a seconda di quanto tempo
// resta.
//
// Le finestre sono tenute a metà corsa (2h30 sul 5h, 3 giorni e mezzo sul 7d),
// dove la percentuale «in pari» è il 50%: da lì gli scarti si leggono a occhio.
const MOCK_SAMPLES = [
    {five: {pct:  4, remaining: 9000}, seven: {pct: 21, remaining: 302400}}, // quiete
    {five: {pct: 45, remaining: 9000}, seven: {pct: 42, remaining: 302400}}, // in pari
    {five: {pct: 56, remaining: 9000}, seven: {pct: 58, remaining: 302400}}, // deficit
    {five: {pct: 72, remaining: 9000}, seven: {pct: 75, remaining: 302400}}, // a secco presto
];

const MOCK_PERIOD_SECONDS = 4;

// Ritorna l'id del timer, che il chiamante deve rimuovere in `destroy()`: un
// timeout GLib sopravvive alla distruzione dell'attore e continuerebbe a
// scrivere su label già morte a ogni `compass reload`.
export function startMock(widget) {
    let index = 0;
    const tick = () => {
        const sample = MOCK_SAMPLES[index % MOCK_SAMPLES.length];
        const now    = GLib.get_real_time() / 1e6;
        widget.set(
            {pct: sample.five.pct,  resetsAt: now + sample.five.remaining},
            {pct: sample.seven.pct, resetsAt: now + sample.seven.remaining},
        );
        index += 1;
        return GLib.SOURCE_CONTINUE;
    };
    tick();
    return GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, MOCK_PERIOD_SECONDS, tick);
}
