// menu.js — compass@lamemind — I WIDGET
//
// Costruzione della voce di menu per progetto: riga-cappello (dot, bottone-nome,
// bottoni surface, chevron), righe-sessione, sotto-menu launch.
//
// Prende `self` — l'istanza di CompassIndicator — come PRIMO ARGOMENTO ESPLICITO,
// non come `this` implicito, e la ragione è la verificabilità: `grep -o
// 'self\._[a-z_]*' menu.js | sort -u` elenca esattamente i campi dell'indicatore
// su cui questo file poggia, e quella lista È il contratto. Con un mixin sul
// prototype la stessa domanda non avrebbe risposta meccanica, e una dipendenza
// all'indietro esisterebbe senza passare da un `import`.
//
// Non importa GLib né Gio: nessuna funzione di questo file li tocca. Costruire
// St.Button o PopupMenu.PopupBaseMenuItem è ISTANZIARE classi che lo shell ha già
// registrato, non registrarne di nuove → nessun contatto con GObject.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Token di cache-busting propagato ai fratelli: `import.meta.url` lo porta, un
// `import './x.js'` statico NO — il figlio resterebbe in cache per tutta la vita
// del processo gnome-shell, e `compass reload` ricaricherebbe un file su quattro
// producendo un grafo misto (impl nuovo + model vecchio) senza nessun errore.
const _Q = import.meta.url.includes('?') ? '?' + import.meta.url.split('?')[1] : '';
const Model   = await import('./model.js'   + _Q);
const Desktop = await import('./desktop.js' + _Q);

// ── Stato → emoji ────────────────────────────────────────────────────────────

// `running` e `ask` non sono pallini colorati come gli altri tre: dicono COSA
// sta succedendo, non un livello su una scala. Sono i due stati su cui si
// decide se andare in quella tab, e un glifo figurativo si becca in periferia
// dove un colore va confrontato con gli altri per essere letto.
//
// `⚙️` porta un VS16 (U+2699 U+FE0F): U+2699 da solo è text-default e
// renderebbe come carattere tipografico monocromo. Qui il selettore si può
// usare senza cautele — siamo in un St.Label sotto Pango, non in un terminale
// dove la larghezza dichiarata e quella disegnata possono discordare.
export const STATE_EMOJI = {
    running: '⚙️',
    ask:     '❓',
    done:    '✅',
    idle:    '⚪',
    error:   '🔴',
};

// Cap di righe-sessione per progetto: oltre, una riga di riepilogo `+N`. Serve
// perché il menu è una popup a lunghezza non limitata — dieci sessioni su un
// progetto spingerebbero fuori schermo i progetti sotto.
const SESSION_ROWS_MAX = 6;

// Stati per cui la riga porta l'età oltre al glifo (D1, T149): condividono lo
// stesso campo (`statusUpdatedAt` via `Model.sessionAges`) — includere
// `running` non costa una riga in più. `idle` resta nudo: lì la cifra
// direbbe solo da quanto non succede niente.
const AGED_STATES = new Set(['running', 'ask', 'done']);

// Glifo orologio unico e fisso per l'età (P4), non un set per stato. Porta un
// VS16 esplicito (U+1F550 U+FE0F) con la stessa cautela di `⚙️` sopra.
const CLOCK_EMOJI = '\u{1F550}️';

// Cap della label di riga (P3): le label osservate stanno fra 3 e 17
// caratteri (`T67`, `T149`, `T67-calm-elephant`) più il ripiego `pid <n>`;
// venti le tengono intere e restano rete per un titolo scritto a mano.
const LABEL_MAX = 20;

function truncateLabel(label) {
    if (label.length <= LABEL_MAX) return label;
    return label.slice(0, LABEL_MAX - 1) + '…';
}

// ── Etichetta di sessione ────────────────────────────────────────────────────

// Identificativo mostrato nella riga-sessione.
//
// Il `name` del registro è il titolo della tab (`🧵 loom-works · T119`): porta
// già emoji di progetto e task attiva, cioè le due cose che servono. Sotto la
// riga del progetto però emoji e nome sono ridondanti — restano solo se il
// titolo non è quello atteso (sessione titolata a mano). Senza titolo affatto
// (claude lanciato senza --name) resta il pid, che almeno è univoco.
export function sessionLabel(session, project) {
    const raw = (session.name ?? '').trim();
    let label = `pid ${session.pid}`;
    if (raw) {
        const m = raw.match(Desktop.titleKeyRe(project.name));
        if (!m) {
            label = raw;
        } else {
            const rest = raw.slice(m[0].length).replace(/^[\s·:—-]+/, '').trim();
            if (rest) label = rest;
        }
    }
    return truncateLabel(label);
}

// `età-stato/età-conversazione` (D2, schizzo utente): il primo numero decide
// se andare in quella tab adesso, il secondo dà solo il contesto della durata
// della conversazione.
function ageSuffix(session) {
    const {stateAgeMs, convoAgeMs} = Model.sessionAges(session, Date.now());
    return ` · ${CLOCK_EMOJI} ${Model.formatAge(stateAgeMs)}/${Model.formatAge(convoAgeMs)}`;
}

// ── Costruzione del menu ─────────────────────────────────────────────────────

// NON chiude più con `updateBadge()`: il badge è la coda del canale D-Bus, non un
// widget del popup, e resta nella classe. Farlo richiamare da qui sarebbe una
// freccia all'indietro senza import, cioè invisibile a grep. La chiamata è salita
// nei due orchestratori (`_init` e `_refreshMenu`), che chiamano buildMenu e poi
// `this._updateBadge()` — stesso ordine di prima, stessa doppia esecuzione
// all'apertura del menu (l'handler `open-state-changed` lo chiama già da sé).
export function buildMenu(self) {
    self.menu.removeAll();
    // cache usata anche da findNotificationWindow via self._winMap
    self._winMap = Desktop.resolveWindowMap(self._registry);

    // Il blocco legacy (projects.json) NON viene più renderizzato: le sue voci
    // duplicavano i cappelli loom. `_registry` resta caricato perché serve
    // ancora a risolvere finestre/sessioni per profilo (resolveWindowMap,
    // hook D-Bus keyed su PTYXIS_PROFILE).

    // ── Registry loom (dconf) — unica sorgente del menu ───────────────────
    self._loomWins = Desktop.resolveLoomWindows(self._loomRegistry);
    for (const project of self._loomRegistry) addLoomProject(self, project);

    if (self._loomRegistry.length === 0) {
        const empty = new PopupMenu.PopupMenuItem('— registry vuoto —');
        empty.setSensitive(false);
        self.menu.addMenuItem(empty);
    }
}

// Voce progetto loom = UNA riga self-contained (merge vecchio+nuovo), non più
// header di sotto-menu con figli esplosi. Layout:
//
//   [⚙️]  [🧵 loom-works ─────────]  [🎴]   [▸]
//   dot   claude (emoji+title, →)    deck   chevron (solo se launch custom)
//
//  - dot           = STATO del progetto, per rollup dei figli (loomRollupState).
//                    La presenza non è più il suo colore ma la sua OPACITÀ, vedi
//                    il fade più sotto: due assi distinti sullo stesso glifo.
//  - name btn      = emoji+nome → focus del progetto se aperto, altrimenti lancia
//                    la surface default. L'UNICO focus-or-launch della riga.
//  - deck btn      = emoji fissa 🎴 (solo se surface deck abilitata) → always-launch.
//  - chevron+menu  = SOLO se ci sono launch custom; il sotto-menu contiene
//                    unicamente le voci launch (codium/idea/…).
//
// Le surface tracked si aprono SENZA passare dal sotto-menu (bottoni inline).
// Il fade (opacity 110, ripristino su hover) è di PROGETTO, non per-surface: sta
// su dot e bottone-nome, e solo quando il progetto non ha nessuna finestra aperta.
export function addLoomProject(self, project) {
    const wins      = self._loomWins.get(project.id) ?? {win: null};
    const sessions  = Model.sessionsForProject(project, self._liveSessions);
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

        const row = fillLoomHeader(self, item, project, wins, sessions);

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
            li.connect('activate', () => { Desktop.runLaunch(project, launch); self.menu.close(); });
            item.menu.addMenuItem(li);
        }

        self.menu.addMenuItem(item);
    } else {
        // Senza launch → NIENTE sotto-menu: riga inerte (highlight su hover) coi
        // soli bottoni inline. `activate:false` → il click sulla riga non attiva.
        const item = new PopupMenu.PopupBaseMenuItem({activate: false});
        fillLoomHeader(self, item, project, wins, sessions);
        self.menu.addMenuItem(item);
    }

    // Righe-sessione: una per sessione viva, subito sotto il cappello e nel
    // menu principale (non nel sotto-menu launch, che resta dietro il chevron
    // e chiede un click in più per una cosa che si guarda a colpo d'occhio).
    for (const s of cappedSessions(sessions))
        self.menu.addMenuItem(sessionRow(s, project, self._channels));
}

// Applica il cap e, se taglia, sostituisce la coda con una sentinella che
// dichiara quante ne restano fuori: una lista troncata in silenzio mente.
export function cappedSessions(sessions) {
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
export function sessionRow(session, project, channels) {
    const item = new PopupMenu.PopupBaseMenuItem({activate: false, reactive: false});
    let text;
    if (session.overflow) {
        text = `      +${session.overflow} altre`;
    } else {
        const state = Model.sessionState(session, channels);
        const glyph = STATE_EMOJI[state] ?? '⚪';
        const age   = AGED_STATES.has(state) ? ageSuffix(session) : '';
        text = `   ${glyph}  ${sessionLabel(session, project)}${age}`;
    }
    item.add_child(new St.Label({
        text,
        style_class: 'compass-session-row',
        y_align: Clutter.ActorAlign.CENTER,
    }));
    return item;
}

// Popola l'header di una voce loom coi child inline: dot presenza + bottone
// claude (emoji+nome, espande) + bottone deck (emoji fissa, se abilitato).
// I child NON vanno diretti nell'item: la PopupBaseMenuItem CENTRA il gruppo
// (non rispetta l'x_expand dei bottoni). Vanno in un mio St.BoxLayout `row`
// che riempie l'item (x_expand FILL) e impacchetta a sinistra di default →
// contenuto ancorato a sinistra. Ritorna `row` così il caller può appendere
// il chevron dentro la stessa riga.
export function fillLoomHeader(self, item, project, wins, sessions = []) {
    const row = new St.BoxLayout({
        style_class: 'compass-loom-row',
        x_expand: true, x_align: Clutter.ActorAlign.FILL,
        y_expand: true, y_align: Clutter.ActorAlign.FILL,
    });

    // Risoluzione della finestra di progetto AL CLICK, non ora: passata come
    // lambda a launchTracked, che deve vedere lo stato reale nell'istante
    // dell'azione e non l'istantanea della costruzione del menu.
    const findProjectWindow = () =>
        Desktop.resolveLoomWindows(self._loomRegistry).get(project.id)?.win ?? null;

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
    const rollup = Model.loomRollupState(project, sessions, self._channels);
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
    // (vedi resolveDefaultSurface). Il bottone NON deve espandersi: St.Button
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
    const defKind = Desktop.resolveDefaultSurface(project);
    wireSurfaceButton(self, nameBtn, project, defKind, wins.win, findProjectWindow);
    row.add_child(nameBtn);

    // spacer — St.Widget vuoto che espande e mangia lo spazio tra il nome e il
    // gruppo destro. NON è un bottone → non centra nulla, non intercetta click:
    // dot+nome restano a sinistra, 🤖/🎴/🖥️+chevron finiscono a destra.
    row.add_child(new St.Widget({x_expand: true}));

    // claude 🤖 — bottone solo-emoji. FORZA l'apertura di una nuova tab claude
    // ANCHE se claude è già aperto: dove il bottone-nome (se il default è claude)
    // focussa la finestra esistente, questo chiama SEMPRE launchTracked → nuova
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
            // grab), poi launchTracked che attiva projWin dopo la chiusura col ts
            // catturato → focus davvero consegnato a Ptyxis (vedi launchTracked).
            const ts = global.get_current_time();
            self.menu.close();
            Desktop.launchTracked(project, 'claude', ts, findProjectWindow);
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
            label: Desktop.SURFACE_EMOJI.deck,
            can_focus: true, track_hover: true,
            y_expand: true, y_align: Clutter.ActorAlign.FILL,
        });
        deckBtn.connect('clicked', () => {
            const ts = global.get_current_time();
            self.menu.close();
            Desktop.launchTracked(project, 'deck', ts, findProjectWindow);
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
        label: Desktop.SURFACE_EMOJI.terminal,
        can_focus: true, track_hover: true,
        y_expand: true, y_align: Clutter.ActorAlign.FILL,
    });
    termBtn.connect('clicked', () => {
        const ts = global.get_current_time();
        self.menu.close();
        Desktop.launchTracked(project, 'terminal', ts, findProjectWindow);
    });
    row.add_child(termBtn);

    item.add_child(row);
    return row;
}

// Aggancia l'azione FOCUS-OR-LAUNCH al bottone-nome del cappello:
//  - `win` (finestra del PROGETTO, qualunque surface ci sia dentro) → click =
//    focus, opacità piena.
//  - nessuna finestra → click = lancia `kind`; fade a 110 + ripristino su hover,
//    a segnalare "progetto non presente, il click lo apre".
// `win` è la presenza del progetto, MAI quella della singola surface: focussare
// ciò che è aperto vale anche quando la surface dentro non è `kind`. `kind` conta
// solo nel ramo launch, ed è già risolto da resolveDefaultSurface → garantito
// lanciabile (abilitato, e bound se claude), `terminal` incluso.
// Unico chiamante: il bottone-nome. I bottoni-emoji 🤖/🎴/🖥️ NON passano di qui:
// sono always-launch.
export function wireSurfaceButton(self, btn, project, kind, win, findProjectWindow) {
    if (win) {
        btn.connect('clicked', () => { Desktop.focusWindow(win); self.menu.close(); });
        return;
    }
    btn.opacity = 110;
    btn.connect('notify::hover', () => { btn.opacity = btn.hover ? 255 : 110; });
    btn.connect('clicked', () => {
        const ts = global.get_current_time();
        self.menu.close();
        Desktop.launchTracked(project, kind, ts, findProjectWindow);
    });
}
