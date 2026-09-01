// desktop.js — compass@lamemind — LE FINESTRE E I PROCESSI
//
// Match titolo → progetto, focus cross-desktop, coalescing delle tab, spawn
// delle surface, suono. È l'unico file dell'estensione che sa che esiste un
// window manager, ed è per questo l'unico non portabile.
//
// Match e lancio stanno insieme perché sono i due pezzi della stessa colla:
// compass può fare focus-then-tab solo perché possiede già la mappa
// finestra→progetto e il focus. Parlano entrambi con lo stesso vicino —
// Mutter per le finestre, Ptyxis per le tab — e con nessuno degli altri moduli.
//
// Nessun import locale, nessun widget, nessuno stato d'istanza: i registri
// arrivano per argomento. `launchTracked` riceve una LAMBDA di risoluzione, non
// un registro: deve rileggere la finestra nell'istante del click, e un array
// passato dal chiamante sarebbe catturato alla costruzione del menu.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// ── Surface → emoji ──────────────────────────────────────────────────────────
//
// Emoji cablate delle due surface che spawnano una tab SENZA emoji di progetto:
// entrano nel titolo che spawniamo (`🎴 <name> [deck]`) e nei bottoni della riga.
// NON sono più una chiave del matcher — `titleKeyRe` accetta qualunque emoji →
// cambiarle qui non può rendere una tab invisibile.
// La surface `claude` non è qui: le sue tab portano l'emoji del PROGETTO, che
// arriva dal registry per-progetto (`p.emoji`), non da una costante.
export const SURFACE_EMOJI = {
    deck:     '🎴',
    terminal: '🖥️',
};

// ── Chiave di titolo → progetto ──────────────────────────────────────────────
//
// `<emoji> <name>` in testa al titolo, con emoji GENERICA: le tab di una voce
// `launch[]` portano l'emoji custom del registry, sconosciuta a qualunque
// costante. La classe copre anche le sequenze (VS16, ZWJ, skin-tone), che sono
// più code point pittografici concatenati.
// Perché `^` e perché `(?![\w-])`: commento di `resolveLoomWindows`.
// Cache: il matcher gira su ogni finestra × ogni progetto a ogni apertura menu,
// e la regex dipende dal solo `name`.
const EMOJI_HEAD = '[\\p{Extended_Pictographic}\\uFE0F\\u200D\\u{1F3FB}-\\u{1F3FF}]+';
const _titleKeyCache = new Map();
export function titleKeyRe(name) {
    let re = _titleKeyCache.get(name);
    if (!re) {
        const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        re = new RegExp(`^${EMOJI_HEAD} ${esc}(?![\\w-])`, 'u');
        _titleKeyCache.set(name, re);
    }
    return re;
}

// ── Window matching ──────────────────────────────────────────────────────────

export function getPtyxisWindows() {
    return global.display.list_all_windows().filter(w => {
        const cls = w.get_wm_class() ?? '';
        return cls.toLowerCase().includes('ptyxis');
    });
}

// Assegna ogni finestra Ptyxis al progetto con la label più lunga che appare
// nel titolo (longest-match). Evita che una label base (es. "myproj") rubi
// le finestre di lane con label "myproj [lane]".
export function resolveWindowMap(legacyRegistry, wins = getPtyxisWindows()) {
    const map = new Map(); // profileId → MetaWindow

    for (const win of wins) {
        const title = win.get_title() ?? '';
        let best = null, bestLen = 0;
        for (const p of legacyRegistry) {
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

// `winMap` = la cache costruita da buildMenu; `null` → risoluzione istantanea.
export function findWindowForProject(winMap, legacyRegistry, project) {
    const map = winMap ?? resolveWindowMap(legacyRegistry);
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
//
// `wins` ha un default invece di essere risolto dentro: col parametro esplicito
// il longest-match si collauda con finestre finte (`{get_title: () => '…'}`),
// senza compositore.
export function resolveLoomWindows(loomRegistry, wins = getPtyxisWindows()) {
    const map = new Map();
    for (const win of wins) {
        const title = win.get_title() ?? '';
        let best = null, bestLen = 0;
        for (const p of loomRegistry) {
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

// ── Surface di default ───────────────────────────────────────────────────────

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
export function resolveDefaultSurface(project) {
    const want = project.defaultSurface;
    if (want === 'claude' && project.surfaces.includes('claude') && project.bindings?.claude)
        return 'claude';
    if (want === 'deck' && project.surfaces.includes('deck'))
        return 'deck'; // deck globale (T25): nessun binding richiesto
    return 'terminal';
}

// ── Lancio delle surface tracked ─────────────────────────────────────────────

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
//  - `focusWindow(projWin)` va chiamato SINCRONO dal click handler: attivare
//    una finestra richiede il timestamp di un evento input valido, altrimenti
//    la focus-stealing-prevention di Mutter IGNORA l'activate. (Chiamarlo da un
//    GLib.timeout — nessun evento input → activate silenziosamente bloccato.)
//  - lo SPAWN della tab NON deve partire a delay fisso: il menu che si chiude
//    rifocussa la finestra pre-menu (un altro progetto) e win.activate() è async
//    → per un attimo la finestra attiva è ancora quella vecchia. Se spawni lì,
//    la tab ci finisce dentro. Perciò lo spawn aspetta tempo reale (waitMs).
//
// `findProjectWindow` è una LAMBDA a zero argomenti, non il registro: la
// finestra va riletta nell'istante del click per catturare lo stato reale
// dell'azione. Ricevere `loomRegistry` trasformerebbe il valore da letto-al-click
// a catturato-alla-costruzione-del-menu — invisibile oggi (registro e menu si
// riscrivono insieme), un bug il giorno in cui uno dei due si aggiorna da solo.
export function launchTracked(project, kind, ts, findProjectWindow) {
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
                logError(e, '[Compass] launchTracked spawn');
            }
        };

        // Finestra del progetto già aperta (una qualsiasi surface: match sul core
        // emoji-set + `name` → intercetta la finestra qualunque tab sia attiva).
        // Re-risolvo fresh al click per catturare lo stato reale nell'istante dell'azione.
        const projWin = findProjectWindow();
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
            focusWindow(projWin, clickTs); // attiva → (eventuale) switch desktop + animazione
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
        logError(e, '[Compass] launchTracked');
    }
}

// Esegue il command di una surface launch con cwd = project root.
// Shell INTERATTIVA (`bash -ic`): i command tipici (`codium .`, `idea .`) sono
// alias/funzioni definiti in ~/.bashrc, che `bash -c` (non-interattivo) NON
// sourcerebbe → il comando risulterebbe inesistente e fallirebbe muto. `-i`
// sourca ~/.bashrc e abilita l'espansione alias. I warning job-control finiscono
// su stderr (innocui). Fidato quanto un custom-command Ptyxis: il command viene
// dal file committato.
export function runLaunch(project, launch) {
    try {
        const home = GLib.get_home_dir();
        let dir = project.dir || home;
        if (dir.startsWith('~')) dir = home + dir.slice(1);

        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
        launcher.set_cwd(dir);
        launcher.spawnv(['bash', '-ic', launch.command]);
    } catch (e) {
        logError(e, '[Compass] runLaunch');
    }
}

// ── Focus cross-desktop ──────────────────────────────────────────────────────

// `ts` opzionale: timestamp di un evento input valido. Serve quando l'activate
// avviene FUORI dal contesto dell'evento (es. da un GLib.timeout, dopo la
// chiusura del menu): Mutter blocca (focus-stealing-prevention) un activate con
// timestamp corrente/0; passando il ts catturato al click l'activate è onorato.
export function focusWindow(win, ts) {
    const t = ts ?? global.get_current_time();
    const ws = win.get_workspace();
    if (ws) ws.activate(t);
    win.activate(t);
}

// ── Riapertura sessione chiusa ────────────────────────────────────────────────

// CODICE MORTO: nessun chiamante, e lavora sul modello legacy (`project.profile`,
// `project.label` di projects.json). Spostato verbatim — la sua rimozione è già
// in perimetro a T135, e allinearlo al modello loom mentre passa sarebbe scrivere
// comportamento nuovo dentro un refactor, su una funzione che nessuno esegue.
export function launchSession(project) {
    try {
        const home = GLib.get_home_dir();
        let dir = project.dir || home;
        if (dir.startsWith('~')) dir = home + dir.slice(1);

        // `--name = project.label`: il titolo finestra torna a combaciare con
        // project.label, così findWindowForProject riaggancia la sessione.
        // Argv (no shell): nome passato come $1 a bash -c → niente quoting su emoji/spazi.
        const argv = [
            'ptyxis', '--new-window',
            `--tab-with-profile=${project.profile}`,
            '-d', dir,
            '--', 'bash', '-c', 'claude --name "$1"; exec bash', 'bash', project.label,
        ];
        Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
    } catch (e) {
        logError(e, '[Compass] launchSession');
    }
}

// ── Audio ────────────────────────────────────────────────────────────────────

export function playSound(eventId) {
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

// ── Finestra da focussare al click su "Vai" ──────────────────────────────────
//
// Il matcher LEGACY (resolveWindowMap, keyed sul campo `label` di projects.json)
// non aggancia più niente: da T58 (titoli tab senza owner) il titolo di una tab è
// `{emoji} {name}` — `🧵 loom-works · T74` — mentre projects.json porta ancora
// l'owner dentro la label — `🧵 LOCAL loom-works`. `title.includes(label)` è quindi
// sempre falso → win null → il bottone "Vai" restava INERTE, e in silenzio: il null
// moriva dentro `if (win)`, nessun errore, nessun log.
// Priorità perciò al matcher loom (insieme di chiavi per-surface); il legacy resta
// come fallback per i progetti che vivono solo in projects.json.
export function findNotificationWindow(registries, project, loomProject) {
    if (loomProject) {
        // Risoluzione FRESCA, non la cache `_loomWins` di buildMenu: una notifica
        // resta nello shade finché non la chiudi, quindi fra la sua comparsa e il
        // click possono passare decine di minuti — nel frattempo la finestra può
        // essere stata chiusa, riaperta o rititolata.
        const win = resolveLoomWindows(registries.loomRegistry).get(loomProject.id)?.win;
        if (win) return win;
    }
    return project
        ? findWindowForProject(registries.winMap, registries.legacyRegistry, project)
        : null;
}
