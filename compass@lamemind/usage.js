// usage.js — consumo dell'account Claude nella top bar
//
// Fonte: `GET https://api.anthropic.com/api/oauth/usage`, l'endpoint interno che
// Claude Code stesso interroga per il pannello `/usage`. Risponde `five_hour` e
// `seven_day`, ognuno con `utilization` (percentuale consumata) e `resets_at`
// (ISO 8601). È la sola fonte che vive fuori da una sessione: il JSON della
// status line esiste solo mentre una sessione ridisegna la barra, e la copia in
// `~/.claude.json` (`cachedUsageUtilization`) si aggiorna troppo di rado per
// essere creduta.
//
// Il dato è di ACCOUNT, non di progetto: vive accanto all'icona, fuori dai
// cappelli progetto del menu.
//
// Foglia del grafo dei moduli: non importa nessun fratello, quindi non gli serve
// il preambolo di cache-busting (`_Q`) che gli altri file portano in testa.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup?version=3.0';

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
//
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
// fratelli si ricaricano a caldo.
const SEPARATOR_STYLE = 'font-size: 0.85em; color: rgba(255,255,255,0.45);';

function valueStyle(level) {
    const {color, weight} = LEVELS[level];
    return `font-size: 1em; font-weight: ${weight}; color: ${color};`;
}

// Durata delle due finestre, in secondi: la sessione da 5 ore e la settimana.
const FIVE_HOUR_WINDOW = 5 * 3600;
const SEVEN_DAY_WINDOW = 7 * 86400;

// Placeholder mostrato finché la prima risposta non arriva, e di nuovo quando la
// fonte tace abbastanza a lungo (§FAILURES_BEFORE_UNKNOWN).
const UNKNOWN_TEXT = '--';

// ── Widget ───────────────────────────────────────────────────────────────────

// Costruisce il gruppo `<pct sessione> / <pct settimana>` e restituisce la
// maniglia per aggiornarlo. Niente etichette: la posizione dice la finestra, la
// sessione da 5 ore a sinistra e la settimana a destra. Le due cifre e il
// separatore sono label distinte per poterle colorare in modo indipendente: il
// separatore resta un'ancora fissa e spenta, l'enfasi sta tutta sulla cifra.
export function buildUsage() {
    const box = new St.BoxLayout({
        style:    'margin-left: 8px;',
        y_expand: true,
        y_align:  Clutter.ActorAlign.CENTER,
    });

    const mkLabel = (text, style) => new St.Label({
        text,
        style,
        y_expand: true,
        y_align:  Clutter.ActorAlign.CENTER,
    });

    const fiveValue  = mkLabel(UNKNOWN_TEXT, valueStyle(0));
    const separator  = mkLabel(' / ', SEPARATOR_STYLE);
    const sevenValue = mkLabel(UNKNOWN_TEXT, valueStyle(0));

    box.add_child(fiveValue);
    box.add_child(separator);
    box.add_child(sevenValue);

    // Ogni finestra arriva come {pct, resetsAt} — `resetsAt` in secondi unix.
    // L'API manda `utilization` in float (4.0), quindi l'arrotondamento sta qui
    // e non nel chiamante.
    const apply = (label, window, data) => {
        const pct       = Math.min(100, Math.round(data.pct));
        const remaining = data.resetsAt - nowSeconds();
        // Reset già passato: la finestra si è azzerata mentre la fonte taceva, e
        // la percentuale in mano descrive un budget che non esiste più. È il caso
        // in cui un dato vecchio non invecchia — salta di colpo dal 90% allo zero
        // — quindi sparisce invece di restare a mentire.
        if (remaining <= 0) {
            label.text  = UNKNOWN_TEXT;
            label.style = valueStyle(0);
            return;
        }
        label.text  = `${pct}%`;
        label.style = valueStyle(levelOf(pct, remaining, window));
    };

    return {
        actor: box,
        set(fiveHour, sevenDay) {
            apply(fiveValue,  FIVE_HOUR_WINDOW, fiveHour);
            apply(sevenValue, SEVEN_DAY_WINDOW, sevenDay);
        },
        // Le cifre spariscono invece di restare appese: una percentuale vecchia
        // che continua a essere mostrata come corrente è indistinguibile da una
        // fresca, e su un indicatore sempre in vista diventa una bugia stabile.
        setUnknown() {
            for (const label of [fiveValue, sevenValue]) {
                label.text  = UNKNOWN_TEXT;
                label.style = valueStyle(0);
            }
        },
    };
}

// ── Fonte ────────────────────────────────────────────────────────────────────

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

// L'endpoint sta dietro l'autenticazione OAuth di Claude Code e vuole il beta
// header che il CLI stesso manda: senza, risponde 401.
const OAUTH_BETA = 'oauth-2025-04-20';

const CREDENTIALS_PATH = GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);

// Cinque minuti. Un poll al minuto si prende un 429 (`rate_limit_error`) dopo
// una mezz'ora: l'endpoint ha un tetto suo, misurato sul ritmo con cui Claude
// Code lo interroga — cioè a richiesta, non in continuo. Il prezzo è che la
// cifra può essere vecchia di cinque minuti, e sotto carico pesante sono
// qualche punto percentuale.
const POLL_SECONDS = 300;

// Il tetto vero non è pubblicato, quindi dopo un rifiuto si raddoppia l'attesa
// invece di insistere allo stesso ritmo: 5, 10, 20, 40 minuti, poi fermi a
// un'ora. Il primo successo azzera il conto.
const BACKOFF_CAP_SECONDS = 3600;

// La cifra si ridisegna ogni minuto anche senza rete: il livello dipende dal
// tempo che manca al reset, che scorre fra un poll e l'altro — un'enfasi ferma
// all'ultima risposta descriverebbe un'autonomia che nel frattempo è cambiata.
const RENDER_SECONDS = 60;

// Oltre questa età il dato non si mostra più. La soglia è sul TEMPO e non sul
// numero di tentativi falliti: con l'attesa che raddoppia, contare i tentativi
// vorrebbe dire tenere in vista una cifra vecchia di ore.
const MAX_AGE_SECONDS = 15 * 60;

function nowSeconds() {
    return Math.floor(GLib.get_real_time() / 1e6);
}

// Il token va riletto a ogni giro e mai tenuto in memoria fra un poll e l'altro:
// Claude Code lo rinnova ogni poche ore riscrivendo il file, e una copia in
// cache smetterebbe di funzionare esattamente quando il file sul disco è tornato
// buono. Non finisce mai in un log, nemmeno troncato.
function readAccessToken() {
    try {
        const [ok, bytes] = GLib.file_get_contents(CREDENTIALS_PATH);
        if (!ok) return null;
        const payload = JSON.parse(new TextDecoder().decode(bytes));
        return payload?.claudeAiOauth?.accessToken ?? null;
    } catch (_e) {
        // File assente (autenticazione via keychain, o nessun login) o JSON
        // illeggibile: in entrambi i casi non c'è nulla da chiedere, e il giro
        // si conta come fallito.
        return null;
    }
}

// `resets_at` arriva come ISO 8601 con frazione di secondo e offset
// (`2026-09-17T02:50:00.776917+00:00`). Ritorna secondi unix, o null se il
// parser lo rifiuta — un formato che cambia non deve produrre un livello a caso.
function parseResetsAt(iso) {
    const dateTime = GLib.DateTime.new_from_iso8601(iso, null);
    return dateTime ? dateTime.to_unix() : null;
}

// Estrae una finestra dalla risposta. Ritorna null se manca la percentuale o la
// data del reset: senza entrambe il livello non è calcolabile.
function windowFrom(raw) {
    if (!raw || !Number.isFinite(raw.utilization)) return null;
    const resetsAt = parseResetsAt(raw.resets_at);
    if (resetsAt === null) return null;
    return {pct: raw.utilization, resetsAt};
}

// Avvia il polling e ritorna la maniglia per fermarlo. Il chiamante DEVE
// chiamare `stop()` in `destroy()`: il timeout GLib e la richiesta in volo
// sopravvivono entrambi alla distruzione dell'attore, e al giro dopo
// scriverebbero su label già morte.
export function startPolling(widget) {
    const session     = new Soup.Session({timeout: 10});
    const cancellable = new Gio.Cancellable();
    let lastGood      = null;  // {fiveHour, sevenDay, at} — ultima risposta buona
    let failures      = 0;
    let stopped       = false;
    let fetchTimerId  = 0;
    let renderTimerId = 0;

    // Disegno: legge solo l'ultima risposta buona, non tocca la rete.
    const render = () => {
        if (!lastGood || nowSeconds() - lastGood.at > MAX_AGE_SECONDS) {
            widget.setUnknown();
            return;
        }
        widget.set(lastGood.fiveHour, lastGood.sevenDay);
    };

    const onFailure = (reason) => {
        failures += 1;
        if (failures === 1) {
            // Solo il primo rifiuto di una caduta: al ritmo del backoff i
            // successivi non aggiungono niente, e il log serve a distinguere
            // «la fonte rifiuta» da «il widget è rotto».
            log(`[Compass] consumo account non disponibile: ${reason}`);
        }
        render();
    };

    const poll = () => {
        const token = readAccessToken();
        if (!token) {
            onFailure('nessun token in ~/.claude/.credentials.json');
            scheduleNextFetch();
            return;
        }

        const message = Soup.Message.new('GET', USAGE_URL);
        message.request_headers.append('Authorization', `Bearer ${token}`);
        message.request_headers.append('anthropic-beta', OAUTH_BETA);

        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (sess, result) => {
            if (stopped) return;
            try {
                const bytes = sess.send_and_read_finish(result);
                // `message.status_code` e non `get_status()`: il secondo marshalla
                // il numero nell'enum SoupStatus e SOLLEVA su un codice che quella
                // enum non elenca — 429 fra questi. L'eccezione arriverebbe prima
                // della riga che distingue i casi, e ogni rifiuto diventerebbe un
                // generico errore di parsing.
                const status = message.status_code;
                if (status !== 200) {
                    // 429 = stiamo chiedendo troppo spesso; ci pensa il backoff.
                    // 401 = token scaduto e nessuna sessione Claude Code lo ha
                    // ancora rinnovato. Non lo rinnoviamo da qui: il refresh
                    // riscriverebbe lo stesso file che Claude Code riscrive, e
                    // vincerebbe l'ultimo che scrive.
                    onFailure(`HTTP ${status} ${message.get_reason_phrase()}`);
                    scheduleNextFetch();
                    return;
                }

                const payload  = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                const fiveHour = windowFrom(payload.five_hour);
                const sevenDay = windowFrom(payload.seven_day);
                if (!fiveHour || !sevenDay) {
                    onFailure('risposta senza five_hour/seven_day utilizzabili');
                    scheduleNextFetch();
                    return;
                }

                failures = 0;
                lastGood = {fiveHour, sevenDay, at: nowSeconds()};
                render();
            } catch (e) {
                // Include l'annullamento della richiesta in volo su `stop()`:
                // lì `stopped` è già true e la callback è uscita sopra, quindi
                // quello che arriva qui è rete o parsing.
                onFailure(e.message);
            }
            scheduleNextFetch();
        });
    };

    // Un timer one-shot riarmato ogni volta, invece di un intervallo fisso: è
    // ciò che permette all'attesa di raddoppiare dopo un rifiuto e di tornare
    // alla cadenza piena al primo successo.
    function scheduleNextFetch() {
        if (stopped || fetchTimerId) return;
        const delay = Math.min(POLL_SECONDS * 2 ** failures, BACKOFF_CAP_SECONDS);
        fetchTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            fetchTimerId = 0;
            poll();
            return GLib.SOURCE_REMOVE;
        });
    }

    poll();
    renderTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, RENDER_SECONDS, () => {
        render();
        return GLib.SOURCE_CONTINUE;
    });

    return {
        stop() {
            stopped = true;
            cancellable.cancel();
            if (fetchTimerId)  GLib.Source.remove(fetchTimerId);
            if (renderTimerId) GLib.Source.remove(renderTimerId);
            fetchTimerId = renderTimerId = 0;
        },
    };
}
