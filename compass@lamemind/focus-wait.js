// focus-wait.js — compass@lamemind — L'ATTESA DEL FOCUS DI UN PROGETTO (T229)
//
// Il deck mette in coda uno spawn chiesto da una conversazione quando la
// finestra in focus non è del progetto (`ProjectFocused` risponde `no`), e
// chiede a compass di avvisarlo quando lo diventa: il metodo D-Bus
// `AwaitProjectFocus`. La chiamata resta aperta finché la finestra in focus non
// è del progetto, e la risposta parte in quel momento. Il deck non sposta mai il
// focus da sé: la finestra la porta davanti l'utente.
//
// Un metodo che risponde al ritorno, e non un segnale (P2 preflight T229): il
// deck parla con compass lanciando `gdbus call`, una domanda e una parola di
// risposta, e non ha un secondo tipo di canale per tenere aperto un ascolto. E
// il metodo controlla il focus all'arrivo, quindi niente si perde fra il `no`
// di `ProjectFocused` e l'inizio dell'attesa.
//
// Quattro esiti, una parola ciascuno, come `ProjectFocused`:
//   `si`         — la finestra in focus è del progetto: subito, o al ritorno;
//   `scaduta`    — la scadenza che il deck ha passato è arrivata prima;
//   `interrotta` — compass si è spento o ricaricato durante l'attesa;
//   `ignoto`     — il progetto non è nel registry: non c'è niente da aspettare.
// Un quinto, `abbandonata`, non arriva a nessuno: il chiamante è sparito dal
// bus (deck chiuso), e l'attesa si chiude per non tenere un ascolto senza
// destinatario.
//
// Una finestra Ptyxis diventa «del progetto» in due modi, e l'attesa li ascolta
// entrambi: prende il focus, oppure è già in focus e l'utente cambia tab. Il
// titolo di una finestra Ptyxis è quello della sua tab attiva, e il progetto si
// riconosce dal titolo: in una finestra con tab di progetti diversi il cambio
// di tab cambia il progetto senza nessun cambio di focus.
//
// compass ascolta il focus solo mentre almeno un'attesa è aperta: a zero
// attese nessun handler resta collegato al compositore.
//
// Nessun import, né dello shell né dei fratelli: focus, timer e display
// arrivano per argomento. Così `gjs -m test/await-focus.test.js` esegue tutto
// il modulo con finestre, orologio e display finti, fuori da GNOME Shell.

/** Gli esiti che `AwaitProjectFocus` risponde al deck. */
export const AWAIT_OUTCOMES = ['si', 'scaduta', 'interrotta', 'ignoto'];

/** Tetto della scadenza, in secondi: il deck passa la sua (30 minuti), e un
 *  valore oltre il giorno è un errore del chiamante, non un'attesa voluta. */
export const AWAIT_MAX_S = 24 * 60 * 60;

/**
 * Le attese aperte, una per chiamata.
 *
 * `outcomeOf(projectId)` → `si` | `no` | `ignoto`: la finestra in focus ADESSO
 * (in compass, `Desktop.projectFocusOutcome` sul registry in memoria).
 * `addTimeout(secondi, fn)` → id; `removeTimeout(id)`: i timer della scadenza
 * (in compass, `GLib.timeout_add_seconds` e `GLib.source_remove`).
 * `onListening(acceso)`: chiamata al passaggio da zero a una attesa e da una a
 * zero, per collegare e scollegare l'ascolto del focus (`watchFocus`).
 */
export class FocusWaiters {
    constructor({outcomeOf, addTimeout, removeTimeout, onListening = () => {}}) {
        this._outcomeOf = outcomeOf;
        this._addTimeout = addTimeout;
        this._removeTimeout = removeTimeout;
        this._onListening = onListening;
        this._open = new Set();
    }

    get size() {
        return this._open.size;
    }

    /**
     * Apre un'attesa sul progetto e chiama `done(esito)` una volta sola.
     *
     * Il focus si controlla all'arrivo: già del progetto → `si`, progetto fuori
     * dal registry → `ignoto`, entrambi subito e senza attesa (ritorno `null`).
     * Altrimenti l'attesa resta aperta fino al focus, alla scadenza o a
     * `end`; il ritorno è l'attesa, da passare a `end`.
     *
     * `onEnd` (facoltativa) gira alla chiusura con l'esito, prima di `done`: la
     * pulizia di ciò che l'attesa ha aperto attorno a sé (l'ascolto del
     * chiamante sul bus, la notifica).
     */
    wait(projectId, deadlineS, done, onEnd = null) {
        const now = this._outcomeOf(projectId);
        if (now === 'si' || now === 'ignoto') {
            done(now);
            return null;
        }
        const seconds = Math.min(Math.max(0, Math.floor(Number(deadlineS) || 0)), AWAIT_MAX_S);
        if (seconds === 0) {
            done('scaduta');
            return null;
        }
        const waiter = {projectId, done, onEnds: onEnd ? [onEnd] : [], timer: null, ended: false};
        waiter.timer = this._addTimeout(seconds, () => {
            waiter.timer = null;
            this.end(waiter, 'scaduta');
        });
        this._open.add(waiter);
        if (this._open.size === 1) this._onListening(true);
        return waiter;
    }

    /** Aggiunge una pulizia a un'attesa già aperta (la notifica nasce dopo). */
    onEnd(waiter, fn) {
        if (waiter && !waiter.ended) waiter.onEnds.push(fn);
    }

    /** Il focus o il titolo della finestra in focus sono cambiati: chiude con
     *  `si` ogni attesa il cui progetto ora è davanti. Ogni altro esito lascia
     *  l'attesa aperta — un `ignoto` a metà vuol dire un registry riletto nel
     *  frattempo, non un progetto sparito. */
    check() {
        for (const waiter of [...this._open]) {
            if (this._outcomeOf(waiter.projectId) === 'si') this.end(waiter, 'si');
        }
    }

    /** Chiude l'attesa con `outcome`, una volta sola. */
    end(waiter, outcome) {
        if (!waiter || waiter.ended) return;
        waiter.ended = true;
        this._open.delete(waiter);
        if (waiter.timer !== null) {
            this._removeTimeout(waiter.timer);
            waiter.timer = null;
        }
        for (const fn of waiter.onEnds) {
            try {
                fn(outcome);
            } catch (e) {
                logError(e, '[Compass] await-focus: pulizia');
            }
        }
        if (this._open.size === 0) this._onListening(false);
        waiter.done(outcome);
    }

    /** Chiude ogni attesa aperta con `outcome`: lo spegnimento di compass. */
    endAll(outcome) {
        for (const waiter of [...this._open]) this.end(waiter, outcome);
    }
}

/**
 * Collega l'ascolto del focus: `onChange()` a ogni cambio della finestra in
 * focus e a ogni cambio di titolo della finestra in focus. → funzione che
 * scollega tutto.
 *
 * `display` è `global.display` in compass: emette `notify::focus-window`, e
 * `focus_window` è la finestra in focus o null. Il titolo si segue sulla sola
 * finestra in focus, ricollegato a ogni cambio di focus: un handler per ogni
 * finestra aperta costerebbe una chiamata a ogni titolo che cambia in un
 * terminale qualunque.
 */
export function watchFocus(display, onChange) {
    let titleWin = null;
    let titleId = 0;
    const unfollow = () => {
        if (titleWin && titleId) {
            try {
                titleWin.disconnect(titleId);
            } catch (_e) {
                // Una finestra chiusa nel frattempo: l'handler è già andato.
            }
        }
        titleWin = null;
        titleId = 0;
    };
    const follow = () => {
        unfollow();
        const win = display.focus_window ?? null;
        if (!win) return;
        titleWin = win;
        titleId = win.connect('notify::title', () => onChange());
    };
    const focusId = display.connect('notify::focus-window', () => {
        follow();
        onChange();
    });
    follow();
    return () => {
        display.disconnect(focusId);
        unfollow();
    };
}
