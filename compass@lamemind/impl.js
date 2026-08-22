// impl.js — compass@lamemind (Project Compass) — CODICE REALE (hot-reloadable)
// Caricato da extension.js (stub) via dynamic import cache-busted a ogni enable().
// NON esporta l'Extension: espone `CompassImpl {enable(ext), disable()}`.
// GNOME Shell 45+ (ES modules). Chiave sessione v1 = PTYXIS_PROFILE.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

// ── D-Bus interface ──────────────────────────────────────────────────────────

const DBUS_INTERFACE_XML = `
<node>
  <interface name="org.lamemind.Compass">
    <method name="SetState">
      <arg type="s" name="profile_id" direction="in"/>
      <arg type="s" name="state"      direction="in"/>
    </method>
    <!-- Aggiunto, non sostituito: i chiamanti sono script di shell che vivono
         fuori da questo repo e si aggiornano a mano. Cambiare la firma di
         SetState romperebbe ogni macchina non ancora allineata, e il guasto si
         presenterebbe come stato che smette di arrivare, non come errore. -->
    <method name="SetSessionState">
      <arg type="s" name="profile_id" direction="in"/>
      <arg type="s" name="session_id" direction="in"/>
      <arg type="s" name="state"      direction="in"/>
    </method>
    <method name="SetLabel">
      <arg type="s" name="profile_id" direction="in"/>
      <arg type="s" name="label"      direction="in"/>
    </method>
    <method name="Ping">
      <arg type="b" name="result" direction="out"/>
    </method>
  </interface>
</node>`;

// ── Stato → emoji ────────────────────────────────────────────────────────────

const STATE_EMOJI = {
    running: '🟢',
    ask:     '🟡',
    done:    '✅',
    idle:    '⚪',
    error:   '🔴',
};

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
const LIVE_STATUS_STATE = {
    busy:    'running',
    waiting: 'ask',
    idle:    'idle',
};

// Cap di righe-sessione per progetto: oltre, una riga di riepilogo `+N`. Serve
// perché il menu è una popup a lunghezza non limitata — dieci sessioni su un
// progetto spingerebbero fuori schermo i progetti sotto.
const SESSION_ROWS_MAX = 6;

// Stati che una riga-sessione può prendere DALL'HOOK quando il registro tace.
// `running` è escluso di proposito: coincide con `busy`, che il registro osserva
// direttamente — un `running` sopravvissuto a un turno finito mostrerebbe 🟢 su
// una sessione ferma.
const HOOK_ONLY_STATE = new Set(['ask', 'done', 'error']);

// ── Surface → emoji ──────────────────────────────────────────────────────────
//
// Emoji cablate delle due surface che spawnano una tab SENZA emoji di progetto:
// entrano nel titolo che spawniamo (`🎴 <name> [deck]`) e nei bottoni della riga.
// NON sono più una chiave del matcher — `titleKeyRe` accetta qualunque emoji →
// cambiarle qui non può rendere una tab invisibile.
// La surface `claude` non è qui: le sue tab portano l'emoji del PROGETTO, che
// arriva dal registry per-progetto (`p.emoji`), non da una costante.
const SURFACE_EMOJI = {
    deck:     '🎴',
    terminal: '🖥️',
};

// ── Chiave di titolo → progetto ──────────────────────────────────────────────
//
// `<emoji> <name>` in testa al titolo, con emoji GENERICA: le tab di una voce
// `launch[]` portano l'emoji custom del registry, sconosciuta a qualunque
// costante. La classe copre anche le sequenze (VS16, ZWJ, skin-tone), che sono
// più code point pittografici concatenati.
// Perché `^` e perché `(?![\w-])`: commento di `_resolveLoomWindows`.
// Cache: il matcher gira su ogni finestra × ogni progetto a ogni apertura menu,
// e la regex dipende dal solo `name`.
const EMOJI_HEAD = '[\\p{Extended_Pictographic}\\uFE0F\\u200D\\u{1F3FB}-\\u{1F3FF}]+';
const _titleKeyCache = new Map();
function titleKeyRe(name) {
    let re = _titleKeyCache.get(name);
    if (!re) {
        const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        re = new RegExp(`^${EMOJI_HEAD} ${esc}(?![\\w-])`, 'u');
        _titleKeyCache.set(name, re);
    }
    return re;
}

// ── Implementazione servizio D-Bus ───────────────────────────────────────────

class CompassService {
    constructor(indicator) {
        this._indicator = indicator;
    }

    SetState(profileId, state) {
        this._indicator.setState(profileId, state);
    }

    SetSessionState(profileId, sessionId, state) {
        this._indicator.setSessionState(profileId, sessionId, state);
    }

    SetLabel(_profileId, _label) {
        // v1: no-op — SetLabel dinamica è Fase 6
    }

    Ping() {
        return new GLib.Variant('(b)', [true]);
    }
}

// ── Indicatore panel ─────────────────────────────────────────────────────────

// GTypeName unico per ogni load: il re-import (hot-reload) rieseguirebbe
// registerClass con lo stesso nome → "Type name already registered". Il suffisso
// monotonic rende ogni caricamento un GType distinto.
const CompassIndicator = GObject.registerClass(
{GTypeName: 'CompassIndicator_' + GLib.get_monotonic_time()},
class CompassIndicator extends PanelMenu.Button {

    _init(extensionObj) {
        super._init(0.0, 'Project Compass');
        this._ext       = extensionObj;
        this._sessions  = new Map(); // profileId → {state, seen}
        this._sessionStates = new Map(); // sessionId → {state} — canale per-sessione (T119)
        this._registry  = [];
        this._loomRegistry = []; // registry dconf loom (T34) — cappelli + surface
        this._liveSessions = []; // registro ~/.claude/sessions filtrato sui vivi (T119)
        this._winMap             = null; // cache aggiornata a ogni _buildMenu
        this._loomWins           = null; // cache window-map (project-level) progetti loom
        this._notificationSource = null;

        // ── Layout top-bar: [icona] [badge] ─────────────────────────────────
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});

        this._icon = new St.Label({
            text: '🖥',
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._badge = new St.Label({
            text:        '',
            visible:     false,
            y_expand:    true,
            y_align:     Clutter.ActorAlign.CENTER,
            style_class: 'ws-badge',
        });

        box.add_child(this._icon);
        box.add_child(this._badge);
        this.add_child(box);

        // ── Bootstrap ────────────────────────────────────────────────────────
        this._loadRegistry();
        this._loadLoomRegistry();
        this._loadLiveSessions();
        this._buildMenu();

        // Apertura menu → segna tutto visto + ricostruisce
        this.menu.connect('open-state-changed', (menu, open) => {
            if (!open) return;
            this._markAllSeen();
            this._updateBadge();
            this._loadLoomRegistry(); // niente watch dconf (no typelib) → refresh su apertura
            // Niente cache sul registro vivo: `status` cambia a ogni turno, e una
            // cache mostrerebbe idle su una sessione che sta lavorando — cioè il
            // difetto esatto che la vista esiste per non avere.
            this._loadLiveSessions();
            this._buildMenu();
        });
    }

    // ── Registry ─────────────────────────────────────────────────────────────

    _loadRegistry() {
        try {
            const path = GLib.build_filenamev([this._ext.path, 'projects.json']);
            const [ok, bytes] = GLib.file_get_contents(path);
            if (!ok) return;
            const data = JSON.parse(new TextDecoder().decode(bytes));
            this._registry = (data.projects || []).sort(
                (a, b) => (a.order ?? 0) - (b.order ?? 0)
            );
        } catch (e) {
            logError(e, '[Compass] _loadRegistry');
        }
    }

    // ── Registry loom (dconf) — T34 ──────────────────────────────────────────
    // Legge il registry `/org/lamemind/loom/` via CLI `dconf dump` (il typelib
    // GJS DConf non è installato → niente DConf.Client/.watch). Costruisce i
    // cappelli: identità + surfaces tracked (`as`) + sottoalbero launch/<i>.

    _dconfDump(path) {
        try {
            const proc = Gio.Subprocess.new(
                ['dconf', 'dump', path],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
            );
            const [, stdout] = proc.communicate_utf8(null, null);
            return stdout ?? '';
        } catch (e) {
            logError(e, '[Compass] _dconfDump');
            return '';
        }
    }

    // dump = keyfile-like: [group-path] + key=<GVariant text>. Parsing manuale
    // (no GLib.KeyFile: evita il mismatch length UTF-8 su emoji multibyte).
    _parseDconfDump(text) {
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

    _gvStr(raw) {
        if (!raw) return null;
        try { return GLib.Variant.parse(null, raw, null, null).get_string()[0]; }
        catch (_e) { return null; }
    }

    _gvStrv(raw) {
        if (!raw) return [];
        try { return GLib.Variant.parse(null, raw, null, null).get_strv(); }
        catch (_e) { return []; }
    }

    _loadLoomRegistry() {
        this._loomRegistry = [];
        try {
            const dump = this._dconfDump('/org/lamemind/loom/');
            if (!dump) return;
            const groups = this._parseDconfDump(dump);

            const byId = new Map();
            const get  = (id) => {
                if (!byId.has(id)) byId.set(id, {id, launch: new Map(), bindings: {}});
                return byId.get(id);
            };

            for (const [g, kv] of groups) {
                let m;
                if ((m = g.match(/^projects\/([^/]+)$/))) {
                    const p = get(m[1]);
                    p.emoji    = this._gvStr(kv.get('emoji')) ?? '';
                    p.name     = this._gvStr(kv.get('name'))  ?? m[1];
                    p.dir      = this._gvStr(kv.get('dir'))   ?? '';
                    p.surfaces = kv.has('surfaces') ? this._gvStrv(kv.get('surfaces')) : [];
                    p.docsRoot = this._gvStr(kv.get('docsRoot')) ?? null;
                    p.defaultSurface = this._gvStr(kv.get('defaultSurface')) ?? null;
                    // order: int32 nel dump ("50", non quotato) → parse numerico diretto
                    const ord = parseInt(kv.get('order'), 10);
                    p.order = Number.isFinite(ord) ? ord : null;
                } else if ((m = g.match(/^projects\/([^/]+)\/launch\/(\d+)$/))) {
                    const p = get(m[1]);
                    p.launch.set(parseInt(m[2], 10), {
                        emoji:   this._gvStr(kv.get('emoji')) ?? '',
                        label:   kv.has('label') ? this._gvStr(kv.get('label')) : null,
                        command: this._gvStr(kv.get('command')) ?? '',
                    });
                } else if ((m = g.match(/^projects\/([^/]+)\/bindings\/([^/]+)$/))) {
                    // bindings/<kind>/profile → UUID Ptyxis: serve a lanciare la
                    // surface tracked quando nessuna finestra è aperta (Slice 2).
                    const p    = get(m[1]);
                    const uuid = this._gvStr(kv.get('profile'));
                    if (uuid) p.bindings[m[2]] = uuid;
                }
            }

            this._loomRegistry = [...byId.values()]
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
            logError(e, '[Compass] _loadLoomRegistry');
        }
    }

    // ── Registro dei processi vivi — vista R/O per-sessione (T119) ───────────

    // `~` iniziale espanso: il registry dconf può portare la dir in forma tilde,
    // mentre il `cwd` del registro vivo è sempre assoluto.
    _expandDir(dir) {
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
    _procStarttime(pid) {
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
    _loadLiveSessions() {
        this._liveSessions = [];
        try {
            const dirPath = GLib.build_filenamev([GLib.get_home_dir(), '.claude', 'sessions']);
            const dir     = Gio.File.new_for_path(dirPath);

            let en;
            try {
                en = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            } catch (_e) {
                return; // directory assente (nessun Claude Code mai avviato) → zero sessioni
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
                    if (this._procStarttime(s.pid) !== String(s.procStart)) continue;
                    this._liveSessions.push({
                        pid:       s.pid,
                        sessionId: s.sessionId ?? null,
                        cwd:       s.cwd,
                        name:      s.name ?? '',
                        status:    s.status ?? 'idle',
                        startedAt: s.startedAt ?? 0,
                    });
                } catch (_e) {
                    // file scritto a metà mentre lo leggevamo: salta questo giro
                }
            }
            en.close(null);
        } catch (e) {
            logError(e, '[Compass] _loadLiveSessions');
        }
        this._pruneSessionStates();
    }

    // Toglie gli stati per-sessione che non hanno più un processo vivo a
    // dichiararli. Servono due potature in una: la sessione chiusa manda `end` e
    // si toglie da sé, ma un `kill -9` no; e un `/clear` cambia il `sessionId`
    // DENTRO lo stesso processo, lasciando indietro una entry che nessun evento
    // futuro nominerà mai più.
    _pruneSessionStates() {
        const alive = new Set(this._liveSessions.map(s => s.sessionId).filter(Boolean));
        for (const id of [...this._sessionStates.keys()])
            if (!alive.has(id)) this._sessionStates.delete(id);
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
    _sessionsForProject(project) {
        const dir = this._expandDir(project.dir);
        if (!dir) return [];
        return this._liveSessions
            .filter(s => s.cwd === dir || s.cwd.startsWith(dir + '/'))
            .sort((a, b) => a.startedAt - b.startedAt);
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
    _sessionState(session) {
        const live = LIVE_STATUS_STATE[session.status] ?? 'idle';
        if (live !== 'idle') return live;
        const hook = this._sessionHookState(session);
        return HOOK_ONLY_STATE.has(hook) ? hook : 'idle';
    }

    // Stato semantico annunciato dagli hook per QUESTA sessione, keyed su
    // `sessionId` (`SetSessionState`). Un bridge vecchio chiama il solo `SetState`
    // keyed sul profilo → qui non arriva niente e la riga resta su quel che dice
    // il registro: degradazione, non guasto.
    _sessionHookState(session) {
        if (!session.sessionId) return null;
        return this._sessionStates.get(session.sessionId)?.state ?? null;
    }

    // Identificativo mostrato nella riga-sessione.
    //
    // Il `name` del registro è il titolo della tab (`🧵 loom-works · T119`): porta
    // già emoji di progetto e task attiva, cioè le due cose che servono. Sotto la
    // riga del progetto però emoji e nome sono ridondanti — restano solo se il
    // titolo non è quello atteso (sessione titolata a mano). Senza titolo affatto
    // (claude lanciato senza --name) resta il pid, che almeno è univoco.
    _sessionLabel(session, project) {
        const raw = (session.name ?? '').trim();
        if (raw) {
            const m = raw.match(titleKeyRe(project.name));
            if (!m) return raw;
            const rest = raw.slice(m[0].length).replace(/^[\s·:—-]+/, '').trim();
            if (rest) return rest;
        }
        return `pid ${session.pid}`;
    }

    // ── Window matching ──────────────────────────────────────────────────────

    _getPtyxisWindows() {
        return global.display.list_all_windows().filter(w => {
            const cls = w.get_wm_class() ?? '';
            return cls.toLowerCase().includes('ptyxis');
        });
    }

    // Assegna ogni finestra Ptyxis al progetto con la label più lunga che appare
    // nel titolo (longest-match). Evita che una label base (es. "myproj") rubi
    // le finestre di lane con label "myproj [lane]".
    _resolveWindowMap() {
        const wins = this._getPtyxisWindows();
        const map  = new Map(); // profileId → MetaWindow

        for (const win of wins) {
            const title = win.get_title() ?? '';
            let best = null, bestLen = 0;
            for (const p of this._registry) {
                if (title.includes(p.label) && p.label.length > bestLen) {
                    bestLen = p.label.length;
                    best    = p;
                }
            }
            // Prima finestra trovata per progetto vince; le successive ignorata
            if (best && !map.has(best.profile))
                map.set(best.profile, win);
        }
        return map;
    }

    _findWindowForProject(project) {
        // Usa la winMap cached da _buildMenu; fallback a risoluzione istantanea
        const map = this._winMap ?? this._resolveWindowMap();
        return map.get(project.profile) ?? null;
    }

    // Risoluzione finestra a livello PROGETTO (T34). Fix del sintomo "focus sulla
    // tab deck → il progetto appare faded/spento": le surface (claude, deck,
    // terminal) sono TAB, non finestre distinte — col coalescing vivono nella
    // STESSA finestra Ptyxis, il cui titolo = quello della tab ATTIVA. Ogni
    // surface titola con la PROPRIA emoji davanti allo stesso `name`:
    //    claude   → `🧵 loom-works · T52`
    //    deck     → `🎴 loom-works [deck]`
    //    terminal → `🖥️ loom-works [term]`
    // Matchare una sola di queste emoji sarebbe PER-SURFACE → col deck in focus
    // la chiave claude non scatta e il progetto risulta assente. Un insieme chiuso
    // di emoji note non basta neanche: una voce `launch[]` che spawna una tab porta
    // la PROPRIA emoji custom dal registry (`🔌 ud-code [ssh247]`), che nessuna
    // costante conosce. Il matcher accetta quindi QUALUNQUE emoji in testa
    // (`\p{Extended_Pictographic}`, più VS16/ZWJ/skin-tone per le sequenze), seguita
    // dal `name`. Ciò che segue (`· T52`, `[deck]`, `· fork`) non partecipa.
    //
    // L'emoji resta l'entropia contro i falsi positivi anche da generica, perché
    // l'ancora `^` la rende obbligatoria: `vim ud-code/foo.js` non inizia con
    // emoji+spazio → escluso. (Prima di T58 quell'entropia la portava l'`owner`,
    // che era il core comune ai titoli.)
    //
    // `(?![\w-])` dopo il nome, NON `\b`: `-` è un non-word char, quindi `\b`
    // matcherebbe dentro `🛒 ud-code-legacy` e assegnerebbe quella tab a `ud-code`.
    // Il lookahead nega anche il trattino → i nomi in relazione di prefisso non si
    // toccano più affatto, invece di dipendere dal solo tie-break sotto.
    //
    // Longest-match sul `name`, NON sul titolo matchato: la larghezza dell'emoji
    // varia e `🖥️` porta un VS16 (U+FE0F, code point invisibile in più) →
    // confrontare la lunghezza del match falserebbe la disambiguazione fra progetti
    // con nomi in relazione di prefisso (`trading-java` vs `trading-java-engine`).
    //
    // Ritorna Map(id → {win}), dove `win` = PRESENZA del progetto → guida fade,
    // focus del bottone-nome e coalescing delle tab.
    //
    // NON esiste più una presenza PER-SURFACE (c'era un campo `deck`, valorizzato solo
    // quando la tab ATTIVA era il deck): la presenza è una proprietà del PROGETTO, e
    // usarne una per-surface produceva il bug "faded + apre un deck nuovo mentre il
    // progetto è già aperto sulla tab claude". I bottoni-emoji sono always-launch →
    // non hanno bisogno di sapere quale surface sia visibile.
    _resolveLoomWindows() {
        const wins = this._getPtyxisWindows();
        const map  = new Map();
        for (const win of wins) {
            const title = win.get_title() ?? '';
            let best = null, bestLen = 0;
            for (const p of this._loomRegistry) {
                if (p.name.length <= bestLen) continue;
                if (!titleKeyRe(p.name).test(title)) continue;
                bestLen = p.name.length;
                best    = p;
            }
            if (!best) continue;
            if (!map.has(best.id)) map.set(best.id, {win: null});
            const e = map.get(best.id);
            if (!e.win) e.win = win;
        }
        return map;
    }

    // ── Menu ─────────────────────────────────────────────────────────────────

    _buildMenu() {
        this.menu.removeAll();
        this._winMap = this._resolveWindowMap(); // cache usata anche da _findWindowForProject

        // Il blocco legacy (projects.json) NON viene più renderizzato: le sue voci
        // duplicavano i cappelli loom. `_registry` resta caricato perché serve
        // ancora a risolvere finestre/sessioni per profilo (_resolveWindowMap,
        // hook D-Bus keyed su PTYXIS_PROFILE).

        // ── Registry loom (dconf) — unica sorgente del menu ───────────────────
        this._loomWins = this._resolveLoomWindows();
        for (const project of this._loomRegistry) this._addLoomProject(project);

        if (this._loomRegistry.length === 0) {
            const empty = new PopupMenu.PopupMenuItem('— registry vuoto —');
            empty.setSensitive(false);
            this.menu.addMenuItem(empty);
        }


        this._updateBadge();
    }

    // Voce progetto loom = UNA riga self-contained (merge vecchio+nuovo), non più
    // header di sotto-menu con figli esplosi. Layout:
    //
    //   [🟢]  [🧵 loom-works ─────────]  [🎴]   [▸]
    //   dot   claude (emoji+title, →)    deck   chevron (solo se launch custom)
    //
    //  - dot           = pallino presenza (proxy dello stato finché il rollup live
    //                    non esiste, Slice 3): finestra del progetto aperta → 🟢, else ⚪.
    //  - name btn      = emoji+nome → focus del progetto se aperto, altrimenti lancia
    //                    la surface default. L'UNICO focus-or-launch della riga.
    //  - deck btn      = emoji fissa 🎴 (solo se surface deck abilitata) → always-launch.
    //  - chevron+menu  = SOLO se ci sono launch custom; il sotto-menu contiene
    //                    unicamente le voci launch (codium/idea/…).
    //
    // Le surface tracked si aprono SENZA passare dal sotto-menu (bottoni inline).
    // Il fade (opacity 110, ripristino su hover) è di PROGETTO, non per-surface: sta
    // su dot e bottone-nome, e solo quando il progetto non ha nessuna finestra aperta.
    _addLoomProject(project) {
        const wins      = this._loomWins.get(project.id) ?? {win: null};
        const sessions  = this._sessionsForProject(project);
        const hasLaunch = project.launch.length > 0;

        if (hasLaunch) {
            // Con launch → PopupSubMenuMenuItem (ci dà il wiring lifecycle del
            // sotto-menu gratis), ma header ripulito + toggle spostato sul chevron.
            const item = new PopupMenu.PopupSubMenuMenuItem('');
            // Ripulisci i figli di default della PopupSubMenuMenuItem che
            // spostano/centrano il contenuto (verificato via probe struttura):
            //  - label      (x_expand)
            //  - _triangleBin (freccia)
            //  - popup-menu-item-expander (St.Bin x_expand): DUE figli x_expand
            //    (expander + la mia row) si spartiscono lo spazio → l'expander
            //    occupa metà a sinistra e spinge la row a destra = CENTRATO.
            // Lascia solo l'ornament (indent standard ~22px, come le voci vecchie).
            if (item.label)        item.remove_child(item.label);
            if (item._triangleBin) item.remove_child(item._triangleBin);
            for (const c of item.get_children()) {
                if ((c.style_class ?? '').includes('popup-menu-item-expander'))
                    item.remove_child(c);
            }
            item.activate = (_event) => {};                             // il click sulla riga NON toggla

            // NIENTE animazione slide sul sotto-menu: apri/chiudi istantaneo.
            // GNOME anima in PopupSubMenu.open/close(animate) con un ease sull'height
            // (250ms EASE_OUT_EXPO) quando `animate` è truthy; `toggle()` passa un
            // valore truthy → parte l'animazione. Sovrascrivo open/close sull'ISTANZA
            // forzando animate=false (ramo istantaneo). Robusto: non dipende dai rami
            // interni (JS di gnome-shell non leggibile, compilata nel binario), solo
            // dal contratto stabile "animate falsy → nessun ease". Scope = solo questo
            // sotto-menu launch, non tocca gli altri menu.
            const _open  = item.menu.open.bind(item.menu);
            const _close = item.menu.close.bind(item.menu);
            item.menu.open  = () => _open(false);
            item.menu.close = () => _close(false);

            const row = this._fillLoomHeader(item, project, wins, sessions);

            // chevron = bottone dedicato al toggle del sotto-menu launch. Va dentro
            // `row` (non nell'item) per stare sulla stessa riga, all'estrema destra
            // (il bottone claude x_expand lo spinge lì).
            const chevron = new St.Button({
                style_class: 'compass-chevron',
                child: new St.Icon({icon_name: 'pan-end-symbolic', style_class: 'popup-menu-arrow'}),
                can_focus: true, track_hover: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            chevron.connect('clicked', () => item.menu.toggle());
            item.menu.connect('open-state-changed', (_m, open) => {
                chevron.child.icon_name = open ? 'pan-down-symbolic' : 'pan-end-symbolic';
            });
            row.add_child(chevron);

            // voci launch (custom) → command @project-root, fire-once
            for (const launch of project.launch) {
                const label = launch.label || launch.command;
                const li    = new PopupMenu.PopupMenuItem(`${launch.emoji} ${label}`);
                li.connect('activate', () => { this._runLaunch(project, launch); this.menu.close(); });
                item.menu.addMenuItem(li);
            }

            this.menu.addMenuItem(item);
        } else {
            // Senza launch → NIENTE sotto-menu: riga inerte (highlight su hover) coi
            // soli bottoni inline. `activate:false` → il click sulla riga non attiva.
            const item = new PopupMenu.PopupBaseMenuItem({activate: false});
            this._fillLoomHeader(item, project, wins, sessions);
            this.menu.addMenuItem(item);
        }

        // Righe-sessione: una per sessione viva, subito sotto il cappello e nel
        // menu principale (non nel sotto-menu launch, che resta dietro il chevron
        // e chiede un click in più per una cosa che si guarda a colpo d'occhio).
        for (const s of this._cappedSessions(sessions))
            this.menu.addMenuItem(this._sessionRow(s, project));
    }

    // Applica il cap e, se taglia, sostituisce la coda con una sentinella che
    // dichiara quante ne restano fuori: una lista troncata in silenzio mente.
    _cappedSessions(sessions) {
        if (sessions.length <= SESSION_ROWS_MAX) return sessions;
        const head = sessions.slice(0, SESSION_ROWS_MAX);
        head.push({overflow: sessions.length - SESSION_ROWS_MAX});
        return head;
    }

    // Riga-sessione: glifo di stato + identificativo, indentata sotto il progetto.
    // INERTE per decisione (D2): il focus è già mestiere del bottone-nome del
    // cappello, e la mappatura sessione → tab Ptyxis non è ottenibile da nessuna
    // fonte disponibile — il registro non la porta e Ptyxis non espone targeting
    // per-finestra. Una riga che al click focussa la finestra duplicherebbe il
    // bottone-nome su N righe.
    _sessionRow(session, project) {
        const item = new PopupMenu.PopupBaseMenuItem({activate: false, reactive: false});
        const text = session.overflow
            ? `      +${session.overflow} altre`
            : `   ${STATE_EMOJI[this._sessionState(session)] ?? '⚪'}  ${this._sessionLabel(session, project)}`;
        item.add_child(new St.Label({
            text,
            style_class: 'compass-session-row',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        return item;
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
    _loomRollupState(project, sessions = []) {
        const states = new Set();
        for (const s of sessions) states.add(this._sessionState(s));
        for (const [kind, uuid] of Object.entries(project.bindings ?? {})) {
            if (kind === 'claude') continue;
            const st = this._sessions.get(uuid);
            if (st) states.add(st.state);
        }
        for (const s of ['error', 'ask', 'done', 'running'])
            if (states.has(s)) return s;
        return 'idle';
    }

    // Popola l'header di una voce loom coi child inline: dot presenza + bottone
    // claude (emoji+nome, espande) + bottone deck (emoji fissa, se abilitato).
    // I child NON vanno diretti nell'item: la PopupBaseMenuItem CENTRA il gruppo
    // (non rispetta l'x_expand dei bottoni). Vanno in un mio St.BoxLayout `row`
    // che riempie l'item (x_expand FILL) e impacchetta a sinistra di default →
    // contenuto ancorato a sinistra. Ritorna `row` così il caller può appendere
    // il chevron dentro la stessa riga.
    _fillLoomHeader(item, project, wins, sessions = []) {
        const row = new St.BoxLayout({
            style_class: 'compass-loom-row',
            x_expand: true, x_align: Clutter.ActorAlign.FILL,
            y_expand: true, y_align: Clutter.ActorAlign.FILL,
        });

        // dot — STATO via rollup delle surface tracked (ask>done>running>idle),
        // come le voci vecchie: STATE_EMOJI keyed su _sessions[bindingUUID]. Lo
        // stato arriva via D-Bus (hook claude → SetState su PTYXIS_PROFILE, che è
        // esattamente bindings.claude del cappello).
        //
        // FADE DI PRESENZA (stessa regola dei bottoni surface e del blocco vecchio):
        // il pallino segue lo stato aperto/chiuso del progetto. Nessuna finestra col
        // match nome (`wins.win == null`, cioè nessun titolo con una chiave dell'emoji-set)
        // → dot attenuato (opacity 110); finestra aperta → pieno (255). Ripristino su
        // hover della riga — `item.hover` è true anche col puntatore sopra i bottoni
        // figli (niente flicker). Lo STATO (emoji del rollup) NON cambia: varia solo
        // l'alpha, a segnalare "progetto non presente".
        const rollup = this._loomRollupState(project, sessions);
        const dot = new St.Label({
            text: STATE_EMOJI[rollup] ?? '⚪',
            style_class: 'compass-dot',
            y_align: Clutter.ActorAlign.CENTER,
        });
        dot.opacity = wins.win ? 255 : 110;
        if (!wins.win)
            item.connect('notify::hover', () => { dot.opacity = item.hover ? 255 : 110; });
        row.add_child(dot);

        // bottone-nome (emoji + nome) — apre la SURFACE DEFAULT del progetto, non
        // più claude hardcoded: la sceglie `defaultSurface` in .claude/loom-works.json
        // (vedi _resolveDefaultSurface). Il bottone NON deve espandersi: St.Button
        // (St.Bin) CENTRA la label interna se ha spazio extra (ignora x_align START)
        // → col bottone che avvolge la label, il testo resta ancorato a sinistra,
        // subito dopo il dot. Lo spazio verso i bottoni destri lo mangia uno spacer.
        const nameLabel = new St.Label({
            text: `${project.emoji} ${project.name}`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const nameBtn = new St.Button({
            style_class: 'compass-surface-btn',
            child: nameLabel,
            y_expand: true, y_align: Clutter.ActorAlign.FILL,
            can_focus: true, track_hover: true,
        });
        // FOCUS-OR-LAUNCH a livello PROGETTO, non per-surface. La presenza è
        // `wins.win` (match sull'emoji-set + `name` → intercetta la finestra
        // qualunque tab sia attiva): se il progetto ha una finestra aperta il click
        // la focussa, A PRESCINDERE da quale surface ci sia dentro. Solo se non c'è
        // NIENTE aperto il click lancia la surface default (e solo lì il bottone fada).
        //
        // Il bug che questo sostituisce: il bottone veniva wirato su `wins.deck`
        // quando defaultSurface=deck, ma `wins.deck` è valorizzata SOLO se la tab
        // ATTIVA è il deck → col claude in primo piano il progetto risultava assente
        // (faded) e il click apriva un deck NUOVO invece di focussare la finestra.
        // Stesso difetto in specchio sul ramo terminal: sempre launch, mai focus.
        const defKind = this._resolveDefaultSurface(project);
        this._wireSurfaceButton(nameBtn, project, defKind, wins.win);
        row.add_child(nameBtn);

        // spacer — St.Widget vuoto che espande e mangia lo spazio tra il nome e il
        // gruppo destro. NON è un bottone → non centra nulla, non intercetta click:
        // dot+nome restano a sinistra, 🤖/🎴/🖥️+chevron finiscono a destra.
        row.add_child(new St.Widget({x_expand: true}));

        // claude 🤖 — bottone solo-emoji. FORZA l'apertura di una nuova tab claude
        // ANCHE se claude è già aperto: dove il bottone-nome (se il default è claude)
        // focussa la finestra esistente, questo chiama SEMPRE _launchTracked → nuova
        // tab nella project-window (coalescing), o nuova finestra se nessuna. La
        // distinzione focus-or-launch / always-launch resta anche ora che l'icona è
        // identitaria (🤖) e non più un modificatore (➕). Mostrato solo dove claude
        // è abilitato E bound (serve un profilo UUID da lanciare).
        if (project.surfaces.includes('claude') && project.bindings?.claude) {
            const newClaudeBtn = new St.Button({
                style_class: 'compass-surface-btn',
                label: '🤖',
                can_focus: true, track_hover: true,
                y_expand: true, y_align: Clutter.ActorAlign.FILL,
            });
            newClaudeBtn.connect('clicked', () => {
                // Cattura il ts del click (evento valido), CHIUDI il menu (rilascia il
                // grab), poi _launchTracked che attiva projWin dopo la chiusura col ts
                // catturato → focus davvero consegnato a Ptyxis (vedi _launchTracked).
                const ts = global.get_current_time();
                this.menu.close();
                this._launchTracked(project, 'claude', ts);
            });
            row.add_child(newClaudeBtn);
        }

        // deck 🎴 — reso per OGNI progetto con la surface `deck` abilitata (non
        // gated sul profilo bound): T25 fatta, loom-deck è GLOBALE (npm
        // @lamemind/loom-deck, comando `loom-deck` nel PATH) → lanciabile ovunque.
        // ALWAYS-LAUNCH, come 🤖: il click apre sempre un deck NUOVO, mai focus di
        // uno esistente. Ne segue che non fada mai (il fade a 110 significava "non
        // presente, il click lancia" — distinzione che qui non esiste più: il click
        // lancia in ogni caso). Per il focus c'è il bottone-nome, che consegna la
        // finestra del progetto qualunque surface sia in primo piano.
        if (project.surfaces.includes('deck')) {
            const deckBtn = new St.Button({
                style_class: 'compass-surface-btn',
                label: SURFACE_EMOJI.deck,
                can_focus: true, track_hover: true,
                y_expand: true, y_align: Clutter.ActorAlign.FILL,
            });
            deckBtn.connect('clicked', () => {
                const ts = global.get_current_time();
                this.menu.close();
                this._launchTracked(project, 'deck', ts);
            });
            row.add_child(deckBtn);
        }

        // terminal — surface STANDARD LAUNCH: built-in e universale (ogni progetto
        // loom ce l'ha, senza dichiararla in `launch[]`), ma di natura launch —
        // fire-once, nessuno stato, nessun contributo al rollup del pallino.
        // Sempre presente e sempre piena opacità: non è una presenza da fotografare,
        // è un'azione ("apri un terminale qui"), quindi niente fade.
        const termBtn = new St.Button({
            style_class: 'compass-surface-btn',
            label: SURFACE_EMOJI.terminal,
            can_focus: true, track_hover: true,
            y_expand: true, y_align: Clutter.ActorAlign.FILL,
        });
        termBtn.connect('clicked', () => {
            const ts = global.get_current_time();
            this.menu.close();
            this._launchTracked(project, 'terminal', ts);
        });
        row.add_child(termBtn);

        item.add_child(row);
        return row;
    }

    // Surface aperta dal bottone-nome del cappello. Legge `defaultSurface` dal
    // registry (derivato da .claude/loom-works.json) e la RISOLVE contro lo stato
    // reale del progetto: il campo dichiara un'intenzione, non una garanzia.
    //
    // FALLBACK A `terminal` — il default in assenza di configurazione, e la rete di
    // sicurezza quando la surface richiesta non è lanciabile qui (disabilitata in
    // `surfaces`, o claude senza binding UUID). Motivo: `terminal` è l'unica surface
    // built-in universale, senza gate di enablement e senza binding → è l'unica che
    // non può a sua volta risolvere nel vuoto. Così il bottone-nome non è MAI inerte.
    //
    // La coerenza `defaultSurface` ↔ `surfaces` non è imposta a monte (cfg_validate
    // rifiuta solo i valori fuori enum): disabilitare una surface è un'operazione
    // legittima e non deve invalidare l'intera config del progetto. Qui degrada.
    _resolveDefaultSurface(project) {
        const want = project.defaultSurface;
        if (want === 'claude' && project.surfaces.includes('claude') && project.bindings?.claude)
            return 'claude';
        if (want === 'deck' && project.surfaces.includes('deck'))
            return 'deck'; // deck globale (T25): nessun binding richiesto
        return 'terminal';
    }

    // Aggancia l'azione FOCUS-OR-LAUNCH al bottone-nome del cappello:
    //  - `win` (finestra del PROGETTO, qualunque surface ci sia dentro) → click =
    //    focus, opacità piena.
    //  - nessuna finestra → click = lancia `kind`; fade a 110 + ripristino su hover,
    //    a segnalare "progetto non presente, il click lo apre".
    // `win` è la presenza del progetto, MAI quella della singola surface: focussare
    // ciò che è aperto vale anche quando la surface dentro non è `kind`. `kind` conta
    // solo nel ramo launch, ed è già risolto da _resolveDefaultSurface → garantito
    // lanciabile (abilitato, e bound se claude), `terminal` incluso.
    // Unico chiamante: il bottone-nome. I bottoni-emoji 🤖/🎴/🖥️ NON passano di qui:
    // sono always-launch.
    _wireSurfaceButton(btn, project, kind, win) {
        if (win) {
            btn.connect('clicked', () => { this._focusWindow(win); this.menu.close(); });
            return;
        }
        btn.opacity = 110;
        btn.connect('notify::hover', () => { btn.opacity = btn.hover ? 255 : 110; });
        btn.connect('clicked', () => {
            const ts = global.get_current_time();
            this.menu.close();
            this._launchTracked(project, kind, ts);
        });
    }

    // Apre una surface tracked (claude/deck) col profilo bound. Il custom-command
    // del profilo (`claude --name <label>` per claude, `node …/deck` per deck)
    // parte da sé → il titolo diventa matchabile e la finestra si aggancia al
    // progetto al giro di refresh dopo.
    //
    // COALESCING (Slice 2): tutte le surface di UNO stesso progetto devono finire
    // come tab nella STESSA finestra Ptyxis, non una finestra ciascuna. Ptyxis
    // (v50.1, verificato via `--help` + introspezione D-Bus) NON ha targeting
    // per-finestra: `--tab-with-profile` va SEMPRE nella finestra ATTIVA; le azioni
    // per-finestra su /org/gnome/Ptyxis/window/N espongono solo tab.read-only /
    // interface-style (niente new-tab). Unica via = focus-then-tab.
    //
    // ORDINE DELLE OPERAZIONI (il punto delicato, causa del bug "tab nella finestra
    // sbagliata"):
    //  - `_focusWindow(projWin)` va chiamato SINCRONO dal click handler: attivare
    //    una finestra richiede il timestamp di un evento input valido, altrimenti
    //    la focus-stealing-prevention di Mutter IGNORA l'activate. (Chiamarlo da un
    //    GLib.timeout — nessun evento input → activate silenziosamente bloccato.)
    //  - lo SPAWN della tab NON deve partire a delay fisso: il menu che si chiude
    //    rifocussa la finestra pre-menu (un altro progetto) e win.activate() è async
    //    → per un attimo la finestra attiva è ancora quella vecchia. Se spawni lì,
    //    la tab ci finisce dentro. Perciò lo spawn è EVENT-DRIVEN: parte solo quando
    //    projWin è la finestra col focus in modo STABILE (vedi _spawnTabWhenFocused).
    _launchTracked(project, kind, ts) {
        try {
            const uuid = project.bindings?.[kind];
            // deck (comando globale) e terminal (nessun comando: È la shell) si
            // lanciano senza profilo. claude: serve il binding.
            if (kind !== 'deck' && kind !== 'terminal' && !uuid) return;
            const home = GLib.get_home_dir();
            let dir = project.dir || home;
            if (dir.startsWith('~')) dir = home + dir.slice(1);

            const spawnTab = (newWindow) => {
                let argv;
                if (kind === 'deck') {
                    // deck GLOBALE (T25): niente profilo per-progetto col path locale.
                    // Lancio generico `loom-deck` (nel PATH) con cwd = project.dir e
                    // titolo matchabile `🎴 <name> [deck]` via OSC 0 (canale
                    // autoritativo, come deck-run). docs-root non-standard (es.
                    // loom-works=runtime) passata via env SOLO se nel registry
                    // (project.docsRoot ← file loom-works.json → reg_pull). `exec bash`
                    // tiene viva la tab all'uscita del deck (come il vecchio profilo).
                    const title = `${SURFACE_EMOJI.deck} ${project.name} [deck]`;
                    const envp  = project.docsRoot ? `LOOM_DECK_DOCS_ROOT=${project.docsRoot} ` : '';
                    const inner = `printf '\\033]0;%s\\007' "$1"; ${envp}loom-deck; exec bash`;
                    argv = newWindow
                        ? ['ptyxis', '--new-window', '-d', dir, '--', 'bash', '-lc', inner, 'bash', title]
                        : ['ptyxis', '--tab',        '-d', dir, '--', 'bash', '-lc', inner, 'bash', title];
                } else if (kind === 'terminal') {
                    // Nessun `-- CMD`: l'azione È aprire la shell, non eseguirci
                    // dentro un comando (differenza dalle launch custom, che invece
                    // spawnano `bash -ic <command>`).
                    //
                    // `-T <title>` = titolo di tab Ptyxis con la chiave `🖥️ <name>`,
                    // così la finestra continua a matchare il progetto anche mentre
                    // la tab attiva è il terminale (il match è window-level e legge
                    // il titolo della tab ATTIVA: una tab senza label farebbe
                    // sparire il progetto dal radar e spingerebbe il prossimo lancio
                    // claude in una finestra nuova invece che come tab qui).
                    // Se Ptyxis lasciasse vincere l'OSC 0 di `__vte_precmd`
                    // (/etc/profile.d/vte.sh riscrive il titolo a ogni prompt) si
                    // degrada al caso senza titolo: la surface resta funzionante.
                    const title = `${SURFACE_EMOJI.terminal} ${project.name} [term]`;
                    argv = newWindow
                        ? ['ptyxis', '--new-window', '-T', title, '-d', dir]
                        : ['ptyxis', '--tab',        '-T', title, '-d', dir];
                } else {
                    argv = newWindow
                        ? ['ptyxis', '--new-window', `--tab-with-profile=${uuid}`, '-d', dir]
                        : ['ptyxis', `--tab-with-profile=${uuid}`, '-d', dir];
                }
                try {
                    Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
                } catch (e) {
                    logError(e, '[Compass] _launchTracked spawn');
                }
            };

            // Finestra del progetto già aperta (una qualsiasi surface: match sul core
            // emoji-set + `name` → intercetta la finestra qualunque tab sia attiva).
            // Re-risolvo fresh al click per catturare lo stato reale nell'istante dell'azione.
            const projWin = this._resolveLoomWindows().get(project.id)?.win ?? null;
            if (!projWin) { spawnTab(true); return; } // nessuna finestra → creane la prima

            // CAUSA VERA (diagnosi utente + trace): projWin può stare su un ALTRO
            // desktop. L'activate innesca lo switch di workspace, che ha un'ANIMAZIONE.
            // Mutter aggiorna get_focus_window()→projWin SUBITO (modello interno), ma
            // il focus REALE arriva al client GTK/Ptyxis solo a FINE animazione. Se
            // spawni `--tab` prima, Ptyxis ha ancora la sua active-window vecchia
            // (altro progetto) → tab nella finestra sbagliata. `get_focus_window()` è
            // quindi un BUGIARDO durante l'animazione: NON è un segnale di "pronto".
            //
            // Fix: (1) attiva projWin dopo la chiusura menu, col ts del click (evento
            // valido → non bloccato da focus-stealing); (2) ASPETTA tempo REALE che
            // l'animazione + consegna focus finiscano; (3) POI spawna. Attesa tarata
            // sul costo reale: cambio desktop = animazione lunga; stesso desktop = breve.
            const clickTs  = ts ?? global.get_current_time();
            const activeWs = global.workspace_manager.get_active_workspace();
            const targetWs = projWin.get_workspace();
            const crossWs  = !!(targetWs && activeWs && targetWs !== activeWs);
            // Cambio desktop → animazione di switch workspace: aspetto tempo REALE che
            // finisca (e che il focus vero venga consegnato a Ptyxis) PRIMA di spawnare,
            // altrimenti `--tab` va nella finestra vecchia. Stesso desktop → niente
            // animazione, basta poco. 1.5s verificato sufficiente cross-desktop (3s era
            // solo margine di sicurezza in fase di diagnosi).
            const waitMs = crossWs ? 1500 : 400;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 70, () => {
                this._focusWindow(projWin, clickTs); // attiva → (eventuale) switch desktop + animazione
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, waitMs, () => {
                    // projWin ancora viva? Se è stata chiusa durante l'attesa, uno spawn
                    // `--tab` finirebbe in una finestra a caso → apri finestra nuova.
                    const alive = global.display.list_all_windows().includes(projWin);
                    spawnTab(!alive); // alive → tab (Ptyxis ora ha projWin attiva); morta → nuova
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {
            logError(e, '[Compass] _launchTracked');
        }
    }

    // Esegue il command di una surface launch con cwd = project root.
    // Shell INTERATTIVA (`bash -ic`): i command tipici (`codium .`, `idea .`) sono
    // alias/funzioni definiti in ~/.bashrc, che `bash -c` (non-interattivo) NON
    // sourcerebbe → il comando risulterebbe inesistente e fallirebbe muto. `-i`
    // sourca ~/.bashrc e abilita l'espansione alias. I warning job-control finiscono
    // su stderr (innocui). Fidato quanto un custom-command Ptyxis: il command viene
    // dal file committato.
    _runLaunch(project, launch) {
        try {
            const home = GLib.get_home_dir();
            let dir = project.dir || home;
            if (dir.startsWith('~')) dir = home + dir.slice(1);

            const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
            launcher.set_cwd(dir);
            launcher.spawnv(['bash', '-ic', launch.command]);
        } catch (e) {
            logError(e, '[Compass] _runLaunch');
        }
    }

    // ── Focus cross-desktop ──────────────────────────────────────────────────

    // `ts` opzionale: timestamp di un evento input valido. Serve quando l'activate
    // avviene FUORI dal contesto dell'evento (es. da un GLib.timeout, dopo la
    // chiusura del menu): Mutter blocca (focus-stealing-prevention) un activate con
    // timestamp corrente/0; passando il ts catturato al click l'activate è onorato.
    _focusWindow(win, ts) {
        const t = ts ?? global.get_current_time();
        const ws = win.get_workspace();
        if (ws) ws.activate(t);
        win.activate(t);
    }

    // ── Riapertura sessione chiusa ────────────────────────────────────────────

    _launchSession(project) {
        try {
            const home = GLib.get_home_dir();
            let dir = project.dir || home;
            if (dir.startsWith('~')) dir = home + dir.slice(1);

            // `--name = project.label`: il titolo finestra torna a combaciare con
            // project.label, così _findWindowForProject riaggancia la sessione.
            // Argv (no shell): nome passato come $1 a bash -c → niente quoting su emoji/spazi.
            const argv = [
                'ptyxis', '--new-window',
                `--tab-with-profile=${project.profile}`,
                '-d', dir,
                '--', 'bash', '-c', 'claude --name "$1"; exec bash', 'bash', project.label,
            ];
            Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
        } catch (e) {
            logError(e, '[Compass] _launchSession');
        }
    }

    // ── Badge ────────────────────────────────────────────────────────────────

    _markAllSeen() {
        for (const s of this._sessions.values()) s.seen = true;
    }

    _updateBadge() {
        let count = 0;
        for (const s of this._sessions.values()) {
            if (!s.seen && (s.state === 'ask' || s.state === 'done')) count++;
        }
        if (count > 0) {
            this._badge.text    = `${count}`;
            this._badge.visible = true;
        } else {
            this._badge.text    = '';
            this._badge.visible = false;
        }
    }

    // ── setState / setSessionState (chiamati dal servizio D-Bus) ─────────────

    // Canale per-sessione. `end` qui NON significa più «riporta a idle» come sul
    // canale vecchio: significa «togli questa sessione», perché la mappa è keyed
    // sulla conversazione e non sul profilo del terminale. Se restasse la
    // semantica vecchia, una sessione chiusa resterebbe elencata a idle finché
    // dura la sessione di GNOME.
    //
    // `profileId` può arrivare vuoto: una sessione lanciata fuori da Ptyxis non
    // ha un profilo da annunciare, ma ha comunque un `sessionId`. Lo stato
    // per-sessione entra lo stesso; salta solo il canale vecchio, che senza
    // profilo non ha una chiave.
    setSessionState(profileId, sessionId, state) {
        if (sessionId) {
            if (state === 'end') this._sessionStates.delete(sessionId);
            else                 this._sessionStates.set(sessionId, {state});
        }
        // Il canale vecchio resta alimentato: tiene il badge, il suono, la
        // notifica di `ask` e il rollup delle surface non-claude.
        if (profileId) { this.setState(profileId, state); return; }
        this._refreshMenu();
    }

    // Ricostruzione a seguito di un annuncio D-Bus: il registro dei processi va
    // riletto qui, non solo all'apertura del menu, o col menu tenuto aperto le
    // righe resterebbero ferme sull'istantanea del momento in cui è stato aperto.
    // Costa la lettura di una manciata di file piccoli.
    _refreshMenu() {
        this._loadLiveSessions();
        this._buildMenu();
    }

    setState(profileId, state) {
        const project = this._registry.find(p => p.profile === profileId);
        // Il profilo è "conosciuto" se è nel registry vecchio (projects.json) OPPURE
        // se è un binding di un cappello loom (dconf). Così lo stato via D-Bus popola
        // _sessions anche per i progetti loom-only (non più in projects.json) → il
        // loro pallino segue lo stato reale. _sessions resta keyed su profile UUID.
        // Il cappello loom si tiene come OGGETTO, non come bool: oltre a decidere se
        // il profilo è conosciuto serve a notificare (displayName) e a risolvere la
        // finestra col matcher nuovo — vedi _findNotificationWindow.
        const loomProject = this._loomRegistry.find(
            p => Object.values(p.bindings ?? {}).includes(profileId)
        );
        if (!project && !loomProject) return; // sconosciuto a entrambi → ignora

        const prev      = this._sessions.get(profileId) ?? {state: 'idle', seen: true};
        const prevState = prev.state;

        if (state === 'end') {
            // sessione terminata: ripristina idle silenzioso
            prev.state = 'idle';
            prev.seen  = true;
            this._sessions.set(profileId, prev);
            this._refreshMenu();
            return;
        }

        prev.state = state;
        // stato notevole → da vedere; altri stati → visti (es. running)
        prev.seen  = !(state === 'ask' || state === 'done');
        this._sessions.set(profileId, prev);

        // Suono + notifica (solo su transizione, non su ripetizione). Vale per
        // ENTRAMBI i registry: prima era ristretta a projects.json, quindi un
        // progetto loom-only (registrato in dconf, uscito dal file legacy) su `ask`
        // non riceveva né bell né notifica — restava il solo pallino nel menu, che
        // però lo vedi solo se il menu lo apri.
        if (project || loomProject) {
            if (state === 'done' && prevState !== 'done') {
                this._playSound('complete');
            } else if (state === 'ask' && prevState !== 'ask') {
                this._playSound('bell');
                this._showNotification(project, loomProject);
            }
        }

        this._refreshMenu();
    }

    // ── Audio ────────────────────────────────────────────────────────────────

    _playSound(eventId) {
        try {
            Gio.Subprocess.new(
                ['canberra-gtk-play', '-i', eventId],
                Gio.SubprocessFlags.NONE
            );
        } catch (_e) {
            try {
                Gio.Subprocess.new(
                    ['paplay', `/usr/share/sounds/freedesktop/stereo/${eventId}.oga`],
                    Gio.SubprocessFlags.NONE
                );
            } catch (_e2) {}
        }
    }

    // ── Notifiche ─────────────────────────────────────────────────────────────

    _getOrCreateSource() {
        if (this._notificationSource) return this._notificationSource;

        try {
            // GNOME 45+ object-init API
            this._notificationSource = new MessageTray.Source({
                title:    'Project Compass',
                iconName: 'utilities-terminal',
            });
        } catch (_e) {
            // Fallback GNOME 44 string API
            this._notificationSource = new MessageTray.Source(
                'Project Compass', 'utilities-terminal'
            );
        }

        this._notificationSource.connect('destroy', () => {
            this._notificationSource = null;
        });
        Main.messageTray.add(this._notificationSource);
        return this._notificationSource;
    }

    // Finestra da focussare al click su "Vai".
    //
    // Il matcher LEGACY (_resolveWindowMap, keyed sul campo `label` di projects.json)
    // non aggancia più niente: da T58 (titoli tab senza owner) il titolo di una tab è
    // `{emoji} {name}` — `🧵 loom-works · T74` — mentre projects.json porta ancora
    // l'owner dentro la label — `🧵 LOCAL loom-works`. `title.includes(label)` è quindi
    // sempre falso → win null → il bottone "Vai" restava INERTE, e in silenzio: il null
    // moriva dentro `if (win)`, nessun errore, nessun log.
    // Priorità perciò al matcher loom (insieme di chiavi per-surface); il legacy resta
    // come fallback per i progetti che vivono solo in projects.json.
    _findNotificationWindow(project, loomProject) {
        if (loomProject) {
            // Risoluzione FRESCA, non la cache `_loomWins` di _buildMenu: una notifica
            // resta nello shade finché non la chiudi, quindi fra la sua comparsa e il
            // click possono passare decine di minuti — nel frattempo la finestra può
            // essere stata chiusa, riaperta o rititolata.
            const win = this._resolveLoomWindows().get(loomProject.id)?.win;
            if (win) return win;
        }
        return project ? this._findWindowForProject(project) : null;
    }

    _showNotification(project, loomProject) {
        const source      = this._getOrCreateSource();
        const displayName = loomProject?.label ?? project.display ?? project.label;

        let notification;
        try {
            // GNOME 45+ object-init API
            notification = new MessageTray.Notification({
                source,
                title: displayName,
                body:  'chiede conferma',
            });
        } catch (_e) {
            // Fallback GNOME 44 string API
            notification = new MessageTray.Notification(source, displayName, 'chiede conferma');
        }

        try {
            notification.addAction('Vai', () => {
                // `ts` catturato QUI, non dentro _focusWindow: la chiusura del banner
                // può far arrivare l'activate fuori dal contesto dell'evento, e con un
                // timestamp corrente/0 la focus-stealing-prevention di Mutter lo scarta
                // (stesso vincolo del click sul bottone-nome, §Coalescing).
                const ts  = global.get_current_time();
                const win = this._findNotificationWindow(project, loomProject);
                // Log sul MISS: senza, un matcher che non aggancia più è indistinguibile
                // da un bottone che non fa niente — è esattamente così che il difetto
                // sopra è passato inosservato.
                if (!win) {
                    log(`[Compass] "Vai": nessuna finestra per ${displayName}`);
                    return;
                }
                this._focusWindow(win, ts);
            });
        } catch (_e) {}

        source.addNotification(notification);
    }

    // ── Cleanup ──────────────────────────────────────────────────────────────

    destroy() {
        if (this._notificationSource) {
            this._notificationSource.destroy();
            this._notificationSource = null;
        }
        super.destroy();
    }
});

// ── Impl entry point (istanziata dallo stub extension.js) ────────────────────

export class CompassImpl {

    enable(ext) {
        // Indicatore panel — `ext` = l'oggetto Extension (per ext.path, ecc.)
        this._indicator = new CompassIndicator(ext);
        Main.panel.addToStatusArea('project-compass', this._indicator);

        // Servizio D-Bus
        const service = new CompassService(this._indicator);
        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(DBUS_INTERFACE_XML, service);
        this._dbusImpl.export(Gio.DBus.session, '/org/lamemind/Compass');

        // Claim del nome sul bus di sessione
        this._ownNameId = Gio.bus_own_name(
            Gio.BusType.SESSION,
            'org.lamemind.Compass',
            Gio.BusNameOwnerFlags.NONE,
            null, null, null
        );
    }

    disable() {
        if (this._ownNameId) {
            Gio.bus_unown_name(this._ownNameId);
            this._ownNameId = null;
        }
        if (this._dbusImpl) {
            this._dbusImpl.unexport();
            this._dbusImpl = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
