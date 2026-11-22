// reorder.test.js — collaudo del riordino dei progetti (T247): `computeOrders`,
// il calcolo dei numeri `order` alla pressione di «Applica».
//
// Eseguire dalla root del repo:
//
//     gjs -m test/reorder.test.js
//
// Nessun framework, come `twin-title.test.js`: il primo caso sbagliato lancia e
// `gjs -m` esce non-zero. Solo funzioni pure di `reorder.js`: la scrittura su
// file, dconf e git resta fuori dal collaudo automatico.

import * as Reorder from '../compass@lamemind/reorder.js';

const {computeOrders} = Reorder;

function eq(actual, expected, label) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e)
        throw new Error(`${label}: atteso ${e}, ottenuto ${a}`);
    print(`ok - ${label}`);
}

function throws(fn, label) {
    try {
        fn();
    } catch (_e) {
        print(`ok - ${label}`);
        return;
    }
    throw new Error(`${label}: atteso un errore, nessuno`);
}

// [[id, order|null], …] → l'elenco di partenza, ordinato come lo ordina il menu.
const list = pairs => sortLikeMenu(pairs.map(([id, order]) => ({id, order})));

// Lo stesso sort di loadLoomRegistry in model.js.
function sortLikeMenu(projects) {
    return [...projects].sort((a, b) =>
        (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)
        || a.id.localeCompare(b.id));
}

// Sposta `id` alla posizione `to` dell'ordine di partenza.
function moveTo(initial, id, to) {
    const ids = initial.map(p => p.id).filter(x => x !== id);
    ids.splice(to, 0, id);
    return ids;
}

// Calcola, controlla la mappa attesa, poi l'invariante: i numeri nuovi, letti
// dal sort del menu, riproducono l'ordine finale.
function check(initial, finalIds, expected, label) {
    const changed = computeOrders(initial, finalIds);
    eq([...changed], expected, label);
    const applied = initial.map(p => ({id: p.id, order: changed.has(p.id) ? changed.get(p.id) : p.order}));
    eq(sortLikeMenu(applied).map(p => p.id), finalIds, `${label} — il menu riproduce l'ordine finale`);
    for (const order of changed.values()) {
        if (!Number.isInteger(order) || order < 1)
            throw new Error(`${label}: numero assegnato fuori contratto: ${order}`);
    }
}

// Il registry misurato al preflight: 11 progetti con `order`, 7 senza.
const REGISTRY = list([
    ['coface-hub', 5], ['agencyaccounting', 7], ['selectio-legacy', 10], ['selectiov2', 20],
    ['ud-code', 30], ['trading-java', 40], ['loom-works', 50], ['factory', 52],
    ['knowledge-series', 54], ['money', 60], ['cc-host', 70],
    ['accollo', null], ['agent-guild', null], ['ai-sales-broker', null], ['antfarm', null],
    ['job-hunting', null], ['vinted', null], ['vvv', null],
]);
const at = id => REGISTRY.findIndex(p => p.id === id);

check(REGISTRY, REGISTRY.map(p => p.id), [], 'ordine invariato → nessun numero cambia');

// Intero libero.
check(REGISTRY, moveTo(REGISTRY, 'money', at('factory')), [['money', 51]],
    'intero libero: money fra loom-works (50) e factory (52) → 51, il solo spostato');

// Nessun intero libero: cambia un vicino, non lo spostato.
const TIGHT = list([['a', 50], ['b', 51], ['c', 52], ['d', 60]]);
check(TIGHT, ['a', 'c', 'b', 'd'], [['b', 56]],
    'nessun intero libero: 52 sopra 51 → il 51 diventa 56, il 52 resta');

// Nessun numero si può tenere: tutti a passi di 10.
check(list([['a', 1], ['b', 2], ['x', null]]), ['x', 'a', 'b'], [['x', 10], ['a', 20], ['b', 30]],
    'nessun numero tenibile: tutti a passi di 10');

// Coda senza `order`.
check(REGISTRY, moveTo(REGISTRY, 'cc-host', at('accollo')), [['accollo', 65]],
    'coda: cc-host (70) sotto accollo → accollo prende 65, cc-host resta 70');
check(REGISTRY, moveTo(REGISTRY, 'vvv', at('accollo')), [['vvv', 80]],
    'coda: vvv in testa alla coda → vvv prende 80, gli altri restano senza order');
check(REGISTRY, moveTo(REGISTRY, 'accollo', at('job-hunting')), [['agent-guild', 80], ['ai-sales-broker', 90],
    ['antfarm', 100], ['job-hunting', 110]],
    'coda: accollo sotto job-hunting → un numero a chi resta sopra di lui; accollo, vinted, vvv restano in coda');

// Prima e ultima posizione.
check(REGISTRY, moveTo(REGISTRY, 'money', 0), [['money', 2]],
    'prima posizione: money sopra coface-hub (5) → 2');
check(list([['a', 1], ['b', 10]]), ['b', 'a'], [['a', 20]],
    'prima posizione senza interi sotto il primo: resta fermo lui, l\'altro va in coda');
check(list([['a', 10], ['b', 20], ['c', 30]]), ['b', 'c', 'a'], [['a', 40]],
    'ultima posizione: a (10) in fondo → 40');
check(REGISTRY, moveTo(REGISTRY, 'coface-hub', REGISTRY.length - 1), [['accollo', 80], ['agent-guild', 90],
    ['ai-sales-broker', 100], ['antfarm', 110], ['job-hunting', 120], ['vinted', 130], ['vvv', 140],
    ['coface-hub', 150]],
    'ultima posizione sotto la coda: chi è senza order prende un numero, coface-hub 150');

// Regola fissa a parità di costo.
check(list([['a', 10], ['b', 20], ['c', 30]]), ['a', 'c', 'b'], [['b', 40]],
    'scambio a costo pari: resta fermo il più in alto (c), cambia b');

// Un order non positivo in testa resta: il vincolo di positività vale solo
// sui numeri assegnati.
check(list([['a', 0], ['b', 10]]), ['a', 'b'], [], 'order 0 in prima riga: ordine invariato, nessun numero');

// A tappeto: permutazioni casuali del registry e spostamenti singoli, con un
// seme fisso perché un rosso si possa rigiocare. Controlla solo l'invariante
// (il menu riproduce l'ordine finale, numeri interi positivi) e che uno
// spostamento singolo con un intero libero accanto cambi un progetto solo.
let seed = 247;
const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
for (let round = 0; round < 500; round++) {
    const ids = REGISTRY.map(p => p.id);
    for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const changed = computeOrders(REGISTRY, ids);
    const applied = REGISTRY.map(p => ({id: p.id, order: changed.has(p.id) ? changed.get(p.id) : p.order}));
    if (JSON.stringify(sortLikeMenu(applied).map(p => p.id)) !== JSON.stringify(ids))
        throw new Error(`permutazione ${round}: il menu non riproduce ${ids.join(',')}`);
    if ([...changed.values()].some(o => !Number.isInteger(o) || o < 1))
        throw new Error(`permutazione ${round}: numero fuori contratto`);
}
print('ok - 500 permutazioni casuali: il menu riproduce sempre l\'ordine finale');

const SPREAD = list([['a', 10], ['b', 20], ['c', 30], ['d', 40], ['e', 50], ['f', 60]]);
for (const p of SPREAD) {
    for (let to = 0; to < SPREAD.length; to++) {
        const changed = computeOrders(SPREAD, moveTo(SPREAD, p.id, to));
        if (changed.size > 1)
            throw new Error(`${p.id} → ${to}: ${changed.size} progetti cambiano, atteso al più uno`);
    }
}
print('ok - spostamento singolo con interi liberi: al più un progetto cambia numero');

throws(() => computeOrders(REGISTRY, ['money']), 'ordine finale incompleto → errore');
throws(() => computeOrders(list([['a', 1], ['b', 2]]), ['a', 'a']), 'id ripetuto nell\'ordine finale → errore');

// ── setOrderInText: la sola riga `order` cambia ──────────────────────────────

const {setOrderInText} = Reorder;

// Righe diverse fra due testi, come le conterebbe `git diff`: una sostituzione
// vale una riga, un'aggiunta una riga.
function changedLines(a, b) {
    const x = a.split('\n'), y = b.split('\n');
    if (x.length === y.length) return x.filter((l, i) => l !== y[i]).length;
    const [short, long] = x.length < y.length ? [x, y] : [y, x];
    let i = 0;
    while (i < short.length && short[i] === long[i]) i++;
    return short.slice(i).every((l, k) => l === long[i + 1 + k]) ? long.length - short.length : -1;
}

// Forma di loom-works: `order` in mezzo, con la virgola.
const MIDDLE = `{
  "id": "loom-works",
  "emoji": "🧵",
  "owner": "LOCAL",
  "name": "loom-works",
  "surfaces": {
    "claude": true,
    "deck": true
  },
  "order": 50,
  "archivableDays": 30
}
`;
const middle = setOrderInText(MIDDLE, 51);
eq(middle.includes('  "order": 51,\n'), true, 'order in mezzo: cifra cambiata, virgola tenuta');
eq(changedLines(MIDDLE, middle), 1, 'order in mezzo: una riga di diff');

// Forma di factory: `order` ultima chiave, senza virgola.
const LAST = `{
  "id": "factory",
  "emoji": "🏭",
  "owner": "LAMEMIND",
  "name": "factory",
  "surfaces": { "claude": true, "deck": true },
  "order": 52
}
`;
const last = setOrderInText(LAST, 6);
eq(last.includes('  "order": 6\n}'), true, 'order in coda: cifra cambiata, nessuna virgola aggiunta');
eq(changedLines(LAST, last), 1, 'order in coda: una riga di diff');

// Forma di vinted: niente `order`, la riga entra dopo `name`.
const ABSENT = `{
  "id": "vinted",
  "emoji": "🛍️",
  "owner": "LAMEMIND",
  "name": "vinted",
  "surfaces": { "claude": true, "deck": true },
  "launch": [
    { "emoji": "📝", "label": "codium", "command": "codium ." }
  ],
  "defaultSurface": "deck",
  "permissionMode": "auto"
}
`;
const added = setOrderInText(ABSENT, 80);
eq(added.split('\n')[5], '  "order": 80,', 'order assente: riga aggiunta subito dopo name, stessa indentazione');
eq(changedLines(ABSENT, added), 1, 'order assente: una riga di diff');
eq(JSON.parse(added).order, 80, 'order assente: il file resta JSON valido');

eq(setOrderInText(MIDDLE.replace(/\n/g, '\r\n'), 51).includes('"order": 51,\r\n'), true,
    'fine riga CRLF tenuta');

throws(() => setOrderInText('{"id": "x", "name": "x", "surfaces": {}}', 10),
    'JSON su una riga sola → errore, nessuna scrittura');
throws(() => setOrderInText('{\n  "id": "x",\n  "name": "x",\n', 10), 'JSON invalido → errore');
throws(() => setOrderInText('[\n  1\n]', 10), 'JSON non oggetto → errore');
throws(() => setOrderInText(MIDDLE, 5.5), 'order non intero → errore');
throws(() => setOrderInText('{\n  "id": "x",\n  "name": "x",\n  "surfaces": {}, "order": 5\n}', 10),
    'order non su riga propria → errore');
throws(() => setOrderInText('{\n  "id": "x",\n  "name": "x"\n}', 10),
    'order assente e name senza virgola (ultima chiave) → errore');
throws(() => setOrderInText('{\n  "id": "x",\n  "name": "x",\n  "launch": {\n    "order": 3\n  }\n}', 10),
    'order annidato preso per quello di primo livello → errore della guardia');
