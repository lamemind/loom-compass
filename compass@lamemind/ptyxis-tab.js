// ptyxis-tab.js — compass@lamemind — LA TAB, VIA ACCESSIBILITÀ
//
// Processo a sé, mai importato da GNOME Shell: le chiamate AT-SPI sono D-Bus
// sincrone, e dentro il compositore lo fermerebbero finché Ptyxis risponde.
// `desktop.js` lo lancia con `Gio.Subprocess` asincrono e legge l'esito da stdout.
//
//   gjs -m ptyxis-tab.js [--salto-in-piu] <nome> [<nome>…]
//   gjs -m ptyxis-tab.js --elenca
//
// Porta davanti, nella sua finestra, la tab di Ptyxis il cui titolo è uno dei
// nomi. Più nomi perché una conversazione ne ha due — quello del registro e
// quello chiesto con `--name` — e la tab porta il secondo. Cerca in tutte le
// finestre Ptyxis: con due finestre dello stesso progetto, una ricerca legata
// a una finestra sola direbbe `assente` per una tab che esiste.
//
// Stampa l'esito sulla prima riga, una parola sola:
//   esatta  — la tab era già quella davanti nella sua finestra
//   tab     — cambiata, e dopo il salto il titolo della finestra è il nome
//   ambigua — il nome è in più di una tab: nessun salto, l'indice non è decidibile
//   assente — nessuna tab porta il nome: nessun salto
//   fallita — l'helper si è mosso, ma il titolo della finestra non è il nome
// e sulla seconda il titolo della finestra da portare davanti, quando ce n'è
// una sola: quella della tab, o quella che tiene tutte le tab omonime. Senza
// seconda riga compass ripiega sulla finestra del progetto.
// Esce 3 quando sul bus di accessibilità non c'è nessuna applicazione Ptyxis.
//
// Come si cambia tab: il nodo `frame` di ogni finestra espone le azioni senza
// parametri `page.next` e `page.previous`, perché GTK4 pubblica via AT-SPI le
// azioni abilitate senza parametro. Nessuna tab porta lo stato «selezionata»,
// e `GrabFocus` su un nodo GTK4 risponde «not supported»: la tab davanti si
// riconosce dal nome del frame, che è il titolo della finestra e segue la tab
// attiva. Il salto avanza un passo alla volta e rilegge il titolo dopo ogni
// passo: arriva anche quando la tab davanti ha un titolo doppio e la sua
// posizione non si può calcolare.
//
// `--salto-in-piu` è l'opzione di collaudo dell'oracolo: un passo in più dopo
// l'arrivo, che atterra sulla tab sbagliata e deve dare `fallita`.
//
// Copiato così com'è da coda@lamemind (progetto factory), che lo ha collaudato
// per primo: sotto questa testata i due file sono identici, e una correzione
// fatta in uno va portata nell'altro.

import Atspi from 'gi://Atspi?version=2.0';
import System from 'system';

const EXIT_USAGE  = 2;
const EXIT_NO_BUS = 3;

// libatspi tiene in cache il nome di un nodo, e senza un main loop che riceve
// gli eventi la cache non si aggiorna: dopo un cambio di tab il nome va riletto
// dal processo Ptyxis. Solo dopo un passo: `clear_cache` svuota anche i
// discendenti, e chiamato prima di scorrere l'albero raddoppia il tempo
// dell'helper (0,47 s contro 0,24 s misurati). All'avvio la cache è fresca.
function freshName(node) {
    node.clear_cache();
    return node.get_name() ?? '';
}

// I nodi `page tab` di un frame, nell'ordine della barra: le tab fissate, poi
// le altre. Una finestra con una tab sola non ne espone nessuno, perché la
// barra è nascosta.
function pageTabs(frame) {
    const tabs = [];
    const walk = node => {
        if (!node) return;
        if (node.get_role() === Atspi.Role.PAGE_TAB) {
            tabs.push(node.get_name() ?? '');
            return;
        }
        for (let i = 0; i < node.get_child_count(); i++) walk(node.get_child_at_index(i));
    };
    walk(frame);
    return tabs;
}

// Ogni finestra di ogni applicazione Ptyxis sul bus: anche un'istanza lanciata
// con `ptyxis -s` è un'applicazione a sé.
function ptyxisFrames() {
    const desktop = Atspi.get_desktop(0);
    const frames = [];
    let apps = 0;
    for (let a = 0; a < desktop.get_child_count(); a++) {
        const app = desktop.get_child_at_index(a);
        if (!app || !(app.get_name() ?? '').toLowerCase().includes('ptyxis')) continue;
        apps++;
        for (let f = 0; f < app.get_child_count(); f++) {
            const frame = app.get_child_at_index(f);
            if (!frame || frame.get_role() !== Atspi.Role.FRAME) continue;
            frames.push({frame, title: frame.get_name() ?? '', tabs: pageTabs(frame)});
        }
    }
    return {apps, frames};
}

function actionIndex(frame, name) {
    const action = frame.get_action_iface();
    if (!action) return -1;
    for (let i = 0; i < action.get_n_actions(); i++)
        if (action.get_action_name(i) === name) return i;
    return -1;
}

// Le tab che portano uno dei nomi, in tutte le finestre. La finestra con una
// tab sola conta per il suo titolo.
function findTargets(frames, names) {
    const hits = [];
    for (const f of frames) {
        if (f.tabs.length === 0) {
            if (names.includes(f.title)) hits.push({...f, index: 0});
            continue;
        }
        f.tabs.forEach((title, index) => {
            if (names.includes(title)) hits.push({...f, index});
        });
    }
    return hits;
}

// Verso del salto: il più corto quando la posizione della tab davanti è
// decidibile (un titolo solo), altrimenti avanti.
function stepAction(hit) {
    const current = hit.tabs.filter(t => t === hit.title).length === 1
        ? hit.tabs.indexOf(hit.title) : -1;
    if (current < 0) return 'page.next';
    const n = hit.tabs.length;
    const forward = (hit.index - current + n) % n;
    return forward <= n - forward ? 'page.next' : 'page.previous';
}

// → [esito, titolo della finestra dopo il salto]
function jump(hit, names, extraStep) {
    const action = hit.frame.get_action_iface();
    const index = actionIndex(hit.frame, stepAction(hit));
    if (!action || index < 0) return ['fallita', hit.title];
    let arrived = names.includes(hit.title);
    for (let step = 1; step < hit.tabs.length && !arrived; step++) {
        action.do_action(index);
        arrived = names.includes(freshName(hit.frame));
    }
    if (arrived && extraStep) action.do_action(index);
    const title = freshName(hit.frame);
    return [names.includes(title) ? 'tab' : 'fallita', title];
}

function focusTab(names, extraStep) {
    const {apps, frames} = ptyxisFrames();
    if (apps === 0) {
        printerr('ptyxis-tab: nessuna applicazione Ptyxis sul bus di accessibilità');
        return EXIT_NO_BUS;
    }
    const hits = findTargets(frames, names);
    let outcome, title = null;
    if (hits.length === 0) {
        outcome = 'assente';
    } else if (hits.length > 1) {
        outcome = 'ambigua';
        if (hits.every(h => h.frame === hits[0].frame)) title = hits[0].title;
    } else if (names.includes(hits[0].title) && !extraStep) {
        [outcome, title] = ['esatta', hits[0].title];
    } else {
        [outcome, title] = jump(hits[0], names, extraStep);
    }
    print(outcome);
    if (title) print(title);
    return 0;
}

function list() {
    const {apps, frames} = ptyxisFrames();
    if (apps === 0) {
        printerr('ptyxis-tab: nessuna applicazione Ptyxis sul bus di accessibilità');
        return EXIT_NO_BUS;
    }
    for (const f of frames) {
        print(`«${f.title}»`);
        f.tabs.forEach((t, i) => print(`  ${i + 1}${t === f.title ? ' ▶' : '  '} «${t}»`));
    }
    return 0;
}

function main(argv) {
    const extraStep = argv.includes('--salto-in-piu');
    const names = argv.filter(a => !a.startsWith('--')).map(a => a.trim()).filter(Boolean);
    Atspi.init();
    if (argv.includes('--elenca')) return list();
    if (names.length === 0) {
        printerr('uso: gjs -m ptyxis-tab.js [--salto-in-piu] <nome> [<nome>…] | --elenca');
        return EXIT_USAGE;
    }
    return focusTab(names, extraStep);
}

System.exit(main(ARGV));
