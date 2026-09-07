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
                // Il registro tiene un file anche per i processi spawnati
                // dall'SDK (subagent, fork in background): stesso `cwd` del
                // progetto, ma nessuna tab a cui tornare e nessuno `status`.
                // Elencarli direbbe che l'utente ha aperte sessioni che non
                // può raggiungere. Solo `cli` è una sessione interattiva vera.
                if ((s.entrypoint ?? 'cli') !== 'cli') continue;
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
