// desktop.js — compass@lamemind — LE FINESTRE E I PROCESSI
//
// Match titolo → progetto, focus cross-desktop, salto alla tab di una
// conversazione, coalescing delle tab, spawn delle surface, suono. È l'unico
// file dell'estensione che sa che esiste un window manager, ed è per questo
// l'unico non portabile.
//
// Match e lancio stanno insieme perché sono i due pezzi della stessa colla:
// compass può fare focus-then-tab solo perché possiede già la mappa
// finestra→progetto e il focus. Parlano entrambi con lo stesso vicino —
// Mutter per le finestre, Ptyxis per le tab — e con nessuno degli altri moduli.
//
// Nessun import locale, nessun widget, nessuno stato d'istanza: i registri
// arrivano per argomento. `launchTracked` riceve una LAMBDA di risoluzione, non
// un registro: deve rileggere la finestra nell'istante del click, e un array
// passato dal chiamante sarebbe catturato alla costruzione del menu. Per la
// stessa ragione riceve in lambda anche il titolo della tab claude (T182).

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

// ── La tab di una conversazione ──────────────────────────────────────────────
//
// Trascritto da coda@lamemind (progetto factory), dove è collaudato nella
// sessione reale. La mappatura conversazione → tab passa dal titolo della tab,
// che è il `--name` passato a `claude`; il cambio di tab passa da AT-SPI, nel
// processo a sé `ptyxis-tab.js` (contratto e misure nella sua testata).

// L'helper si LANCIA, non si importa: è un processo `gjs -m` a sé. Il path si
// risolve da `import.meta.url` senza la query di cache-busting, che in un path
// di file non vuol dire niente.
const TAB_HELPER = GLib.build_filenamev([
    GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url.split('?')[0])[0]),
    'ptyxis-tab.js',
]);
const TAB_HELPER_TIMEOUT_S = 3;
const TAB_OUTCOMES = ['esatta', 'tab', 'ambigua', 'assente', 'fallita'];
const TITLE_RETRY_MS    = 50;
const TITLE_RETRY_TIMES = 10;

// Porta davanti la tab della conversazione nella sua finestra, senza toccare
// il focus. L'helper è un processo a sé perché le chiamate di accessibilità
// sono D-Bus sincrone e qui fermerebbero il compositore; un helper che non
// risponde in `TAB_HELPER_TIMEOUT_S` si uccide.
//
// → Promise di {outcome, title}: `outcome` è un esito dell'helper oppure
// `errore`; `title` è il titolo della finestra da portare davanti, o null.
// `extraStep` è l'opzione di collaudo dell'oracolo (`--salto-in-piu`).
//
// Senza nomi l'helper non parte: uscirebbe 2 (uso) e l'esito sarebbe `errore`,
// cioè «l'helper non ha risposto» per una conversazione che non ha un titolo da
// cercare. Nessuna tab porta un nome vuoto: è `assente`.
export function switchPtyxisTab(names, {extraStep = false} = {}) {
    if (names.length === 0) return Promise.resolve({outcome: 'assente', title: null});
    return new Promise(resolve => {
        const argv = ['gjs', '-m', TAB_HELPER, ...(extraStep ? ['--salto-in-piu'] : []), ...names];
        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            logError(e, '[Compass] helper tab: avvio');
            resolve({outcome: 'errore', title: null});
            return;
        }
        let timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TAB_HELPER_TIMEOUT_S, () => {
            timeoutId = 0;
            proc.force_exit();
            return GLib.SOURCE_REMOVE;
        });
        proc.communicate_utf8_async(null, null, (p, res) => {
            if (timeoutId) GLib.source_remove(timeoutId);
            try {
                const [, stdout, stderr] = p.communicate_utf8_finish(res);
                const [outcome, title] = (stdout ?? '').split('\n').map(l => l.trim());
                if (p.get_successful() && TAB_OUTCOMES.includes(outcome)) {
                    resolve({outcome, title: title || null});
                    return;
                }
                // stderr porta sempre gli avvisi di libatspi sul socket: conta
                // l'ultima riga, quella dell'helper.
                const status = p.get_if_exited() ? `exit ${p.get_exit_status()}` : 'ucciso';
                const last = (stderr ?? '').trim().split('\n').pop();
                log(`[Compass] helper tab: ${status} stdout=«${(stdout ?? '').trim()}» ${last}`);
            } catch (e) {
                logError(e, '[Compass] helper tab');
            }
            resolve({outcome: 'errore', title: null});
        });
    });
}

// La finestra Ptyxis col titolo dato. Dopo un cambio di tab il titolo nuovo
// arriva a Mutter dal client Wayland, e può arrivare dopo l'uscita
// dell'helper: si riprova per mezzo secondo prima di dire che non c'è.
export async function windowWithTitle(title) {
    for (let i = 0; i <= TITLE_RETRY_TIMES; i++) {
        const win = getPtyxisWindows().find(w => (w.get_title() ?? '').trim() === title);
        if (win) return win;
        await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, TITLE_RETRY_MS, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        }));
    }
    return null;
}

// La finestra più vicina alla conversazione, in due passi. È il ripiego di
// quando l'helper non dice quale finestra tiene la tab.
//
//  1. Una finestra il cui titolo È uno dei nomi della conversazione: il titolo
//     di Ptyxis segue la tab attiva, quindi quella finestra ha la conversazione
//     già davanti. `names` porta il nome effettivo del registro e quello
//     chiesto con `--name` (`Model.procRequestedName`), perché il CLI rinomina
//     una sessione in collisione ma il titolo della tab resta quello chiesto.
//  2. Altrimenti la finestra del progetto, la stessa del bottone-nome: la
//     conversazione è una tab là dentro, ma non quella davanti.
//
// `null` quando non c'è né l'una né l'altra (worktree lane, claude lanciato
// fuori da Ptyxis, progetto ignoto).
export function windowForSession(names, project, loomRegistry) {
    const wins  = getPtyxisWindows();
    const exact = wins.find(w => names.includes((w.get_title() ?? '').trim()));
    if (exact) return exact;
    if (!project) return null;
    return resolveLoomWindows(loomRegistry, wins).get(project.id)?.win ?? null;
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
        const best = projectForTitle(win.get_title() ?? '', loomRegistry);
        if (!best) continue;
        if (!map.has(best.id)) map.set(best.id, {win: null});
        const e = map.get(best.id);
        if (!e.win) e.win = win;
    }
    return map;
}

// Il longest-match titolo → progetto, da solo: prende UN titolo e ritorna il
// cappello che lo rivendica, o `null`.
//
// Estratto dal ciclo di `resolveLoomWindows`, che lo riusa — non una seconda
// copia della regola. Serve estratto perché la risoluzione della conversazione
// in focus (T159) parte da UNA finestra, non da tutte: passare per la mappa
// completa vorrebbe dire costruirla e poi cercarci dentro la finestra che si
// aveva già in mano, e la mappa tiene solo la PRIMA finestra per progetto —
// quella in focus potrebbe non esserci affatto.
//
// Puro e collaudabile con un titolo finto e un registro finto, senza
// compositore. Le tre cautele del match (ancora `^`, emoji generica, lookahead
// `(?![\w-])`, longest-match sul `name` e non sul titolo) stanno nel commento di
// `resolveLoomWindows` sopra e valgono identiche qui: è lo stesso codice.
export function projectForTitle(title, loomRegistry) {
    let best = null, bestLen = 0;
    for (const p of loomRegistry) {
        if (p.name.length <= bestLen) continue;
        if (!titleKeyRe(p.name).test(title)) continue;
        bestLen = p.name.length;
        best    = p;
    }
    return best;
}

// ── Surface di default ───────────────────────────────────────────────────────

// Surface aperta dal bottone-nome del cappello. Legge `defaultSurface` dal
// registry (derivato da .claude/loom-works.json) e la RISOLVE contro lo stato
// reale del progetto: il campo dichiara un'intenzione, non una garanzia.
//
// FALLBACK A `terminal` — il default in assenza di configurazione, e la rete di
// sicurezza quando la surface richiesta non è lanciabile qui (disabilitata in
// `surfaces`). Motivo: `terminal` è l'unica surface built-in universale, senza
// gate di enablement → è l'unica che non può a sua volta risolvere nel vuoto.
// Così il bottone-nome non è MAI inerte.
//
// La coerenza `defaultSurface` ↔ `surfaces` non è imposta a monte (cfg_validate
// rifiuta solo i valori fuori enum): disabilitare una surface è un'operazione
// legittima e non deve invalidare l'intera config del progetto. Qui degrada.
export function resolveDefaultSurface(project) {
    const want = project.defaultSurface;
    if (want === 'claude' && project.surfaces.includes('claude'))
        return 'claude';
    if (want === 'deck' && project.surfaces.includes('deck'))
        return 'deck'; // deck globale (T25): nessun binding richiesto
    return 'terminal';
}

// ── Lancio delle surface tracked ─────────────────────────────────────────────

// Apre una surface tracked (claude/deck) o la shell del progetto, sempre senza
// profilo Ptyxis: la tab nasce dal profilo di default e il comando lo porta
// l'argv. Il titolo è matchabile da subito (`-T`), quindi la finestra si
// aggancia al progetto al giro di refresh dopo.
//
// COALESCING (Slice 2): tutte le surface di UNO stesso progetto devono finire
// come tab nella STESSA finestra Ptyxis, non una finestra ciascuna. Ptyxis
// (v50.1, verificato via `--help` + introspezione D-Bus) NON ha targeting
// per-finestra: `--tab` va SEMPRE nella finestra ATTIVA; le azioni
// per-finestra su /org/gnome/Ptyxis/window/N espongono solo tab.read-only /
// interface-style (niente new-tab). Unica via = focus-then-tab.
//
// Qui c'è solo la composizione dell'argv per `kind`; l'orchestrazione
// focus-then-tab, che è la parte delicata, sta in `coalesceTab` — condivisa con
// la ripresa di una conversazione, che ha lo stesso identico bisogno.
//
// `claudeTitle` (T182) è la lambda che dà il titolo della tab claude: la label
// del progetto, più il carattere del gemello se una conversazione viva ha già
// chiesto quel nome. Il ramo `claude` la valuta dentro `spawnTab`, cioè
// all'ultimo istante prima dello spawn e dopo l'eventuale attesa di
// `coalesceTab`: un titolo calcolato al click sarebbe più vecchio dell'attesa,
// e una conversazione nata nel frattempo resterebbe invisibile. Gli altri rami
// la ignorano; assente, o in errore, il titolo è la label.
export function launchTracked(project, kind, ts, findProjectWindow, claudeTitle = null) {
    try {
        const dir = projectDir(project);

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
                // claude: stessa forma di `deck-run` (`ptyxis --tab -d -T --
                // bash -lc`). Il profilo dedicato portava due cose, e qui si
                // ricompongono entrambe nel comando:
                //  - il TITOLO `<emoji> <name>`: `-T` vale per l'istante prima
                //    che claude parta, poi lo tiene `claude --name`, che è il
                //    canale autoritativo e lo riscrive a ogni turno;
                //  - la CHIAVE DI STATO, `PTYXIS_PROFILE=<id del progetto>`
                //    davanti a claude: è ciò che `Model.projectByStateKey`
                //    risolve, e il nome della variabile è solo storico. Ptyxis
                //    esporta da sé PTYXIS_PROFILE in ogni tab, ma col valore del
                //    profilo di default: senza il prefisso la sessione
                //    annuncerebbe una chiave che nessun progetto dichiara, e il
                //    badge resterebbe fermo senza errori.
                // Titolo e chiave entrano come `$1`/`$2` di `bash -lc`, non
                // interpolati nella riga: arrivano dal registry, e un valore
                // passato come argomento non ha quoting da sbagliare.
                // `exec bash` tiene viva la tab all'uscita di claude, come il
                // custom-command del vecchio profilo.
                let title = project.label;
                try {
                    if (claudeTitle) title = claudeTitle() || project.label;
                } catch (e) {
                    logError(e, '[Compass] launchTracked claudeTitle');
                }
                const inner = 'PTYXIS_PROFILE="$2" claude --name "$1"; exec bash';
                argv = newWindow
                    ? ['ptyxis', '--new-window', '-d', dir, '-T', title, '--', 'bash', '-lc', inner, 'bash', title, project.id]
                    : ['ptyxis', '--tab',        '-d', dir, '-T', title, '--', 'bash', '-lc', inner, 'bash', title, project.id];
            }
            try {
                Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
            } catch (e) {
                logError(e, '[Compass] launchTracked spawn');
            }
        };

        coalesceTab(project, ts, findProjectWindow, spawnTab);
    } catch (e) {
        logError(e, '[Compass] launchTracked');
    }
}

// Project root in forma assoluta: il registry può portarla in forma tilde,
// mentre chi spawna un processo ha bisogno di un path vero.
function projectDir(project) {
    const home = GLib.get_home_dir();
    const dir = project.dir || home;
    return dir.startsWith('~') ? home + dir.slice(1) : dir;
}

/**
 * Il COALESCING: porta la tab dentro la finestra del progetto, qualunque cosa
 * la tab contenga.
 *
 * `spawnTab(newWindow)` è il solo pezzo che cambia fra un chiamante e l'altro —
 * una surface tracked, una conversazione ripresa — mentre l'orchestrazione è
 * identica e delicata, quindi sta scritta una volta. Un secondo chiamante che
 * la ricopiasse la ricopierebbe senza le attese, che sono la parte che non si
 * deduce.
 *
 * ORDINE DELLE OPERAZIONI (il punto delicato, causa del bug "tab nella finestra
 * sbagliata"):
 *  - `focusWindow(projWin)` va chiamato col timestamp di un evento input
 *    valido, altrimenti la focus-stealing-prevention di Mutter IGNORA
 *    l'activate. (Chiamarlo da un GLib.timeout senza `ts` — nessun evento
 *    input → activate silenziosamente bloccato.)
 *  - lo SPAWN della tab NON deve partire a delay fisso: il menu che si chiude
 *    rifocussa la finestra pre-menu (un altro progetto) e win.activate() è async
 *    → per un attimo la finestra attiva è ancora quella vecchia. Se spawni lì,
 *    la tab ci finisce dentro. Perciò lo spawn aspetta tempo reale (waitMs).
 *
 * `findProjectWindow` è una LAMBDA a zero argomenti, non il registro: la
 * finestra va riletta nell'istante del click per catturare lo stato reale
 * dell'azione. Ricevere `loomRegistry` trasformerebbe il valore da letto-al-click
 * a catturato-alla-costruzione-del-menu — invisibile oggi (registro e menu si
 * riscrivono insieme), un bug il giorno in cui uno dei due si aggiorna da solo.
 */
export function coalesceTab(project, ts, findProjectWindow, spawnTab) {
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
}

// ── Ripresa di una conversazione (T162) ──────────────────────────────────────

// Il primitive di ripresa NON è in PATH: vive dentro il pacchetto npm del deck
// (`~/.local/lib/node_modules/@lamemind/loom-deck/scripts/deck-run`), e il
// symlink in `~/.local/bin` esiste solo per l'eseguibile del deck. Il contratto
// di famiglia copre i FORMATI, non gli eseguibili: risolvere il path è a carico
// di chi non è il deck.
//
// La risoluzione non assume niente oltre a ciò che il bottone 🎴 assume già —
// `loom-deck` in PATH, e il PATH di gnome-shell contiene `~/.local/bin`. Da lì
// il symlink punta a `dist/cli.js` dentro il pacchetto, e `deck-run` sta a
// `../scripts/deck-run`: la stessa formula di `DECK_RUN` in `spawn.ts` lato deck.
//
// Scartate: `npm root -g` (un processo sincrono dentro il compositore), il path
// cablato (si rompe al primo cambio di prefisso npm) e una seconda voce `bin`
// nel pacchetto (metterebbe in PATH uno script che nessuno invoca a mano).
let _deckRun = null; // memo del SOLO esito positivo: un fallimento si ritenta

export function deckRunPath() {
    if (_deckRun) return _deckRun;
    try {
        const bin = GLib.find_program_in_path('loom-deck');
        if (!bin) return null;
        // NOFOLLOW_SYMLINKS, o `query_info` descriverebbe il bersaglio e il
        // target sarebbe vuoto.
        const info = Gio.File.new_for_path(bin).query_info(
            'standard::symlink-target',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null
        );
        const target = info.get_symlink_target();
        if (!target) return null; // non è un symlink (wrapper a mano?) → non indovino
        // npm scrive un target RELATIVO (`../lib/node_modules/…`): va risolto
        // contro la cartella del link, non contro il cwd del compositore.
        const cli  = GLib.canonicalize_filename(target, GLib.path_get_dirname(bin));
        const path = GLib.canonicalize_filename(
            GLib.build_filenamev([GLib.path_get_dirname(cli), '..', 'scripts', 'deck-run']),
            null
        );
        if (!GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE)) return null;
        _deckRun = path;
        return _deckRun;
    } catch (e) {
        logError(e, '[Compass] deckRunPath');
        return null;
    }
}

// Alfabeti ammessi per i tre valori che compass passa a `deck-run`.
//
// Non è paranoia sull'argv — quello viaggia come array, senza shell. È che
// `deck-run` mette il TaskID dentro `bash -lc "$IN_TAB_CMD"`, cioè in una riga
// che una shell PARSA, e non lo quota: è nato per essere chiamato dal deck, che
// l'id lo prende da `tasks.md`. Qui i valori arrivano dal sidecar, che è
// macchina-locale ed editabile a mano. Un apice in `taskId` chiuderebbe la
// stringa e consegnerebbe alla shell tutto ciò che segue.
//
// Un valore fuori alfabeto non blocca la ripresa: si degrada al ramo senza quel
// valore (spot invece di scoped, cascata di deck-run invece del modello), che è
// una funzione in meno e non una tab con un comando rotto.
const SAFE_SID   = /^[A-Za-z0-9-]{8,64}$/;
const SAFE_TASK  = /^T\d{1,6}$/;
const SAFE_MODEL = /^(fable|opus|sonnet|haiku)$/;

/**
 * Riapre una conversazione chiusa come tab della finestra del progetto.
 *
 * `spec` = `{sessionId, taskId, model, note, title}` come li porta il sidecar.
 * `taskId` presente → ripresa SCOPED (la tab nasce con `LOOM_TASK` e col task
 * nel titolo); assente → ripresa spot (`--no-task`). Il modello viene passato
 * esplicito: senza `--model`, `deck-run` consulta il catalogo col kind implicito
 * `recap` — che oggi dà `fable` per coincidenza della riga di catalogo, non per
 * un default di ripresa.
 *
 * `--title-note` è obbligatorio quanto gli altri due, e per una ragione che non
 * si vede fino a che non manca: il titolo della tab NON viene dal sidecar —
 * `deck-run` lo compone da `.claude/loom-works.json` (emoji + nome) più il
 * TaskID — quindi senza quel flag la tab nasce `<emoji> <nome> · <task>`, o
 * `<emoji> <nome>` nuda su una spot, e non dice QUALE conversazione è. Con più
 * pinnate dello stesso progetto riaperte, le tab risultano omonime. Il deck lo
 * passa già sulle proprie riprese (`resumeArgs`); un secondo consumer che lo
 * omette produce tab peggiori delle sue, senza nessun errore.
 *
 * Nota prima, residuo del titolo come ricambio: è la stessa cascata
 * dell'etichetta di riga, e la nota è il valore che il deck passa. Il testo non
 * si quota e non si valida qui — lo RIDUCE `_sane_note` dentro `deck-run`, che
 * è una whitelist e sta là perché quel testo finisce dentro `bash -lc`.
 *
 * Non controlla se il transcript esiste ancora: uno `stat` porterebbe
 * `~/.claude/projects/` dentro i sorgenti dell'estensione, e leggere là dentro
 * è precisamente ciò che compass non fa. Una pinnata stale si riprende e
 * fallisce nella tab, che è il posto dove si vede.
 *
 * `onFail(reason)` riceve ogni ripresa che NON apre la tab — `deck-run` non
 * risolvibile, sessionId fuori alfabeto, spawn rifiutato, `deck-run` uscito
 * con un errore — e il chiamante la porta a schermo. Il clic è appena
 * avvenuto: senza un avviso, una ripresa fallita è indistinguibile da un menu
 * che non risponde, e la causa resta solo nel journal.
 */
export function launchResume(project, spec, ts, findProjectWindow, onFail = () => {}) {
    const fail = (reason) => {
        log(`[Compass] ripresa fallita: ${reason}`);
        try {
            onFail(reason);
        } catch (e) {
            logError(e, '[Compass] launchResume onFail');
        }
    };
    try {
        const deckRun = deckRunPath();
        if (!deckRun) {
            fail('deck-run non risolvibile da `loom-deck` in PATH');
            return;
        }
        const sid = SAFE_SID.test(spec?.sessionId ?? '') ? spec.sessionId : null;
        if (!sid) {
            fail(`sessionId fuori alfabeto (${spec?.sessionId})`);
            return;
        }
        const taskId = SAFE_TASK.test(spec.taskId ?? '')  ? spec.taskId : null;
        const model  = SAFE_MODEL.test(spec.model ?? '')  ? spec.model  : null;
        const dir    = projectDir(project);
        // Maniglia nel titolo della tab: nota prima, residuo del titolo come
        // ricambio. Ridotta da `_sane_note` dentro `deck-run`, non qui.
        const nota   = (spec.note ?? '').trim() || (spec.title ?? '').trim();

        const spawnTab = (newWindow) => {
            const argv = [deckRun, taskId ?? '--no-task', '--resume', sid];
            if (model) argv.push('--model', model);
            if (nota) argv.push('--title-note', nota);
            if (newWindow) argv.push('--new-window');
            try {
                const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDERR_PIPE});
                launcher.set_cwd(dir);
                // Esplicita e non lasciata a `$PWD`: `deck-run` la usa sia per
                // `ptyxis -d` sia per risalire alla project root da cui legge
                // identità e permissionMode, e dipendere dal `PWD` che bash
                // deriva dal cwd è un anello in più senza guadagno.
                launcher.setenv('LOOM_DECK_WORKDIR', dir, true);
                watchDeckRunExit(launcher.spawnv(argv), fail);
            } catch (e) {
                logError(e, '[Compass] launchResume spawn');
                fail(e.message);
            }
        };

        coalesceTab(project, ts, findProjectWindow, spawnTab);
    } catch (e) {
        logError(e, '[Compass] launchResume');
        fail(e.message);
    }
}

// L'uscita di `deck-run`, letta senza bloccare il compositore.
//
// `deck-run` esce appena Ptyxis ha preso in carico la tab, e un'uscita diversa
// da 0 vuol dire che la tab non è nata: errore d'uso (2), `node` assente dal
// PATH di gnome-shell (127 — `scripts/deck-run` è uno shim che fa `exec node`,
// e gnome-shell non legge `~/.bashrc`, dove nvm e simili estendono il PATH),
// Ptyxis che rifiuta. Lo stderr viaggia in un pipe, e la sua ultima riga è
// quella che nomina la causa («exec: node: not found»). Su un'uscita 0 lo
// stderr va comunque nel journal, dove arrivava da sé prima del pipe: lì
// `deck-run` avvisa dei valori scartati con fallback.
//
// Se Ptyxis non gira ancora, il `ptyxis` lanciato da `deck-run` diventa
// l'istanza primaria e vive finché il terminale resta aperto, e `deck-run` lo
// aspetta: l'uscita arriva allora alla chiusura del terminale, di norma 0.
function watchDeckRunExit(proc, fail) {
    proc.communicate_utf8_async(null, null, (p, res) => {
        try {
            const [, , stderr] = p.communicate_utf8_finish(res);
            const err = (stderr ?? '').trim();
            if (p.get_successful()) {
                if (err) log(`[Compass] deck-run: ${err}`);
                return;
            }
            const how  = p.get_if_exited() ? `uscita ${p.get_exit_status()}` : `segnale ${p.get_term_sig()}`;
            const last = err.split('\n').pop();
            fail(last ? `deck-run, ${how}: ${last}` : `deck-run, ${how}`);
        } catch (e) {
            logError(e, '[Compass] deck-run uscita');
        }
    });
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
// Solo il matcher loom (insieme di chiavi per-surface sul `name`). Un progetto
// che vive solo in projects.json non ha finestra risolvibile: il matcher legacy
// keyed sulla `label` di quel file non agganciava più niente da quando i titoli
// delle tab non portano l'owner (`🧵 loom-works · T74` contro `🧵 LOCAL
// loom-works`), quindi il suo «Vai» era già inerte. Il chiamante logga il miss.
//
// Risoluzione FRESCA, non la cache `_loomWins` di buildMenu: una notifica resta
// nello shade finché non la chiudi, quindi fra la sua comparsa e il click possono
// passare decine di minuti — nel frattempo la finestra può essere stata chiusa,
// riaperta o rititolata.
export function findNotificationWindow(loomRegistry, loomProject) {
    if (!loomProject) return null;
    return resolveLoomWindows(loomRegistry).get(loomProject.id)?.win ?? null;
}
