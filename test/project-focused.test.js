// project-focused.test.js — collaudo di `projectFocusOutcome` (T198), la
// risposta del metodo D-Bus `ProjectFocused`: la finestra in focus è una
// finestra Ptyxis del progetto?
//
// Eseguire dalla root del repo:
//
//     gjs -m test/project-focused.test.js
//
// Nessun framework, come `twin-title.test.js`: il primo caso sbagliato lancia e
// `gjs -m` esce non-zero. Finestre e registry finti: la funzione riceve la
// finestra in focus per argomento, e `desktop.js` si importa fuori da GNOME
// Shell (soli GLib e Gio a livello di modulo).

import * as Desktop from '../compass@lamemind/desktop.js';

const {projectFocusOutcome} = Desktop;

function eq(actual, expected, label) {
    if (actual !== expected)
        throw new Error(`${label}: atteso ${JSON.stringify(expected)}, ottenuto ${JSON.stringify(actual)}`);
    print(`ok - ${label}`);
}

const REGISTRY = [
    {id: 'loom-works', name: 'loom-works'},
    {id: 'ud-code', name: 'ud-code'},
    {id: 'ud-code-legacy', name: 'ud-code-legacy'},
];

const win = (title, wmClass = 'org.gnome.Ptyxis') => ({
    get_title: () => title,
    get_wm_class: () => wmClass,
});

eq(projectFocusOutcome('loom-works', REGISTRY, win('🧵 loom-works · T198')), 'si',
    'tab claude del progetto davanti → si');
eq(projectFocusOutcome('loom-works', REGISTRY, win('🎴 loom-works [deck]')), 'si',
    'tab del deck davanti → si');
eq(projectFocusOutcome('loom-works', REGISTRY, win('🖥️ loom-works [term]')), 'si',
    'tab terminal davanti, emoji con VS16 → si');
eq(projectFocusOutcome('loom-works', REGISTRY, win('🛒 ud-code · T12')), 'no',
    'finestra di un altro progetto → no');
eq(projectFocusOutcome('ud-code', REGISTRY, win('🛒 ud-code-legacy · T3')), 'no',
    'progetto col nome che è prefisso di un altro → no, longest-match');
eq(projectFocusOutcome('ud-code-legacy', REGISTRY, win('🛒 ud-code-legacy · T3')), 'si',
    'il progetto più lungo → si');
eq(projectFocusOutcome('loom-works', REGISTRY, win('lamemind@host:~/work')), 'no',
    'finestra Ptyxis senza chiave di progetto → no');
eq(projectFocusOutcome('loom-works', REGISTRY, win('🧵 loom-works — Firefox', 'firefox')), 'no',
    'altra applicazione col titolo giusto → no, la tab nascerebbe in un\'altra finestra Ptyxis');
eq(projectFocusOutcome('loom-works', REGISTRY, null), 'no',
    'nessuna finestra in focus → no');
eq(projectFocusOutcome('money', REGISTRY, win('💰 money')), 'ignoto',
    'progetto fuori dal registry → ignoto, anche col titolo che lo nomina');
eq(projectFocusOutcome('loom-works', [], win('🧵 loom-works')), 'ignoto',
    'registry vuoto → ignoto');
