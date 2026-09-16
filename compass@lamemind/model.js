// model.js — compass@lamemind — IL DATO
//
// Registri (legacy `projects.json` e registry dconf loom), registro dei processi
// Claude vivi, cascata di stato per-sessione e rollup del cappello.
//
// Nessun widget, nessun `global`, nessun import locale: è la foglia del grafo dei
// moduli e l'unico file dell'estensione caricabile fuori da GNOME Shell — con
// soli GLib e Gio, `gjs -m` lo importa senza display e senza D-Bus.
//
// Le funzioni RITORNANO invece di assegnare campi: il chiamante fa
// `this._loomRegistry = Model.loadLoomRegistry()`. L'assegnazione resta
// incondizionata, o si cambierebbe in silenzio il comportamento su dconf fallito
// (vedi loadLoomRegistry).
//
// I due canali di stato viaggiano in UN oggetto solo, `channels`:
//   {profiles: Map(profileId → {state, seen}), sessions: Map(sessionId → {state})}
// La firma insegna il modello — due canali, due chiavi, due semantiche di `end` —
// invece di nasconderlo dietro argomenti posizionali.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// ── Registro dei processi Claude vivi (~/.claude/sessions) ───────────────────
//
// Un file JSON per processo CLI vivo, scritto dal CLI stesso. Fonte della vista
// R/O per-sessione: non passa da D-Bus, quindi vede anche le sessioni lanciate
// fuori da Ptyxis (che non hanno PTYXIS_PROFILE e non annunciano nulla).
//
// `status` ha TRE valori osservati, non due: `busy` (sta macinando), `waiting`
// (fermo perché aspetta te, con `waitingFor: "input needed"`) e `idle`. Il
// `waiting` copre da solo lo stato `ask` degli hook → la vista R/O distingue già
// «ti aspetta» da «lavora» senza il canale D-Bus. Resta fuori il solo `done`:
// una sessione che ha finito il turno torna `idle`, indistinguibile da una ferma
// da ore.
export const LIVE_STATUS_STATE = {
    busy:    'running',
    waiting: 'ask',
    idle:    'idle',
};

// Stati che una riga-sessione può prendere DALL'HOOK quando il registro tace.
//
// Ci sta solo ciò che il registro NON sa osservare. Uno stato che il registro
// osserva già non va preso anche dall'hook: l'annuncio è un evento che nessuno
// revoca, quindi resterebbe acceso dopo la fine della condizione che lo ha
// prodotto, e coprirebbe il valore vero letto dal file.
//
// `running` è escluso perché coincide con `busy` — un `running` sopravvissuto a
// un turno finito mostrerebbe ⚙️ su una sessione ferma.
//
// `ask` è escluso per la stessa ragione: coincide con `waiting`, che il CLI
// scrive su di sé insieme a `waitingFor: "input needed"`. Un `ask` annunciato su
// una domanda poi decaduta (ESC, permission prompt annullato) non ha nessun
// evento che lo spenga — il registro torna `idle` in silenzio — e la riga
// resterebbe ❓ finché non riscrivi in quella conversazione.
//
// `done` resta: è l'unico stato che il registro non distingue. Una sessione che
// ha finito il turno e una ferma da tre ore sono entrambe `idle` nel file, e
// solo l'hook `Stop` sa quale delle due è.
//
// L'hook `ask` non muore per questo — continua ad alimentare il badge della top
// bar, la campanella e la notifica, che passano da `setState` e non da qui.
export const HOOK_ONLY_STATE = new Set(['done', 'error']);

// ── Registry legacy (projects.json) ──────────────────────────────────────────

export function loadLegacyRegistry(extPath) {
    try {
        const path = GLib.build_filenamev([extPath, 'projects.json']);
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok) return [];
        const data = JSON.parse(new TextDecoder().decode(bytes));
        return (data.projects || []).sort(
            (a, b) => (a.order ?? 0) - (b.order ?? 0)
        );
    } catch (e) {
        logError(e, '[Compass] loadLegacyRegistry');
        return [];
    }
}

// ── Registry loom (dconf) — T34 ──────────────────────────────────────────────
// Legge il registry `/org/lamemind/loom/` via CLI `dconf dump` (il typelib
// GJS DConf non è installato → niente DConf.Client/.watch). Costruisce i
// cappelli: identità + surfaces tracked (`as`) + sottoalbero launch/<i>.

export function dconfDump(path) {
    try {
        const proc = Gio.Subprocess.new(
            ['dconf', 'dump', path],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
        );
        const [, stdout] = proc.communicate_utf8(null, null);
        return stdout ?? '';
    } catch (e) {
        logError(e, '[Compass] dconfDump');
        return '';
    }
}

// dump = keyfile-like: [group-path] + key=<GVariant text>. Parsing manuale
// (no GLib.KeyFile: evita il mismatch length UTF-8 su emoji multibyte).
export function parseDconfDump(text) {
    const groups = new Map(); // groupPath → Map(key → rawGVariant)
    let cur = null;
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith('[') && line.endsWith(']')) {
            cur = line.slice(1, -1);
            groups.set(cur, new Map());
        } else if (cur) {
            const eq = line.indexOf('=');
            if (eq > 0) groups.get(cur).set(line.slice(0, eq).trim(), line.slice(eq + 1));
        }
    }
    return groups;
}

export function gvStr(raw) {
    if (!raw) return null;
    try { return GLib.Variant.parse(null, raw, null, null).get_string()[0]; }
    catch (_e) { return null; }
}

export function gvStrv(raw) {
    if (!raw) return [];
    try { return GLib.Variant.parse(null, raw, null, null).get_strv(); }
    catch (_e) { return []; }
}

// Ritorna SEMPRE un array, `[]` compreso quando `dconf` fallisce. Il chiamante
// assegna incondizionatamente: un dump fallito produce quindi un menu vuoto,
// non l'ultimo stato buono. È il comportamento di oggi, ed è deliberato tenerlo
// invariato qui — correggerlo è un cambio di comportamento, e va fatto col suo
// commit e la sua riga di doc, non dentro uno spostamento di codice.
export function loadLoomRegistry() {
    try {
        const dump = dconfDump('/org/lamemind/loom/');
        if (!dump) return [];
        const groups = parseDconfDump(dump);

        const byId = new Map();
        const get  = (id) => {
            if (!byId.has(id)) byId.set(id, {id, launch: new Map(), bindings: {}});
            return byId.get(id);
        };

        for (const [g, kv] of groups) {
            let m;
            if ((m = g.match(/^projects\/([^/]+)$/))) {
                const p = get(m[1]);
                p.emoji    = gvStr(kv.get('emoji')) ?? '';
                p.name     = gvStr(kv.get('name'))  ?? m[1];
                p.dir      = gvStr(kv.get('dir'))   ?? '';
                p.surfaces = kv.has('surfaces') ? gvStrv(kv.get('surfaces')) : [];
                p.docsRoot = gvStr(kv.get('docsRoot')) ?? null;
                p.defaultSurface = gvStr(kv.get('defaultSurface')) ?? null;
                // order: int32 nel dump ("50", non quotato) → parse numerico diretto
                const ord = parseInt(kv.get('order'), 10);
                p.order = Number.isFinite(ord) ? ord : null;
            } else if ((m = g.match(/^projects\/([^/]+)\/launch\/(\d+)$/))) {
                const p = get(m[1]);
                p.launch.set(parseInt(m[2], 10), {
                    emoji:   gvStr(kv.get('emoji')) ?? '',
                    label:   kv.has('label') ? gvStr(kv.get('label')) : null,
                    command: gvStr(kv.get('command')) ?? '',
                });
            } else if ((m = g.match(/^projects\/([^/]+)\/bindings\/([^/]+)$/))) {
                // bindings/<kind>/profile → UUID Ptyxis: serve a lanciare la
                // surface tracked quando nessuna finestra è aperta (Slice 2).
                const p    = get(m[1]);
                const uuid = gvStr(kv.get('profile'));
                if (uuid) p.bindings[m[2]] = uuid;
            }
        }

        return [...byId.values()]
            .filter(p => p.name) // scarta gruppi orfani (solo launch, no header)
            .map(p => ({
                id:       p.id,
                emoji:    p.emoji,
                name:     p.name,
                dir:      p.dir,
                surfaces: p.surfaces,
                docsRoot: p.docsRoot, // sottocartella tasks.md (derivata dal file) → env deck
                defaultSurface: p.defaultSurface, // surface del bottone-nome; null → terminal
                order:    p.order, // posizione nel blocco loom; null → coda alfabetica
                bindings: p.bindings, // {kind → uuid Ptyxis} per il launch tracked
                label:    `${p.emoji} ${p.name}`, // derivata, mai scritta
                launch:   [...p.launch.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v),
            }))
            // gap-by-10 come il blocco vecchio; senza-order in coda, alfabetici (stabile)
            .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)
                || a.id.localeCompare(b.id));
    } catch (e) {
        logError(e, '[Compass] loadLoomRegistry');
        return [];
    }
}

// Mappa inversa binding UUID → progetto, estratta dall'inline che `setState`
// (impl.js) usa per risolvere il cappello loom da un `profileId` e poter
// notificare. Chi ne ha bisogno una seconda volta (badge, T149) la richiama
// invece di riscrivere lo stesso `find`.
export function projectByBinding(loomRegistry, profileId) {
    return loomRegistry.find(
        p => Object.values(p.bindings ?? {}).includes(profileId)
    ) ?? null;
}

// ── Registro dei processi vivi — vista R/O per-sessione (T119) ───────────────

// `~` iniziale espanso: il registry dconf può portare la dir in forma tilde,
// mentre il `cwd` del registro vivo è sempre assoluto.
export function expandDir(dir) {
    if (!dir) return null;
    const home = GLib.get_home_dir();
    let d = dir.startsWith('~') ? home + dir.slice(1) : dir;
    while (d.length > 1 && d.endsWith('/')) d = d.slice(0, -1);
    return d;
}

// Campo 22 di /proc/<pid>/stat (`starttime`), come stringa.
//
// Il taglio parte dall'ULTIMA `)`: il campo 2 è il nome del comando fra
// parentesi e può contenere spazi e parentesi sue, quindi uno split cieco sui
// primi campi sbaglia. Dopo il taglio il primo token è il campo 3 → starttime
// sta all'indice 19.
export function procStarttime(pid) {
    try {
        const [ok, bytes] = GLib.file_get_contents(`/proc/${pid}/stat`);
        if (!ok) return null;
        const line = new TextDecoder().decode(bytes);
        const cut  = line.lastIndexOf(')');
        if (cut < 0) return null;
        const fields = line.slice(cut + 1).trim().split(/\s+/);
        return fields[19] ?? null;
    } catch (_e) {
        return null; // processo morto fra readdir e lettura: non è un errore
    }
}

// Argomenti del processo, come array. `/proc/<pid>/cmdline` li tiene separati
// da NUL e ne mette uno anche in coda, da cui l'elemento vuoto finale da
// scartare. Ogni argomento arriva quindi INTERO, spazi compresi: non c'è nessun
// quoting da disfare, a differenza di una riga di comando ricostruita.
export function procCmdline(pid) {
    try {
        const [ok, bytes] = GLib.file_get_contents(`/proc/${pid}/cmdline`);
        if (!ok) return null;
        const argv = new TextDecoder().decode(bytes).split('\0');
        if (argv.length && argv[argv.length - 1] === '') argv.pop();
        return argv;
    } catch (_e) {
        return null; // processo morto, o non nostro: non è un errore
    }
}

// Il nome CHIESTO alla nascita del processo — il valore di `--name` (o del suo
// alias `-n`) negli argomenti — oppure `null` se non è stato chiesto niente.
//
// Non è un doppione del campo `name` del registro, ed è la ragione per cui
// serve: il registro porta il nome EFFETTIVO, che Claude Code può aver cambiato.
// Quando il nome chiesto è già preso da un'altra sessione il CLI lo rinomina
// appendendogli un suffisso (`🧵 loom-works` → `🧵 loom-works-cryptic-hopper`) e
// dichiara l'accaduto nel campo `nameSource: "collision"` — ma il TITOLO del
// terminale resta il nome chiesto, perché lo compone l'argomento, non il
// registro. Il caso non è di margine: due conversazioni sulla stessa task hanno
// lo stesso `--name` per costruzione, quindi una delle due è sempre rinominata.
//
// Chi deve risalire dal titolo di una finestra alla conversazione confronta
// perciò col nome chiesto, non col nome effettivo. La via alternativa —
// riconoscere la forma del suffisso — è un'euristica su un dettaglio interno del
// CLI che cambia fra i suoi percorsi (le sessioni in background usano ` (2)`,
// non un suffisso di parole), mentre l'argomento è la stessa stringa che compone
// il titolo: un'uguaglianza, non una somiglianza.
export function procRequestedName(pid) {
    const argv = procCmdline(pid);
    if (!argv) return null;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--name' || a === '-n') return argv[i + 1] ?? null;
        if (a.startsWith('--name=')) return a.slice('--name='.length);
        if (a.startsWith('-n='))     return a.slice('-n='.length);
    }
    return null;
}

// Le sessioni il cui titolo di tab è `title` — un INSIEME, non un valore.
//
// Due conversazioni sulla stessa task senza nota producono la stessa stringa:
// il titolo è composto da emoji di progetto, nome, task ed eventuale nota, e gli
// elementi che distinguerebbero due sorelle sono proprio quelli opzionali.
// Restituire la prima candidata scriverebbe l'azione sulla conversazione
// sbagliata senza che nessuno se ne accorga, quindi l'ambiguità esce da qui e la
// risolve chi ha una UI per chiederlo.
//
// Due confronti, entrambi per uguaglianza intera. Mai per prefisso: con
// `🧵 loom-works` in focus, un prefisso renderebbe candidata anche
// `🧵 loom-works · T159`, che è un'altra conversazione.
//   1. il nome EFFETTIVO del registro — copre la sessione il cui nome è quello
//      che ha chiesto, cioè il caso normale;
//   2. il nome CHIESTO negli argomenti — copre la sessione che il CLI ha
//      rinominato per collisione (vedi procRequestedName), il cui titolo di tab
//      è comunque il nome chiesto.
// Il secondo si paga solo quando il primo fallisce, quindi il caso normale non
// legge nessun file.
//
// `requestedNameOf` è un parametro con default e non una chiamata cablata: col
// parametro esplicito il filtro si collauda con nomi finti, senza processi vivi
// e senza `/proc`.
export function sessionsByName(sessions, title, requestedNameOf = procRequestedName) {
    const want = (title ?? '').trim();
    if (!want) return [];
    return sessions.filter(s =>
        (s.name ?? '').trim() === want ||
        (requestedNameOf(s.pid) ?? '').trim() === want
    );
}

// Il file resta su disco dopo un `kill -9`, e il pid può essere riciclato da
// un processo estraneo: la sola presenza del file non prova niente. Vivo =
// /proc esiste E il suo `starttime` combacia con il `procStart` registrato.
//
// Chiude potando gli stati per-sessione, e le due cose restano saldate come nel
// codice da cui questa funzione esce: separarle darebbe una firma più onesta ma
// due chiamanti da tenere allineati (`_init` e `_refreshMenu`), e dimenticarne
// uno non produce nessun errore — solo stati fantasma accesi per sempre.
export function loadLiveSessions(channels) {
    const live = [];
    try {
        const dirPath = GLib.build_filenamev([GLib.get_home_dir(), '.claude', 'sessions']);
        const dir     = Gio.File.new_for_path(dirPath);

        let en;
        try {
            en = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        } catch (_e) {
            pruneSessionStates(channels, live);
            return live; // directory assente (nessun Claude Code mai avviato) → zero sessioni
        }

        let info;
        while ((info = en.next_file(null)) !== null) {
            const name = info.get_name();
            if (!name.endsWith('.json')) continue;
            try {
                const [ok, bytes] = GLib.file_get_contents(GLib.build_filenamev([dirPath, name]));
                if (!ok) continue;
                const s = JSON.parse(new TextDecoder().decode(bytes));
                if (!s?.pid || !s?.cwd) continue;
                // Il registro tiene un file anche per i processi che non sono
                // una conversazione dell'utente: subagent SDK, fork parkeggiati
                // in background, spare pty host. Hanno lo stesso `cwd` del
                // progetto ma nessuna tab a cui tornare, ed elencarli direbbe
                // che l'utente ha aperte sessioni che non può raggiungere.
                //
                // Servono DUE gate perché i due campi si sono separati: un job
                // in background di Claude Code scrive `entrypoint:"cli"` come
                // una sessione vera e si distingue solo per `kind:"bg"`. Il
                // gate su `entrypoint` da solo lo lascia passare, e il pid è
                // davvero vivo — quindi nemmeno il controllo su `procStart`
                // lo scarta.
                if ((s.entrypoint ?? 'cli') !== 'cli') continue;
                if ((s.kind ?? 'interactive') !== 'interactive') continue;
                if (procStarttime(s.pid) !== String(s.procStart)) continue;
                live.push({
                    pid:       s.pid,
                    sessionId: s.sessionId ?? null,
                    cwd:       s.cwd,
                    name:      s.name ?? '',
                    status:    s.status ?? 'idle',
                    startedAt: s.startedAt ?? 0,
                    statusUpdatedAt: s.statusUpdatedAt ?? 0,
                });
            } catch (_e) {
                // file scritto a metà mentre lo leggevamo: salta questo giro
            }
        }
        en.close(null);
    } catch (e) {
        logError(e, '[Compass] loadLiveSessions');
    }
    pruneSessionStates(channels, live);
    return live;
}

// Toglie gli stati per-sessione che non hanno più un processo vivo a
// dichiararli. Servono due potature in una: la sessione chiusa manda `end` e
// si toglie da sé, ma un `kill -9` no; e un `/clear` cambia il `sessionId`
// DENTRO lo stesso processo, lasciando indietro una entry che nessun evento
// futuro nominerà mai più.
//
// MUTA `channels.sessions` in place: chi passa una copia invece della mappa
// viva ottiene una potatura che non pota, e il sintomo è una UI stantia (righe
// ✅ per conversazioni che non esistono più), non un errore.
export function pruneSessionStates(channels, liveSessions) {
    const alive = new Set(liveSessions.map(s => s.sessionId).filter(Boolean));
    for (const id of [...channels.sessions.keys()])
        if (!alive.has(id)) channels.sessions.delete(id);
}

// Sessioni vive di un progetto, in ordine di apertura.
//
// Il registro vivo non porta l'identità del progetto: l'unico aggancio è il
// `cwd`, confrontato con la `dir` del registry dconf — uguale o discendente.
// Copre le sessioni spawnate da deck e compass (partono a project root) e chi
// lancia `claude` in una sottocartella. NON copre i worktree lane, che sono
// directory SORELLE `{project}-{lane}`: prenderli richiederebbe un
// `git worktree list` per progetto a ogni apertura del menu, e un match per
// prefisso di nome non è praticabile (`loom-works-plugin` comincia per
// `loom-works-` e non è una lane).
//
// Ordine per `startedAt`, non per urgenza: le righe devono stare ferme fra
// due aperture del menu, o si clicca su quella sbagliata.
export function sessionsForProject(project, liveSessions) {
    const dir = expandDir(project.dir);
    if (!dir) return [];
    return liveSessions
        .filter(s => s.cwd === dir || s.cwd.startsWith(dir + '/'))
        .sort((a, b) => a.startedAt - b.startedAt);
}

// ── Marche per-conversazione: il sidecar del deck (T158) ─────────────────────
//
// `<project-dir>/.claude/loom/session-tasks.jsonl` — lo stesso file JSONL
// append-only con cui il deck lega una conversazione a una task. Compass ne
// SCRIVE tre campi (`priority`, `pinned`, `note`) e ne LEGGE sei: ai tre si
// aggiungono `taskId`, `title` e `model`, che scrive solo il deck.
//
// I due insiemi non coincidono, e la differenza è deliberata: leggere un campo
// costa niente e serve a mostrarlo, scriverne uno che appartiene a un altro
// produttore lo sovrascriverebbe col valore che aveva quando il popup si è
// aperto (§writeSessionMarks). `forkOf` resta fuori da entrambi: nessuna
// superficie di compass mostra il lineage di un fork.
//
// È la prima scrittura su disco di compass, e regge due scrittori senza lock
// perché nessuno dei due rilegge-modifica-riscrive: si appende una riga, e vince
// l'ultima che nomina il campo. Due toggle premuti a mezzo secondo di distanza
// dal deck e da qui non si perdono a vicenda — si sovrascrivono nell'ordine di
// arrivo.
//
// Il file è macchina-locale (`.gitignore` esclude `.claude/loom/`): la marca non
// entra in un commit.

export function sessionMarksPath(projectDir) {
    const dir = expandDir(projectDir);
    if (!dir) return null;
    return GLib.build_filenamev([dir, '.claude', 'loom', 'session-tasks.jsonl']);
}

// sessionId → {priority, pinned, pinRank, note, taskId, title, model}. LAST-WINS PER
// CAMPO, come il lettore del deck: vince l'ultimo record che NOMINA il campo, e
// un record che non lo nomina non lo tocca. `false` è quindi una smarcatura
// esplicita, non un'assenza — ed è il motivo per cui il campo va letto col
// `typeof` e non per verità.
//
// I quattro campi di testo (`note`, `taskId`, `title`, `model`) seguono la
// stessa regola con una cancellazione loro: la stringa VUOTA toglie la chiave
// invece di lasciare un valore vuoto. Chi legge non deve distinguere «mai
// scritto» da «cancellato», perché a schermo sono la stessa cosa — è la
// convenzione del deck, e cambiarla qui produrrebbe due letture divergenti
// dello stesso file.
//
// T162 — `taskId`, `title` e `model` entrano qui perché il blocco delle
// pinnate li mostra e li usa per riaprire la conversazione: il titolo è
// l'etichetta della riga, `taskId` decide se la ripresa è scoped o spot, il
// modello è quello con cui la conversazione gira. Prima il reader era una
// whitelist di tre campi e li scartava DI PROPOSITO, con la motivazione che
// «appartengono a chi li scrive»: vale per la scrittura, non per la lettura.
// Il sintomo di un campo mancante non sarebbe stato un errore ma una funzione
// degradata in silenzio — una ripresa spot dove doveva essere scoped.
//
// Nessuno dei tre è garantito: `title` e `model` sono EVENTUALMENTE CONSISTENTI
// (li riempie il deck quando gira, vedi `session-meta.ts` lato deck), quindi la
// UI deve avere un fallback per la finestra in cui mancano.

// I campi di TESTO del record, tutti con la stessa regola di lettura: la
// stringa vuota cancella, l'assenza non tocca niente. Un elenco e non quattro
// rami identici — un campo nuovo del sidecar si aggiunge qui e la regola la
// eredita, invece di essere ricopiata una quinta volta.
const MARK_TEXT_FIELDS = ['note', 'taskId', 'title', 'model'];

export function loadSessionMarks(projectDir) {
    const marks = new Map();
    const path  = sessionMarksPath(projectDir);
    if (!path) return marks;

    let text;
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok) return marks;
        text = new TextDecoder().decode(bytes);
    } catch (_e) {
        return marks; // sidecar assente: nessuna marca, non un errore
    }

    let order = 0; // posizione crescente dei record `pinned:true` → rango di pin
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let d;
        try { d = JSON.parse(line); } catch (_e) { continue; } // riga corrotta → salta
        if (typeof d?.sessionId !== 'string') continue;
        const cur = marks.get(d.sessionId) ?? {};
        if (typeof d.priority === 'boolean') cur.priority = d.priority;
        // Il RANGO del pin, oltre al pin: è la posizione nel file dell'ULTIMO
        // record `pinned:true`, quindi rango più alto = pinnata più di recente.
        // Serve a ordinare il blocco delle pinnate, e va derivato qui perché
        // l'ordine di inserimento della mappa è quello del PRIMO record che
        // nomina quella conversazione — per una pinnata, spinnata e ri-pinnata
        // i due ordini divergono, e a schermo vincerebbe il più vecchio.
        // Stessa semantica del lettore del deck, che sullo stesso file espone
        // il rango come valore della mappa `pinned`.
        if (typeof d.pinned === 'boolean') {
            cur.pinned = d.pinned;
            if (d.pinned) cur.pinRank = order++;
            else          delete cur.pinRank;
        }
        for (const f of MARK_TEXT_FIELDS) {
            if (typeof d[f] !== 'string') continue;
            if (d[f]) cur[f] = d[f];
            else      delete cur[f];
        }
        marks.set(d.sessionId, cur);
    }
    return marks;
}

// I campi del sidecar che compass può scrivere.
//
// Whitelist e non una lista di cortesia: il file è un contratto fra TRE repo a
// rilascio indipendente — il deck lo scrive, l'hook del plugin lo legge, compass
// fa entrambe le cose — e i lettori ignorano in silenzio un campo che non
// conoscono. Un campo scritto per errore non produrrebbe quindi nessun errore:
// resterebbe nel file per sempre, letto da nessuno. Gli altri campi del record
// (`taskId`, `forkOf`) appartengono a chi li scrive e compass non li tocca.
const MARK_FIELDS = new Set(['priority', 'pinned', 'note']);

// Appende UNA riga con tutti i campi passati.
//
// I campi vanno insieme in un record solo quando si toccano insieme: il lettore
// risolve last-wins PER CAMPO, quindi tre record separati darebbero lo stesso
// esito finale, ma lascerebbero tre istanti in cui lo stato su disco è a metà —
// e in quel mezzo ci sta il poll del deck, che mostrerebbe la marca accesa e la
// nota ancora vecchia.
//
// Simmetricamente, il record porta SOLO i campi che il chiamante nomina. Uno che
// portasse anche i campi non toccati li riscriverebbe col valore che avevano
// quando il pannello si è aperto, e il last-wins trasformerebbe quella
// riscrittura in una sovrascrittura di ciò che un altro scrittore (il deck) ha
// messo nel frattempo.
//
// Ritorna `true` solo se la riga è finita su disco, e il chiamante muove la UI
// solo allora: un toggle che si illumina senza che il file cambi mentirebbe, e il
// giro di menu successivo lo rimetterebbe indietro senza spiegare perché. Un
// insieme di campi VUOTO ritorna `true` senza scrivere: non c'è niente da fare,
// e non è un fallimento.
export function writeSessionMarks(projectDir, sessionId, fields) {
    const path = sessionMarksPath(projectDir);
    if (!path || !sessionId) return false;

    const rec = {sessionId};
    for (const [k, v] of Object.entries(fields ?? {})) {
        if (MARK_FIELDS.has(k)) rec[k] = v;
        else log(`[Compass] writeSessionMarks: campo "${k}" fuori contratto, scartato`);
    }
    if (Object.keys(rec).length === 1) return true; // solo sessionId: niente da scrivere

    try {
        const file = Gio.File.new_for_path(path);
        try {
            file.get_parent().make_directory_with_parents(null);
        } catch (_e) {
            // già esistente: `make_directory_with_parents` solleva su EXISTS
        }
        rec.ts = GLib.DateTime.new_now_utc().format_iso8601();
        const os = file.append_to(Gio.FileCreateFlags.NONE, null);
        os.write_all(new TextEncoder().encode(JSON.stringify(rec) + '\n'), null);
        os.close(null);
        return true;
    } catch (e) {
        logError(e, '[Compass] writeSessionMarks');
        return false;
    }
}

// Un campo solo — la forma che serve ai toggle del popup, dove ogni bottone è la
// sua azione e scrive da sé. Delega, non duplica: una seconda composizione del
// record divergerebbe dalla prima al primo campo aggiunto.
export function writeSessionMark(projectDir, sessionId, field, value) {
    return writeSessionMarks(projectDir, sessionId, {[field]: value});
}

/**
 * Le pinnate CORRENTI di un progetto, ordine di pin DESC (ultima in cima).
 *
 * Prende le marche già lette e il registro vivo, e ritorna una riga per
 * conversazione pinnata con la sua `session` viva accanto — `null` quando la
 * conversazione non è (più) un processo aperto. È la distinzione su cui si
 * biforca il click: una viva si focussa, una morta si riprende.
 *
 * Ordine per RANGO e non per insieme: le righe devono stare ferme fra due
 * aperture del menu, o si clicca su quella sbagliata. Il rango è stabile —
 * viene dalla posizione nel file append-only — quindi l'ordine non si muove
 * finché nessuno pinna o spinna.
 *
 * Una pinnata il cui transcript non esiste più (`⚠ pin stale` nel deck) resta
 * in lista: compass non lo può sapere senza aprire `~/.claude/projects/`, cosa
 * che non fa — la lettura di un transcript dentro il compositore bloccherebbe
 * il desktop. La ripresa di una stale parte e fallisce dentro la tab, che è il
 * posto giusto per vederlo.
 */
export function pinnedForProject(project, marks, liveSessions) {
    const live = new Map(
        sessionsForProject(project, liveSessions)
            .filter(s => s.sessionId)
            .map(s => [s.sessionId, s])
    );
    return [...marks.entries()]
        .filter(([, m]) => m.pinned === true)
        .sort((a, b) => (b[1].pinRank ?? 0) - (a[1].pinRank ?? 0))
        .map(([sessionId, mark]) => ({
            sessionId,
            mark,
            session: live.get(sessionId) ?? null,
        }));
}

// ── Età di una sessione (T149) ────────────────────────────────────────────

// Delta in millisecondi, SENZA formattazione. L'età dello stato è SEMPRE
// `now - statusUpdatedAt`, anche quando lo stato reso è `done`: sul registro
// quella sessione è `idle`, e `statusUpdatedAt` data il turno finito — la
// stessa identica lettura che serve a `running` e `ask`. Nessuna cascata per
// stato: il campo vale uniformemente per i tre stati che la riga mostra
// (misura preflight 2026-09-07).
export function sessionAges(session, nowMs) {
    return {
        stateAgeMs: Math.max(0, nowMs - session.statusUpdatedAt),
        convoAgeMs: Math.max(0, nowMs - session.startedAt),
    };
}

// Magnitudine invece di minuti nudi (P2): la cifra più fine è il minuto, poi
// ore, poi giorni. `Math.floor`, mai `round` — un'età non anticipa la soglia
// successiva.
export function formatAge(ms) {
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}g`;
}

// Glifo orologio unico e fisso per l'età (P4), non un set per stato. Porta un
// VS16 esplicito (U+1F550 U+FE0F): senza, U+1F550 resta un carattere
// tipografico monocromo. Il selettore si può usare senza cautele — siamo sotto
// Pango, non in un terminale dove la larghezza dichiarata e quella disegnata
// possono discordare.
export const CLOCK_EMOJI = '\u{1F550}️';

// `età-stato/età-conversazione` (D2, schizzo utente): il primo numero decide se
// andare in quella tab adesso, il secondo dà solo il contesto della durata della
// conversazione.
//
// Sta qui e non fra i widget perché la leggono DUE superfici — la riga-sessione
// del popup e le righe del modale sulla conversazione in focus — e una seconda
// composizione delle stesse due misure divergerebbe al primo aggiustamento di
// formato, mostrando due età diverse per la stessa conversazione.
//
// Testo nudo, senza separatore in testa: chi lo rende decide da sé se saldarlo a
// un vicino, e un ` · ` cablato qui lo lascerebbe appeso dove quel vicino non c'è.
export function ageText(session) {
    const {stateAgeMs, convoAgeMs} = sessionAges(session, Date.now());
    return `${CLOCK_EMOJI} ${formatAge(stateAgeMs)}/${formatAge(convoAgeMs)}`;
}

// ── Stato → emoji ────────────────────────────────────────────────────────────

// `running` e `ask` non sono pallini colorati come gli altri tre: dicono COSA
// sta succedendo, non un livello su una scala. Sono i due stati su cui si decide
// se andare in quella tab, e un glifo figurativo si becca in periferia dove un
// colore va confrontato con gli altri per essere letto.
//
// `⚙️` porta un VS16 (U+2699 U+FE0F), con la stessa cautela di `CLOCK_EMOJI`.
//
// Tabella di RESA, in un file che per il resto tiene il dato — ci sta per la
// stessa ragione di `ageText` sopra: la leggono il popup e il modale, e due copie
// mostrerebbero due glifi diversi per lo stesso stato. Resta comunque un dato
// senza widget attorno: nessun consumatore di model.js tocca St.
export const STATE_EMOJI = {
    running: '⚙️',
    ask:     '❓',
    done:    '✅',
    idle:    '⚪',
    error:   '🔴',
};

// Stato di UNA sessione, come cascata a due fonti (D3).
//
// Il registro vince ogni volta che dice qualcosa: `busy` e `waiting` sono
// fatti che il processo osserva su sé stesso, mentre l'hook è un annuncio che
// può essere vecchio di un turno. Solo su `idle` — il valore che il registro
// usa sia per «ha finito» sia per «ferma da ore» — decide lo stato semantico
// dell'hook, l'unico che sa dire `done`. Senza hook si resta su `idle`.
//
// La scala effettiva ha quattro valori, non cinque: `busy` del registro e
// `running` dell'hook sono lo stesso fatto (l'hook scatta su
// UserPromptSubmit, cioè nell'istante del passaggio a busy).
export function sessionState(session, channels) {
    const live = LIVE_STATUS_STATE[session.status] ?? 'idle';
    if (live !== 'idle') return live;
    const hook = sessionHookState(session, channels);
    return HOOK_ONLY_STATE.has(hook) ? hook : 'idle';
}

// Stato semantico annunciato dagli hook per QUESTA sessione, keyed su
// `sessionId` (`SetSessionState`). Un bridge vecchio chiama il solo `SetState`
// keyed sul profilo → qui non arriva niente e la riga resta su quel che dice
// il registro: degradazione, non guasto.
export function sessionHookState(session, channels) {
    if (!session.sessionId) return null;
    return channels.sessions.get(session.sessionId)?.state ?? null;
}

// Rollup → un solo stato per il pallino del cappello. Priorità congelata in
// project-config-architecture: error > ask > done > running > idle (error in
// testa: 🔴 è il più urgente).
//
// La popolazione ridotta sono le SESSIONI VIVE, non più uno slot per surface.
// Prima la sorgente era `_sessions` keyed su profilo Ptyxis, e tutte le tab
// claude di un progetto ne condividono uno solo: N sessioni entravano nel
// rollup come un elemento, l'ultimo annuncio arrivato. Il canale vecchio resta
// per le surface NON claude (il deck), che non compaiono nel registro dei
// processi Claude; per claude è escluso di proposito, o lo stato appiccicato
// al profilo da una sessione morta di `kill -9` (che non manda mai `end`)
// continuerebbe a colorare il cappello per sempre.
export function loomRollupState(project, sessions = [], channels) {
    const states = new Set();
    for (const s of sessions) states.add(sessionState(s, channels));
    for (const [kind, uuid] of Object.entries(project.bindings ?? {})) {
        if (kind === 'claude') continue;
        const st = channels.profiles.get(uuid);
        if (st) states.add(st.state);
    }
    for (const s of ['error', 'ask', 'done', 'running'])
        if (states.has(s)) return s;
    return 'idle';
}
