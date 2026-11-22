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

// ── Riga `order` nel testo del file (puro) ───────────────────────────────────
//
// Cambia la sola cifra della riga `"order": N`; se la riga manca la aggiunge
// subito dopo la riga `"name"`, con la stessa indentazione e la virgola in coda.
// In entrambi i casi `git diff` mostra una riga sola. Mai una riscrittura con
// JSON.stringify: riformatterebbe un file scritto a mano.
//
// Lancia un Error col motivo, senza toccare niente, quando:
//   - il testo non è un oggetto JSON;
//   - `order` c'è ma non su riga propria, o su più righe;
//   - `order` manca e non c'è una e una sola riga `"name": "…",`;
//   - il testo nuovo, riletto come JSON, differisce dal vecchio in una chiave
//     diversa da `order` (la guardia contro un `order` annidato, per esempio).
export function setOrderInText(text, order) {
    if (!Number.isInteger(order)) throw new Error(`order non intero: ${order}`);

    let before;
    try {
        before = JSON.parse(text);
    } catch (e) {
        throw new Error(`JSON invalido: ${e.message}`);
    }
    if (before === null || typeof before !== 'object' || Array.isArray(before))
        throw new Error('il file non è un oggetto JSON');

    const ORDER_LINE = /^(\s*"order"\s*:\s*)-?\d+(\s*,?\s*)$/;
    const NAME_LINE  = /^(\s*)"name"\s*:\s*"(?:[^"\\]|\\.)*"\s*,\s*$/;

    const lines = text.split('\n');
    const orderAt = lines.flatMap((l, i) => ORDER_LINE.test(l) ? [i] : []);
    if (orderAt.length > 1) throw new Error('più di una riga "order"');

    if (orderAt.length === 1) {
        const i = orderAt[0];
        lines[i] = lines[i].replace(ORDER_LINE, (_line, lead, trail) => `${lead}${order}${trail}`);
    } else {
        if (Object.hasOwn(before, 'order'))
            throw new Error('"order" non sta su una riga propria');
        const nameAt = lines.flatMap((l, i) => NAME_LINE.test(l) ? [i] : []);
        if (nameAt.length !== 1)
            throw new Error('nessuna riga "order" e nessuna riga "name" su riga propria');
        const indent = lines[nameAt[0]].match(NAME_LINE)[1];
        lines.splice(nameAt[0] + 1, 0, `${indent}"order": ${order},`);
    }
    const next = lines.join('\n');

    const after = JSON.parse(next);
    const withoutOrder = o => { const c = {...o}; delete c.order; return JSON.stringify(c); };
    if (after.order !== order || withoutOrder(after) !== withoutOrder(before))
        throw new Error('la modifica toccherebbe altre chiavi oltre a "order"');
    return next;
}

// ── Scrittura (I/O) ──────────────────────────────────────────────────────────

async function run(argv) {
    try {
        const proc = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        const [stdout, stderr] = await proc.communicate_utf8_async(null, null);
        return {ok: proc.get_successful(), status: proc.get_exit_status(),
            stdout: stdout ?? '', stderr: (stderr ?? '').trim()};
    } catch (e) {
        return {ok: false, status: -1, stdout: '', stderr: e.message};
    }
}

function readText(path) {
    const [, bytes] = GLib.file_get_contents(path);
    return new TextDecoder().decode(bytes);
}

// replace_contents passa da un file temporaneo e lo rinomina sopra il vecchio,
// tenendone i permessi: un file a metà non esiste mai su disco.
function writeText(path, text) {
    Gio.File.new_for_path(path).replace_contents(new TextEncoder().encode(text),
        null, false, Gio.FileCreateFlags.NONE, null);
}

function firstLine(s) {
    return (s.split('\n').find(l => l.trim()) ?? '').trim();
}

// Legge, valida e prepara in memoria un progetto, senza scrivere niente.
// Ritorna il piano, o un Error col motivo.
async function prepare(project, order) {
    const dir  = project.dir;
    const path = GLib.build_filenamev([dir, CONFIG_REL]);
    let oldText;
    try {
        oldText = readText(path);
    } catch (e) {
        throw new Error(`file illeggibile: ${e.message}`);
    }
    const newText = setOrderInText(oldText, order);
    const declared = JSON.parse(oldText).id;
    if (declared !== project.id)
        throw new Error(`il file dichiara l'id «${declared}», il registry «${project.id}»`);

    // Lo stato git si legge PRIMA di scrivere: dopo la scrittura il file
    // differisce da HEAD in ogni caso.
    //
    // `git commit -- <file>` committa solo quel file anche con altro in stage,
    // ma lo committa intero: se il file ha già altre modifiche oltre a `order`,
    // entrerebbero nel commit. In quel caso si scrive e non si committa.
    let noCommit = null;
    const tracked = await run(['git', '-C', dir, 'ls-files', '--error-unmatch', '--', CONFIG_REL]);
    if (!tracked.ok) {
        noCommit = 'file non versionato: scritto, nessun commit';
    } else {
        const diff = await run(['git', '-C', dir, 'diff', '--quiet', 'HEAD', '--', CONFIG_REL]);
        if (diff.status === 1)
            noCommit = 'altre modifiche non committate nel file: scritto, nessun commit';
        else if (!diff.ok)
            noCommit = `stato git illeggibile, nessun commit: ${firstLine(diff.stderr)}`;
    }
    return {project, order, path, oldText, newText, noCommit};
}

// Esito per progetto, uno per ogni voce della mappa:
//   {id, name, order, written, committed, note, error}
// `note` è un caso senza commit (file non versionato, altre modifiche);
// `error` un fallimento. `aborted` vale true quando nessun file è stato
// scritto perché un progetto non si poteva preparare.
//
// Tre fasi, nell'ordine:
//   1. prepara tutti: un file illeggibile o invalido annulla l'applicazione
//      intera, nessun file e nessun valore dconf. `refresh.sh` salta un file
//      invalido, quindi in una rinumerazione scritta a metà quel progetto
//      resterebbe col numero vecchio in mezzo ai nuovi.
//   2. file e dconf, progetto per progetto. Se dconf fallisce il file torna al
//      testo di prima, e l'applicazione si ferma: i progetti già scritti hanno
//      file e dconf concordi, quelli dopo non sono toccati.
//   3. commit dei progetti scritti. Un commit fallito non disfa niente: file e
//      dconf concordano già.
export async function applyOrders(projects, orders) {
    const byId = new Map(projects.map(p => [p.id, p]));
    const results = new Map();
    for (const [id, order] of orders) {
        results.set(id, {id, name: byId.get(id)?.name ?? id, order,
            written: false, committed: false, note: null, error: null});
    }

    const plans = [];
    for (const [id, order] of orders) {
        const project = byId.get(id);
        try {
            if (!project) throw new Error('progetto non nel registry');
            plans.push(await prepare(project, order));
        } catch (e) {
            results.get(id).error = e.message;
        }
    }
    if ([...results.values()].some(r => r.error))
        return {aborted: true, results: [...results.values()]};

    const written = [];
    let stoppedBy = null;
    for (const plan of plans) {
        const r = results.get(plan.project.id);
        if (stoppedBy) {
            r.error = `non scritto: applicazione interrotta su ${stoppedBy}`;
            continue;
        }
        try {
            writeText(plan.path, plan.newText);
        } catch (e) {
            r.error = `scrittura del file fallita: ${e.message}`;
            stoppedBy = r.name;
            continue;
        }
        const key = `${REGISTRY_PROJECTS}/${plan.project.id}/order`;
        const dconf = await run(['dconf', 'write', key, String(plan.order)]);
        if (!dconf.ok) {
            r.error = `scrittura dconf fallita: ${firstLine(dconf.stderr) || `uscita ${dconf.status}`}`;
            try {
                writeText(plan.path, plan.oldText);
            } catch (e) {
                r.error += ` — e il file non è tornato al testo di prima: ${e.message}`;
            }
            stoppedBy = r.name;
            continue;
        }
        r.written = true;
        written.push(plan);
    }

    for (const plan of written) {
        const r = results.get(plan.project.id);
        if (plan.noCommit) {
            r.note = plan.noCommit;
            continue;
        }
        const commit = await run(['git', '-C', plan.project.dir, 'commit', '-q',
            '-m', `compass: order ${plan.project.id} → ${plan.order}`, '--', CONFIG_REL]);
        if (commit.ok)
            r.committed = true;
        else
            r.error = `commit fallito: ${firstLine(commit.stderr || commit.stdout) || `uscita ${commit.status}`}`;
    }
    return {aborted: false, results: [...results.values()]};
}
