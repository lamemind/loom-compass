// twin-title.test.js — collaudo di `twinTitle` (T182), la scelta del carattere
// della conversazione gemella nel lancio claude di compass.
//
// Eseguire dalla root del repo:
//
//     gjs -m test/twin-title.test.js
//
// Nessun framework: GJS non ha un test runner, e `model.js` si importa fuori da
// GNOME Shell (soli GLib e Gio). Il primo caso sbagliato lancia, e `gjs -m` esce
// non-zero; tutti verdi → una riga `ok` per caso e uscita 0.
//
// Solo nomi finti: la funzione è pura, e i nomi chiesti dalle conversazioni
// vive le arrivano già letti. La lettura del registro vero resta fuori dal
// collaudo automatico.

import * as Model from '../compass@lamemind/model.js';

const {twinTitle, TWIN_MARKS} = Model;

function eq(actual, expected, label) {
    if (actual !== expected)
        throw new Error(`${label}: atteso ${JSON.stringify(expected)}, ottenuto ${JSON.stringify(actual)}`);
    print(`ok - ${label}`);
}

const BASE = '🧵 loom-works';

eq(twinTitle(BASE, []), BASE, 'nessuna viva → base');
eq(twinTitle(BASE, ['🧵 loom-works · T182', '🏭 factory']), BASE,
    'vive con altri nomi → base (uguaglianza intera, mai prefisso)');
eq(twinTitle(BASE, [BASE]), `${BASE} #`, 'base viva → primo carattere dopo uno spazio');
eq(twinTitle(BASE, [BASE, `${BASE} #`]), `${BASE} +`, 'base e primo vivi → secondo');
eq(twinTitle(BASE, [BASE, `${BASE} +`]), `${BASE} #`, 'il primo libero, anche se è un buco');
eq(twinTitle(BASE, [`${BASE} #`]), BASE, 'solo un gemello vivo, base libera → base');
eq(twinTitle(BASE, [BASE, ...TWIN_MARKS.map(m => `${BASE} ${m}`)]), BASE, 'insieme esaurito → base');

eq(TWIN_MARKS.join(''), '#+=~^%@*?!', 'insieme e ordine, gemelli di loom-deck/src/twin-title.ts');
for (const m of TWIN_MARKS) {
    if (!/^[\x21-\x7e]$/.test(m) || /[\w-]/.test(m))
        throw new Error(`carattere fuori contratto: ${JSON.stringify(m)}`);
}
print('ok - ogni carattere ASCII stampabile e fuori da [\\w-]');
