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

// ── Implementazione servizio D-Bus ───────────────────────────────────────────

class CompassService {
    constructor(indicator) {
        this._indicator = indicator;
    }

    SetState(profileId, state) {
        this._indicator.setState(profileId, state);
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
        this._registry  = [];
        this._loomRegistry = []; // registry dconf loom (T34) — cappelli + surface
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
        this._buildMenu();

        // Apertura menu → segna tutto visto + ricostruisce
        this.menu.connect('open-state-changed', (menu, open) => {
            if (!open) return;
            this._markAllSeen();
            this._updateBadge();
            this._loadLoomRegistry(); // niente watch dconf (no typelib) → refresh su apertura
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
                    p.owner    = this._gvStr(kv.get('owner')) ?? '';
                    p.name     = this._gvStr(kv.get('name'))  ?? m[1];
                    p.dir      = this._gvStr(kv.get('dir'))   ?? '';
                    p.surfaces = kv.has('surfaces') ? this._gvStrv(kv.get('surfaces')) : [];
                    p.docsRoot = this._gvStr(kv.get('docsRoot')) ?? null;
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
                    owner:    p.owner,
                    name:     p.name,
                    dir:      p.dir,
                    surfaces: p.surfaces,
                    docsRoot: p.docsRoot, // sottocartella tasks.md (derivata dal file) → env deck
                    bindings: p.bindings, // {kind → uuid Ptyxis} per il launch tracked
                    label:    `${p.emoji} ${p.owner} ${p.name}`, // derivata, mai scritta
                    launch:   [...p.launch.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v),
                }))
                .sort((a, b) => a.id.localeCompare(b.id));
        } catch (e) {
            logError(e, '[Compass] _loadLoomRegistry');
        }
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
    // tab deck → il progetto appare faded/spento": le surface (claude, deck) sono
    // TAB, non finestre distinte — col coalescing vivono nella STESSA finestra
    // Ptyxis, il cui titolo = quello della tab ATTIVA. I titoli surface hanno
    // emoji/suffisso diversi ma condividono il core `${owner} ${name}`:
    //    claude → `🧵 LOCAL loom-works`
    //    deck   → `🎴 LOCAL loom-works [deck]`
    // Matchare sulla label piena (con emoji 🧵) o sul suffisso `[deck]` è
    // PER-SURFACE → quando è attiva la tab deck la label claude non matcha e il
    // progetto risulta assente. L'unico matcher che intercetta il progetto
    // QUALUNQUE tab sia in focus è il core emoji-agnostico `${owner} ${name}`
    // ("LOCAL loom-works"). Longest-match per disambiguare nomi che sono prefisso
    // l'uno dell'altro. Ritorna Map(id → {win, deck}):
    //  - `win`  = PRESENZA del progetto (core matcher) → guida fade/titolo + coalescing.
    //  - `deck` = la stessa finestra SOLO se la tab ATTIVA è il deck (suffisso
    //             `[deck]`). Serve al bottone 🎴 per scegliere focus (deck già
    //             visibile) vs launch (apri la tab deck). NON è la presenza del
    //             progetto — è il segnale d'azione della singola surface deck.
    _resolveLoomWindows() {
        const wins = this._getPtyxisWindows();
        const map  = new Map();
        for (const win of wins) {
            const title = win.get_title() ?? '';
            let best = null, bestLen = 0;
            for (const p of this._loomRegistry) {
                const key = `${p.owner} ${p.name}`;
                if (title.includes(key) && key.length > bestLen) {
                    bestLen = key.length;
                    best    = p;
                }
            }
            if (!best) continue;
            if (!map.has(best.id)) map.set(best.id, {win: null, deck: null});
            const e = map.get(best.id);
            if (!e.win) e.win = win;
            if (!e.deck && title.includes(`${best.owner} ${best.name} [deck]`))
                e.deck = win;
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
    //                    non esiste, Slice 3): finestra surface aperta → 🟢, else ⚪.
    //  - claude btn    = emoji+nome, x_expand (riempie la riga) → focus/apre claude.
    //  - deck btn      = emoji fissa 🎴 (solo se surface deck abilitata) → focus/apre deck.
    //  - chevron+menu  = SOLO se ci sono launch custom; il sotto-menu contiene
    //                    unicamente le voci launch (codium/idea/…).
    //
    // Le surface tracked si aprono SENZA passare dal sotto-menu (bottoni inline);
    // fade per-surface quando la finestra è chiusa (opacity, ripristino su hover).
    _addLoomProject(project) {
        const wins      = this._loomWins.get(project.id) ?? {win: null, deck: null};
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

            const row = this._fillLoomHeader(item, project, wins);

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
            this._fillLoomHeader(item, project, wins);
            this.menu.addMenuItem(item);
        }
    }

    // Rollup dello stato delle surface tracked di un cappello loom → un solo stato
    // per il pallino, esattamente come le voci vecchie derivano il loro emoji da
    // STATE_EMOJI[session.state]. Priorità (docs project-config-architecture):
    //   error > ask > done > running > idle
    // (error in testa: 🔴 è il più urgente; gli altri seguono il rollup congelato).
    // Sorgente = _sessions, keyed su profile UUID; le surface loom mappano via
    // `bindings` (bindings.claude / bindings.deck). Nessuno stato noto → idle.
    _loomRollupState(project) {
        let hasError = false, hasAsk = false, hasDone = false, hasRunning = false;
        for (const uuid of Object.values(project.bindings ?? {})) {
            const s = this._sessions.get(uuid);
            if (!s) continue;
            switch (s.state) {
                case 'error':   hasError   = true; break;
                case 'ask':     hasAsk     = true; break;
                case 'done':    hasDone    = true; break;
                case 'running': hasRunning = true; break;
            }
        }
        if (hasError)   return 'error';
        if (hasAsk)     return 'ask';
        if (hasDone)    return 'done';
        if (hasRunning) return 'running';
        return 'idle';
    }

    // Popola l'header di una voce loom coi child inline: dot presenza + bottone
    // claude (emoji+nome, espande) + bottone deck (emoji fissa, se abilitato).
    // I child NON vanno diretti nell'item: la PopupBaseMenuItem CENTRA il gruppo
    // (non rispetta l'x_expand dei bottoni). Vanno in un mio St.BoxLayout `row`
    // che riempie l'item (x_expand FILL) e impacchetta a sinistra di default →
    // contenuto ancorato a sinistra. Ritorna `row` così il caller può appendere
    // il chevron dentro la stessa riga.
    _fillLoomHeader(item, project, wins) {
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
        // match nome (`wins.win == null`, cioè nessun titolo col core `${owner} ${name}`)
        // → dot attenuato (opacity 110); finestra aperta → pieno (255). Ripristino su
        // hover della riga — `item.hover` è true anche col puntatore sopra i bottoni
        // figli (niente flicker). Lo STATO (emoji del rollup) NON cambia: varia solo
        // l'alpha, a segnalare "progetto non presente".
        const rollup = this._loomRollupState(project);
        const dot = new St.Label({
            text: STATE_EMOJI[rollup] ?? '⚪',
            style_class: 'compass-dot',
            y_align: Clutter.ActorAlign.CENTER,
        });
        dot.opacity = wins.win ? 255 : 110;
        if (!wins.win)
            item.connect('notify::hover', () => { dot.opacity = item.hover ? 255 : 110; });
        row.add_child(dot);

        // claude — emoji + nome. Il bottone NON deve espandersi: St.Button (St.Bin)
        // CENTRA la label interna se ha spazio extra (ignora x_align START) → col
        // bottone che avvolge la label, il testo resta ancorato a sinistra, subito
        // dopo il dot. Lo spazio verso deck/chevron lo mangia uno spacer (sotto).
        const claudeLabel = new St.Label({
            text: `${project.emoji} ${project.name}`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const claudeBtn = new St.Button({
            style_class: 'compass-surface-btn',
            child: claudeLabel,
            y_expand: true, y_align: Clutter.ActorAlign.FILL,
            can_focus: true, track_hover: true,
        });
        if (project.surfaces.includes('claude'))
            this._wireSurfaceButton(claudeBtn, project, 'claude', wins.win);
        else
            claudeBtn.reactive = false;
        row.add_child(claudeBtn);

        // "nuova istanza claude" — bottone solo-emoji (come il deck 🎴). FORZA
        // l'apertura di una nuova tab claude ANCHE se claude è già aperto: il
        // bottone-nome qui sopra focussa la finestra esistente (focus-or-open),
        // questo invece chiama SEMPRE _launchTracked → nuova tab nella project-window
        // (coalescing), o nuova finestra se nessuna. Mostrato solo dove claude è
        // abilitato E bound (serve un profilo UUID da lanciare).
        if (project.surfaces.includes('claude') && project.bindings?.claude) {
            const newClaudeBtn = new St.Button({
                style_class: 'compass-surface-btn',
                label: '➕',
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

        // spacer — St.Widget vuoto che espande e mangia lo spazio tra il nome e
        // deck/chevron. NON è un bottone → non centra nulla, non intercetta click:
        // dot+nome restano a sinistra, deck+chevron finiscono a destra.
        row.add_child(new St.Widget({x_expand: true}));

        // deck — emoji fissa 🎴. Reso per OGNI progetto con la surface `deck`
        // abilitata (non più gated sul profilo bound). Motivo: T25 fatta — loom-deck
        // è ora GLOBALE (npm @lamemind/loom-deck, comando `loom-deck` nel PATH) →
        // lanciabile in qualunque progetto, non solo dove esisteva un profilo Ptyxis
        // col path locale. Click: finestra deck aperta → focus; altrimenti launch
        // generico con cwd = project.dir (vedi _launchTracked). Claude invece porta
        // anche emoji+nome (titolo del progetto).
        if (project.surfaces.includes('deck')) {
            const deckBtn = new St.Button({
                style_class: 'compass-surface-btn',
                label: '🎴',
                can_focus: true, track_hover: true,
                y_expand: true, y_align: Clutter.ActorAlign.FILL,
            });
            // deck-specific (wins.deck), NON wins.win: se il deck non è la tab
            // visibile, il bottone deve LANCIARLO (coalesce nella project-window),
            // non limitarsi a focussare claude.
            this._wireSurfaceButton(deckBtn, project, 'deck', wins.deck);
            row.add_child(deckBtn);
        }

        // terminal — surface STANDARD LAUNCH: built-in e universale (ogni progetto
        // loom ce l'ha, senza dichiararla in `launch[]`), ma di natura launch —
        // fire-once, nessuno stato, nessun contributo al rollup del pallino.
        // Sempre presente e sempre piena opacità: non è una presenza da fotografare,
        // è un'azione ("apri un terminale qui"), quindi niente fade.
        const termBtn = new St.Button({
            style_class: 'compass-surface-btn',
            label: '🖥️',
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

    // Aggancia l'azione a un bottone surface tracked (claude/deck):
    //  - finestra aperta              → click = focus.
    //  - deck (globale) o claude bound → click = apre (launchTracked); fade + hover.
    //  - claude senza binding          → inerte.
    // deck non richiede binding: è globale (comando `loom-deck` nel PATH, T25) →
    // lanciabile in qualunque progetto con cwd = project.dir (vedi _launchTracked).
    _wireSurfaceButton(btn, project, kind, win) {
        if (win) {
            btn.connect('clicked', () => { this._focusWindow(win); this.menu.close(); });
        } else if (kind === 'deck' || (project.bindings && project.bindings[kind])) {
            btn.opacity = 110;
            btn.connect('notify::hover', () => { btn.opacity = btn.hover ? 255 : 110; });
            btn.connect('clicked', () => {
                const ts = global.get_current_time();
                this.menu.close();
                this._launchTracked(project, kind, ts);
            });
        } else {
            btn.reactive = false;
            btn.opacity  = 90;
        }
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
                    // titolo matchabile `<owner> <name> [deck]` via OSC 0 (canale
                    // autoritativo, come deck-run). docs-root non-standard (es.
                    // loom-works=runtime) passata via env SOLO se nel registry
                    // (project.docsRoot ← file loom-works.json → reg_pull). `exec bash`
                    // tiene viva la tab all'uscita del deck (come il vecchio profilo).
                    const title = `🎴 ${project.owner} ${project.name} [deck]`;
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
                    // `-T <title>` = titolo di tab Ptyxis col core `<owner> <name>`,
                    // così la finestra continua a matchare il progetto anche mentre
                    // la tab attiva è il terminale (il match è window-level e legge
                    // il titolo della tab ATTIVA: una tab senza label farebbe
                    // sparire il progetto dal radar e spingerebbe il prossimo lancio
                    // claude in una finestra nuova invece che come tab qui).
                    // Se Ptyxis lasciasse vincere l'OSC 0 di `__vte_precmd`
                    // (/etc/profile.d/vte.sh riscrive il titolo a ogni prompt) si
                    // degrada al caso senza titolo: la surface resta funzionante.
                    const title = `🖥️ ${project.owner} ${project.name} [term]`;
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
            // `${owner} ${name}` → intercetta la finestra qualunque tab sia attiva).
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

    // ── setState (chiamato dal servizio D-Bus) ───────────────────────────────

    setState(profileId, state) {
        const project = this._registry.find(p => p.profile === profileId);
        // Il profilo è "conosciuto" se è nel registry vecchio (projects.json) OPPURE
        // se è un binding di un cappello loom (dconf). Così lo stato via D-Bus popola
        // _sessions anche per i progetti loom-only (non più in projects.json) → il
        // loro pallino segue lo stato reale. _sessions resta keyed su profile UUID.
        const isLoomBinding = this._loomRegistry.some(
            p => Object.values(p.bindings ?? {}).includes(profileId)
        );
        if (!project && !isLoomBinding) return; // sconosciuto a entrambi → ignora

        const prev      = this._sessions.get(profileId) ?? {state: 'idle', seen: true};
        const prevState = prev.state;

        if (state === 'end') {
            // sessione terminata: ripristina idle silenzioso
            prev.state = 'idle';
            prev.seen  = true;
            this._sessions.set(profileId, prev);
            this._buildMenu();
            return;
        }

        prev.state = state;
        // stato notevole → da vedere; altri stati → visti (es. running)
        prev.seen  = !(state === 'ask' || state === 'done');
        this._sessions.set(profileId, prev);

        // Suono + notifica (solo su transizione, non su ripetizione). Ristretto al
        // registry vecchio: il path notifica usa project.display/profile (shape
        // projects.json). I cappelli loom aggiornano comunque il pallino via il
        // _buildMenu qui sotto (rollup da _sessions).
        if (project) {
            if (state === 'done' && prevState !== 'done') {
                this._playSound('complete');
            } else if (state === 'ask' && prevState !== 'ask') {
                this._playSound('bell');
                this._showNotification(project);
            }
        }

        this._buildMenu();
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

    _showNotification(project) {
        const source      = this._getOrCreateSource();
        const displayName = project.display ?? project.label;

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
                const win = this._findWindowForProject(project);
                if (win) this._focusWindow(win);
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
