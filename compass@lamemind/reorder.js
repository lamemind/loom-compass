// reorder.js — compass@lamemind — IL RIORDINO DEI PROGETTI
//
// La finestra delle impostazioni sposta le righe dei progetti; questo modulo
// trasforma l'ordine nuovo in numeri `order` e li scrive. Tre pezzi:
//
//   computeOrders   — puro: elenco di partenza + ordine finale → numeri nuovi
//   setOrderInText  — puro: testo del file di progetto → stesso testo con la
//                     sola riga `order` cambiata, o aggiunta
//   applyOrders     — I/O: file di progetto, copia in dconf, commit nel repo
//
// La fonte dell'ordine è il campo `order` del `.claude/loom-works.json` di ogni
// progetto. Il registry `/org/lamemind/loom/projects/<id>/order` ne tiene solo
// una copia, scritta da `refresh.sh`: scrivere solo la copia non basta, perché
// il primo refresh la riporta al valore del file. Per questo si scrive il file,
// poi la stessa cifra in dconf, poi si committa il file nel repo del progetto.
// Nessun push: `git push` pubblicherebbe tutti i commit che il ramo locale ha
// in più del remote, non il solo commit di compass.
//
// Importa solo GLib e Gio, come model.js: lo importano prefs.js (nel processo
// `org.gnome.Shell.Extensions`, fuori dallo shell) e i collaudi `gjs -m`. Le
// due funzioni pure non importano niente.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');

// Il file di progetto, relativo alla sua cartella: pathspec del commit e path
// letto da refresh.sh.
export const CONFIG_REL = '.claude/loom-works.json';

const REGISTRY_PROJECTS = '/org/lamemind/loom/projects';

// Passo dei numeri assegnati in coda, e di tutti quando nessuno resta fermo:
// la convenzione gap-by-10 del file di progetto.
export const ORDER_STEP = 10;

// ── Calcolo dei numeri (puro) ────────────────────────────────────────────────
//
// `initial`: i progetti come li ordina il registry, `[{id, order}]` con `order`
// intero o null. `finalIds`: gli stessi id nell'ordine delle righe. Ritorna una
// Map id → order nuovo, nell'ordine finale, coi SOLI progetti che cambiano
// numero: ogni voce è un file scritto e un commit in un repo diverso, quindi
// la mappa è la più corta possibile.
//
// Il menu ordina per `order` crescente, poi i progetti senza `order` in coda
// per id alfabetico (model.js, loadLoomRegistry). L'ordine finale si riproduce
// così:
//
//   1. Coda. I progetti senza `order` che chiudono l'elenco in ordine
//      alfabetico restano senza: il sort del menu li mette già lì. Ogni altro
//      progetto senza `order` prende un numero.
//   2. Catena ferma. Fra i progetti numerati prima della coda restano fermi
//      quanti più si può: la catena più lunga i cui numeri crescono nell'ordine
//      finale e lasciano abbastanza interi liberi per chi sta in mezzo. Con
//      `pos` la posizione nell'ordine finale, due progetti a, b della catena
//      stanno insieme se `b.order - a.order >= b.pos - a.pos`; il primo, se ha
//      qualcuno sopra, deve lasciare un intero positivo a ciascuno:
//      `order - pos >= 1`.
//   3. Buchi. Chi sta fra due progetti fermi prende interi distribuiti in modo
//      uniforme fra i loro due numeri; chi sta sopra il primo, interi da 1 al
//      suo numero; chi sta dopo l'ultimo, il suo numero più 10 a testa. Senza
//      nessun progetto fermo, tutti a passi di 10 da 10.
//
// A parità di lunghezza della catena resta fermo il progetto più in alto
// nell'ordine finale: è la regola fissa che decide, fra due progetti scambiati
// che costano lo stesso, quale dei due cambia numero.
//
// Due progetti con lo stesso `order` non stanno mai insieme nella catena: uno
// dei due prende un numero nuovo appena un'applicazione li coinvolge.
export function computeOrders(initial, finalIds) {
    const orderOf = new Map();
    for (const p of initial) {
        if (orderOf.has(p.id)) throw new Error(`id duplicato nell'elenco di partenza: ${p.id}`);
        orderOf.set(p.id, Number.isInteger(p.order) ? p.order : null);
    }
    if (finalIds.length !== orderOf.size || new Set(finalIds).size !== finalIds.length
        || finalIds.some(id => !orderOf.has(id)))
        throw new Error("l'ordine finale non è una permutazione dell'elenco di partenza");

    // 1. La coda: il suffisso più lungo di progetti senza `order` in ordine
    //    alfabetico, con lo stesso confronto del sort del menu.
    let tailStart = finalIds.length;
    while (tailStart > 0) {
        const id = finalIds[tailStart - 1];
        if (orderOf.get(id) !== null) break;
        if (tailStart < finalIds.length && id.localeCompare(finalIds[tailStart]) >= 0) break;
        tailStart--;
    }
    const head = finalIds.slice(0, tailStart);

    // 2. La catena ferma, fra i numerati della testa. n è al più qualche
    //    decina: la programmazione dinamica quadratica resta leggibile.
    const numbered = head
        .map((id, pos) => ({id, pos, order: orderOf.get(id)}))
        .filter(x => x.order !== null);
    const canStart  = x => x.pos === 0 || x.order - x.pos >= 1;
    const canFollow = (a, b) => b.order - a.order >= b.pos - a.pos;

    // chainLen[i]: lunghezza della catena più lunga che parte da numbered[i].
    const chainLen = new Array(numbered.length).fill(1);
    for (let i = numbered.length - 1; i >= 0; i--) {
        for (let j = i + 1; j < numbered.length; j++) {
            if (canFollow(numbered[i], numbered[j]))
                chainLen[i] = Math.max(chainLen[i], chainLen[j] + 1);
        }
    }
    let best = 0;
    numbered.forEach((x, i) => { if (canStart(x)) best = Math.max(best, chainLen[i]); });

    // Ricostruzione: ogni passo prende il primo candidato che regge la
    // lunghezza rimasta, cioè il progetto più in alto.
    const anchors = [];
    if (best > 0) {
        let i = numbered.findIndex((x, k) => canStart(x) && chainLen[k] === best);
        anchors.push(numbered[i]);
        while (anchors.length < best) {
            const prev = numbered[i];
            i = numbered.findIndex((x, k) => k > i && canFollow(prev, x) && chainLen[k] === chainLen[i] - 1);
            anchors.push(numbered[i]);
        }
    }

    // 3. I buchi, segmento per segmento fra due progetti fermi.
    const assigned = new Map();
    let prevPos = -1, prevOrder = 0;
    for (const anchor of [...anchors, null]) {
        const endPos = anchor ? anchor.pos : head.length;
        const count  = endPos - prevPos - 1;
        for (let t = 1; t <= count; t++) {
            assigned.set(head[prevPos + t], anchor
                ? prevOrder + Math.floor((anchor.order - prevOrder) * t / (count + 1))
                : prevOrder + ORDER_STEP * t);
        }
        if (anchor) { prevPos = anchor.pos; prevOrder = anchor.order; }
    }

    const changed = new Map();
    for (const id of head) {
        if (assigned.has(id) && assigned.get(id) !== orderOf.get(id)) changed.set(id, assigned.get(id));
    }
    return changed;
}
