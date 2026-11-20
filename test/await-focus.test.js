// await-focus.test.js — collaudo dell'attesa del focus di un progetto (T229),
// la logica del metodo D-Bus `AwaitProjectFocus`: `FocusWaiters` e
// `watchFocus` di `focus-wait.js`.
//
// Eseguire dalla root del repo:
//
//     gjs -m test/await-focus.test.js
//
// Nessun framework, come gli altri collaudi: il primo caso sbagliato lancia e
// `gjs -m` esce non-zero. Focus, orologio e display finti: il modulo li riceve
// per argomento e non importa niente dello shell. Il focus vero, il bus e la
// notifica restano al collaudo nella sessione reale (DLV5 di T229).

import {FocusWaiters, watchFocus, AWAIT_MAX_S} from '../compass@lamemind/focus-wait.js';
import {projectFocusOutcome} from '../compass@lamemind/desktop.js';

function eq(actual, expected, label) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e)
        throw new Error(`${label}: atteso ${e}, ottenuto ${a}`);
    print(`ok - ${label}`);
}

// ── Il mondo finto ───────────────────────────────────────────────────────────

const REGISTRY = [
    {id: 'loom-works', name: 'loom-works'},
    {id: 'ud-code', name: 'ud-code'},
];

/** Un emettitore alla GObject: connect, disconnect, emit. */
class Emitter {
    constructor() {
        this._handlers = new Map();
        this._next = 1;
    }

    connect(signal, fn) {
        const id = this._next++;
        this._handlers.set(id, {signal, fn});
        return id;
    }

    disconnect(id) {
        if (!this._handlers.delete(id)) throw new Error(`disconnect di un handler ignoto: ${id}`);
    }

    emit(signal) {
        for (const {signal: s, fn} of [...this._handlers.values()]) if (s === signal) fn();
    }

    get count() {
        return this._handlers.size;
    }
}

/** Una finestra Ptyxis il cui titolo è quello della tab attiva. */
class FakeWindow extends Emitter {
    constructor(title, wmClass = 'org.gnome.Ptyxis') {
        super();
        this.title = title;
        this.wmClass = wmClass;
    }

    get_title() {
        return this.title;
    }

    get_wm_class() {
        return this.wmClass;
    }

    switchTab(title) {
        this.title = title;
        this.emit('notify::title');
    }
}

class FakeDisplay extends Emitter {
    constructor() {
        super();
        this.focus_window = null;
    }

    focus(win) {
        this.focus_window = win;
        this.emit('notify::focus-window');
    }
}

/** L'orologio: i timer si fanno scattare a mano. */
class FakeClock {
    constructor() {
        this.timers = new Map();
        this._next = 1;
    }

    add(seconds, fn) {
        const id = this._next++;
        this.timers.set(id, {seconds, fn});
        return id;
    }

    remove(id) {
        if (!this.timers.delete(id)) throw new Error(`source_remove di un timer ignoto: ${id}`);
    }

    fire(id) {
        const t = this.timers.get(id);
        this.timers.delete(id);
        t.fn();
    }
}

/** Il cablaggio di compass, coi finti al posto dello shell. */
function world() {
    const display = new FakeDisplay();
    const clock = new FakeClock();
    const listening = [];
    let unwatch = null;
    const waiters = new FocusWaiters({
        outcomeOf: id => projectFocusOutcome(id, REGISTRY, display.focus_window),
        addTimeout: (s, fn) => clock.add(s, fn),
        removeTimeout: id => clock.remove(id),
        onListening: on => {
            listening.push(on);
            if (on) unwatch = watchFocus(display, () => waiters.check());
            else {
                unwatch();
                unwatch = null;
            }
        },
    });
    return {display, clock, listening, waiters};
}

function recorder() {
    const got = [];
    return {got, done: o => got.push(o)};
}

const loomWin = () => new FakeWindow('🧵 loom-works · T219');
const otherWin = () => new FakeWindow('🛒 ud-code · T12');

// ── I casi ───────────────────────────────────────────────────────────────────

{
    const w = world();
    w.display.focus(loomWin());
    const r = recorder();
    eq(w.waiters.wait('loom-works', 1800, r.done), null, 'focus già del progetto → nessuna attesa aperta');
    eq(r.got, ['si'], 'focus già del progetto → si subito');
    eq(w.listening, [], 'nessun ascolto per una risposta immediata');
    eq(w.clock.timers.size, 0, 'nessun timer per una risposta immediata');
}

{
    const w = world();
    w.display.focus(otherWin());
    const r = recorder();
    w.waiters.wait('money', 1800, r.done);
    eq(r.got, ['ignoto'], 'progetto fuori dal registry → ignoto subito');
}

{
    const w = world();
    w.display.focus(otherWin());
    const r = recorder();
    w.waiters.wait('loom-works', 0, r.done);
    eq(r.got, ['scaduta'], 'scadenza zero → scaduta subito, senza attesa');
}

{
    const w = world();
    const other = otherWin();
    w.display.focus(other);
    const r = recorder();
    const waiter = w.waiters.wait('loom-works', 1800, r.done);
    eq(waiter !== null, true, 'focus su un altro progetto → attesa aperta');
    eq(r.got, [], 'nessuna risposta finché il focus è altrove');
    eq(w.listening, [true], 'l’ascolto si accende con la prima attesa');
    eq([...w.clock.timers.values()].map(t => t.seconds), [1800], 'la scadenza del chiamante diventa il timer');
    eq(w.display.count, 1, 'un handler sul display (focus-window)');
    eq(other.count, 1, 'un handler sul titolo della finestra in focus');

    w.display.focus(new FakeWindow('🧵 loom-works — Firefox', 'firefox'));
    eq(r.got, [], 'un’altra applicazione col titolo del progetto non chiude l’attesa');
    eq(other.count, 0, 'il titolo della finestra lasciata non si segue più');

    const loom = loomWin();
    w.display.focus(loom);
    eq(r.got, ['si'], 'la finestra del progetto prende il focus → si');
    eq(w.listening, [true, false], 'l’ascolto si spegne con l’ultima attesa');
    eq(w.display.count, 0, 'nessun handler resta sul display');
    eq(loom.count, 0, 'nessun handler resta sul titolo');
    eq(w.clock.timers.size, 0, 'il timer della scadenza è tolto');
}

{
    const w = world();
    const mixed = new FakeWindow('🛒 ud-code · T12');
    w.display.focus(mixed);
    const r = recorder();
    w.waiters.wait('loom-works', 1800, r.done);
    mixed.switchTab('lamemind@host:~/work');
    eq(r.got, [], 'cambio di tab verso una tab senza chiave → attesa aperta');
    mixed.switchTab('🧵 loom-works · T219');
    eq(r.got, ['si'], 'cambio di tab verso una tab del progetto, senza cambio di focus → si');
}

{
    const w = world();
    w.display.focus(otherWin());
    const r = recorder();
    const ended = [];
    w.waiters.wait('loom-works', 1800, r.done, o => ended.push(`pulizia ${o}`));
    const [id] = [...w.clock.timers.keys()];
    w.clock.fire(id);
    eq(r.got, ['scaduta'], 'la scadenza arriva prima del focus → scaduta');
    eq(ended, ['pulizia scaduta'], 'la pulizia dell’attesa gira con l’esito');
    w.display.focus(loomWin());
    eq(r.got, ['scaduta'], 'un focus dopo la scadenza non risponde una seconda volta');
    eq(w.listening, [true, false], 'scaduta l’ultima attesa, l’ascolto si spegne');
}

{
    const w = world();
    w.display.focus(otherWin());
    const a = recorder(), b = recorder(), c = recorder();
    w.waiters.wait('loom-works', 1800, a.done);
    w.waiters.wait('loom-works', 900, b.done);
    w.waiters.wait('ud-code-assente', 1800, c.done);
    eq(c.got, ['ignoto'], 'un progetto che compass non conosce non apre un’attesa');
    const u = recorder();
    w.display.focus(loomWin());
    w.waiters.wait('ud-code', 1800, u.done);
    eq([a.got, b.got], [['si'], ['si']], 'due attese sullo stesso progetto → entrambe si allo stesso focus');
    eq(w.waiters.size, 1, 'resta aperta l’attesa dell’altro progetto');
    w.display.focus(otherWin());
    eq(u.got, ['si'], 'il focus sull’altro progetto chiude la sua attesa');
    eq(w.listening, [true, false, true, false], 'l’ascolto segue il numero di attese aperte');
}

{
    const w = world();
    w.display.focus(otherWin());
    const a = recorder(), b = recorder();
    const wa = w.waiters.wait('loom-works', 1800, a.done);
    w.waiters.wait('loom-works', 1800, b.done);
    w.waiters.end(wa, 'abbandonata');
    eq(a.got, ['abbandonata'], 'il chiamante sparito dal bus chiude la sua attesa');
    eq(w.waiters.size, 1, 'l’altra attesa resta aperta');
    w.waiters.end(wa, 'si');
    eq(a.got, ['abbandonata'], 'una seconda chiusura della stessa attesa non risponde');
    w.waiters.endAll('interrotta');
    eq(b.got, ['interrotta'], 'compass che si spegne chiude le attese con interrotta');
    eq(w.clock.timers.size, 0, 'nessun timer resta acceso');
    eq(w.display.count, 0, 'nessun handler resta sul display');
}

{
    const w = world();
    w.display.focus(null);
    const r = recorder();
    w.waiters.wait('loom-works', 10 * AWAIT_MAX_S, r.done);
    eq([...w.clock.timers.values()].map(t => t.seconds), [AWAIT_MAX_S],
        'nessuna finestra in focus → attesa aperta, scadenza oltre il tetto ridotta al tetto');
    w.display.focus(loomWin());
    eq(r.got, ['si'], 'dalla nessuna finestra alla finestra del progetto → si');
}
