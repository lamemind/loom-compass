// dialog.js — compass@lamemind — IL MODALE SULLA CONVERSAZIONE IN FOCUS
//
// Risoluzione del bersaglio (finestra in focus → conversazioni candidate) e il
// modale che agisce su di esso: disambiguazione quando le candidate sono più di
// una, pannello di edit di pin, nota e priorità.
//
// Quarto fratello del grafo dei moduli, accanto a menu.js:
//
//     impl.js  →  {menu.js, dialog.js}  →  {model.js, desktop.js}
//
// Sta fuori da menu.js e non dentro per due ragioni indipendenti: menu.js è già
// al limite della soglia di capienza, e il modale non condivide un solo widget
// col popup della top bar — sono due superfici con due cicli di vita.
//
// Come menu.js, non importa il sistema di tipi: i widget dello shell si
// ISTANZIANO, e l'unica `registerClass` dell'estensione resta quella di impl.js,
// col suffisso monotonic nel `GTypeName` che rende ogni hot-reload un tipo
// distinto. Un secondo `registerClass` qui dovrebbe replicare quel trucco per
// non incappare in «Type name already registered» al primo reload — da cui
// `ModalDialog` istanziato con `new` e popolato via `contentLayout`, non
// sottoclassato.

// Tutto l'ambiente grafico entra per import DINAMICO che degrada a `null`, mai
// per import statico — né i moduli dello shell né i typelib GI.
//
// Un import statico di uno dei due fa fallire il caricamento dell'INTERO file
// fuori da GNOME Shell, con due messaggi diversi per la stessa causa: «Unable to
// load file from resource://…» per un modulo dello shell, «Typelib file for
// namespace 'Clutter' not found» per un typelib che sulla macchina esiste solo
// dentro il processo dello shell. Il fallimento porterebbe con sé anche
// `focusedSessions`, che di grafica non ha bisogno: la parte collaudabile senza
// compositore diventerebbe non caricabile per colpa della parte che non lo è.
//
// Con questa forma il file si carica sempre, `gjs -m` può importarlo per
// collaudare la risoluzione, e `openSessionDialog` solleva se qualcuno la chiama
// fuori dallo shell. Nessuna guardia che lo verifichi: dentro lo shell l'ambiente
// c'è per costruzione, e un ramo per un caso che non accade sarebbe codice che
// nessuno esegue — un'eccezione chiara vale di più.
//
// `gi://X` esporta il namespace come `default`, da cui lo scarto del wrapper.
const Clutter      = (await import('gi://Clutter').catch(() => null))?.default;
const St           = (await import('gi://St').catch(() => null))?.default;
const ModalDialog  = await import('resource:///org/gnome/shell/ui/modalDialog.js').catch(() => null);
const ShellDialog  = await import('resource:///org/gnome/shell/ui/dialog.js').catch(() => null);

// Token di cache-busting propagato ai fratelli: `import.meta.url` lo porta, un
// `import './x.js'` statico NO — il figlio resterebbe in cache per tutta la vita
// del processo gnome-shell, e `compass reload` ricaricherebbe un file su cinque
// producendo un grafo misto (impl nuovo + model vecchio) senza nessun errore.
const _Q = import.meta.url.includes('?') ? '?' + import.meta.url.split('?')[1] : '';
const Model   = await import('./model.js'   + _Q);
const Desktop = await import('./desktop.js' + _Q);

// ── Risoluzione del bersaglio ────────────────────────────────────────────────

// Dalla finestra in focus all'insieme delle conversazioni candidate.
//
// La catena sfrutta un'ASIMMETRIA fra i due versi. Da una conversazione alla sua
// tab non si arriva — nessuna fonte lega le due cose, ed è la ragione per cui le
// righe-sessione del menu sono inerti. Dalla tab in focus alla conversazione sì,
// perché due fatti si incastrano: il titolo della finestra segue la tab davanti,
// e il nome con cui la conversazione è nata compone quel titolo.
//
// Ne discende che un'azione lanciata dal FOCUS può sapere su cosa agisce, mentre
// la stessa azione lanciata da una lista non può raggiungerla: sono due forme che
// abilitano funzioni diverse, non due strade per la stessa funzione.
//
// Composizione e nient'altro: i due pezzi che decidono stanno nei moduli foglia
// (`Desktop.projectForTitle`, `Model.sessionsByName`), che non si importano a
// vicenda e si collaudano ognuno per conto proprio. Qui si tiene solo la lettura
// di `global`, che è ciò che non si può collaudare fuori dallo shell — e anche
// quella entra per parametro, con un default, così la catena intera gira su una
// finestra finta.
//
// TRE esiti, e il chiamante li rende diversi:
//   - `project: null` → nessuna finestra di progetto loom in focus (browser,
//     editor, o nessuna finestra affatto);
//   - `project` valorizzato, `sessions: []` → la finestra è del progetto ma la
//     tab davanti non è una conversazione. Il caso normale è una tab deck o
//     terminal: il titolo porta la chiave del progetto (`🎴 <name> [deck]`), ma
//     nessuna sessione si chiama così. Non si ripiega sull'elenco di tutte le
//     conversazioni del progetto — sarebbe il menu della top bar dentro il
//     modale, e l'azione qui è sulla conversazione DAVANTI a te;
//   - una o N sessioni → il bersaglio, da disambiguare se più di una.
//
// Le conversazioni dei worktree lane restano fuori, e non per una svista del
// filtro: `sessionsForProject` scarta i `cwd` fuori da `project.dir`, e una lane
// è una directory sorella. Anche includendola, il sidecar che il deck di quella
// lane legge sta sotto la root della lane — una scrittura keyed sul progetto
// finirebbe in un file che nessun lettore della lane apre.
export function focusedSessions(
    loomRegistry, liveSessions, win = global.display.get_focus_window()
) {
    const title   = win?.get_title() ?? '';
    const project = title ? Desktop.projectForTitle(title, loomRegistry) : null;
    if (!project) return {title, project: null, sessions: []};
    const sessions = Model.sessionsByName(
        Model.sessionsForProject(project, liveSessions), title
    );
    return {title, project, sessions};
}

// ── Il modale ────────────────────────────────────────────────────────────────

// Glifi dei tre campi che il pannello tocca. I due booleani portano lo stesso
// glifo delle righe del popup (🚨 priorità, 📌 pin) perché sono la stessa marca
// vista da un'altra superficie; la chiave È il nome del campo nel sidecar, così
// la stessa stringa viaggia dal widget al file e non esiste una tabella di
// traduzione da tenere allineata.
const FIELD_GLYPH = {priority: '🚨', pinned: '📌', note: '📝'};

// Etichette dei due toggle. Il testo dice cosa fa il campo, non il suo stato:
// quello lo dice la casella davanti (vedi CHECK_GLYPH).
const FIELD_LABEL = {priority: 'prioritaria', pinned: 'pinnata'};

// Acceso e spento come CASELLA, non come opacità.
//
// Nel popup lo stato di un toggle è l'opacità, e lì funziona perché il fade
// significa «azionabile»: si accende al passaggio del puntatore. In un modale la
// stessa convenzione sarebbe ambigua — un toggle spento che si illumina sotto il
// mouse si legge come acceso, e qui la lettura deve essere certa prima di
// premere Conferma, che scrive. La casella invece dice lo stato senza dipendere
// dal puntatore né dal tema.
const CHECK_GLYPH = {on: '☑', off: '☐'};

// Classi del TEMA dello shell, non nostre.
//
// I widget di questo modale portano `modal-dialog-button` dentro un contenitore
// `modal-dialog-button-box`, e il motivo è il focus da tastiera: la nostra
// `compass-surface-btn` definisce solo `:hover`, quindi un bottone raggiunto con
// Tab non cambiava aspetto — il puntatore lo evidenziava e la tastiera no, cioè
// navigare il modale senza mouse era possibile ma cieco.
//
// Il tema dà a quella coppia di classi `:focus` (anello col colore d'accento),
// `:hover`, `:active` e `:checked` già risolti sul tema in uso, chiaro o scuro.
// Le regole valgono però solo DENTRO il contenitore: il selettore del tema è
// `.modal-dialog .modal-dialog-button-box .modal-dialog-button`, quindi la classe
// sul bottone da sola non stila niente e il contenitore non è decorativo.
//
// `:checked` porta anche lo stato acceso, che diventa così sfondo pieno oltre
// alla casella. Le due cose non sono un doppione: il colore si legge a colpo
// d'occhio, la casella resta leggibile a chi il colore non lo distingue.
//
// Scrivere le stesse regole in `stylesheet.css` non era una strada: il foglio
// resta in cache nel loader fino al prossimo relogin, quindi una regola nuova lì
// non si vedrebbe per tutta la sessione grafica corrente.
const THEME_BTN     = 'modal-dialog-button';
const THEME_BTN_BOX = 'modal-dialog-button-box';

// Larghezza del contenuto del modale, in pixel.
//
// Il `modal-dialog` dello shell cresce in altezza e non in larghezza (il suo
// request mode è HEIGHT_FOR_WIDTH), quindi la larghezza la deve dichiarare il
// contenuto. Senza, il dialogo si stringe sul più largo dei suoi figli — e i
// titoli di conversazione sono lunghi e variabili, per cui il modale cambierebbe
// dimensione a ogni apertura.
//
// Stile INLINE e non una regola nello stylesheet, come l'indentazione delle
// righe-sessione in menu.js e per la stessa ragione: `stylesheet.css` resta in
// cache nel loader fino al prossimo relogin, quindi una regola nuova lì non si
// vedrebbe per tutta la sessione grafica corrente.
const DIALOG_WIDTH_PX = 520;

// Riga di una candidata: `glifo-stato · età-stato/età-conversazione · pid`.
//
// Con titoli identici il discriminante deve essere sempre distinto, e due
// sessioni sulla stessa task possono condividere anche stato ed età dello stato.
// Il `pid` è univoco per costruzione, quindi c'è sempre qualcosa che separa due
// righe; l'età della conversazione lo è in pratica. Stessi campi e stessa resa
// della riga-sessione del popup (`Model.ageText`, `Model.STATE_EMOJI`): le due
// viste mostrano la stessa conversazione e non devono descriverla in due modi.
//
// Scartati i primi caratteri del `sessionId`: non compaiono in nessun'altra
// vista di compass, quindi non aiuterebbero a riconoscere la conversazione.
function candidateText(session, channels) {
    const state = Model.sessionState(session, channels);
    const glyph = Model.STATE_EMOJI[state] ?? '⚪';
    return `${glyph}  ${Model.ageText(session)}  ·  pid ${session.pid}`;
}

// Toggle di un campo booleano: casella + glifo + etichetta, come bottone.
//
// NON scrive: muta solo `state[field]`. La scrittura è una sola, alla conferma,
// e questa è la ragione per cui il pannello tiene uno stato proprio invece di
// appendere a ogni click come fanno i toggle del popup — lì ogni bottone è la
// sua azione, qui i tre campi si confermano insieme in una riga sola.
function fieldToggle(state, field) {
    const btn = new St.Button({
        style_class: THEME_BTN,
        can_focus: true, track_hover: true,
        x_expand: true,
    });
    const paint = () => {
        const on = state[field];
        btn.label = `${CHECK_GLYPH[on ? 'on' : 'off']}  ` +
                    `${FIELD_GLYPH[field]} ${FIELD_LABEL[field]}`;
        // Pseudo-class e non un colore inline: il tema la risolve già, e uno
        // stile inline la batterebbe anche negli stati in cui non deve (`:focus`
        // e `:hover` dipingono lo stesso sfondo).
        if (on) btn.add_style_pseudo_class('checked');
        else    btn.remove_style_pseudo_class('checked');
    };
    paint();
    btn.connect('clicked', () => { state[field] = !state[field]; paint(); });
    return btn;
}

// Apre il modale sulla conversazione ospitata dalla tab in focus.
//
// `write` è iniettata e non importata: il pannello non deve sapere DOVE finisce
// la conferma, e col parametro il modale si collauda con una scrittura finta.
// Firma: `write(projectDir, sessionId, fields) → bool`, dove `fields` porta i
// soli campi toccati.
export function openSessionDialog(loomRegistry, liveSessions, channels, write) {
    const target = focusedSessions(loomRegistry, liveSessions);

    // `destroyOnClose` è il default e va bene: il modale nasce e muore a ogni
    // pressione, non è una finestra che si tiene aperta. I due schermi vivono
    // quindi dentro UNA istanza, ricostruendone il contenuto — aprirne una
    // seconda per la scelta rifarebbe l'animazione di apertura in mezzo a
    // un'interazione già cominciata.
    const dlg = new ModalDialog.ModalDialog();

    const showContent = (actor) => {
        dlg.contentLayout.destroy_all_children();
        dlg.clearButtons();
        dlg.contentLayout.add_child(actor);
    };

    // Esito senza bersaglio: lo dichiara e si chiude senza agire. Vale sia per
    // una finestra che non è di un progetto loom sia per una tab del progetto
    // che non è una conversazione (deck, terminale) — due cause, un unico
    // messaggio, perché l'azione richiesta all'utente è la stessa: mettere
    // davanti la conversazione su cui vuole agire.
    if (target.sessions.length === 0) {
        const content = new ShellDialog.MessageDialogContent({
            title: 'Nessuna conversazione in focus',
            description: target.project
                ? `La finestra è di ${target.project.label}, ma la tab davanti ` +
                  `non è una conversazione Claude Code.`
                : 'Metti davanti la tab di una conversazione Claude Code.',
        });
        content.style = `width: ${DIALOG_WIDTH_PX}px;`;
        showContent(content);
        dlg.addButton({label: 'Chiudi', action: () => dlg.close(),
                       key: Clutter.KEY_Escape, default: true});
        dlg.open();
        return;
    }

    // ── Pannello di edit ─────────────────────────────────────────────────────
    const openPanel = (session) => {
        const marks = Model.loadSessionMarks(target.project.dir).get(session.sessionId) ?? {};
        // Lo stato del pannello parte dal file e non da zero: i tre campi sono
        // marche già scritte, e un pannello che li mostrasse spenti farebbe
        // cancellare una marca a chi conferma solo per toccarne un'altra.
        const before = {
            priority: marks.priority === true,
            pinned:   marks.pinned   === true,
            note:     marks.note     ?? '',
        };
        const state = {...before};

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style: `width: ${DIALOG_WIDTH_PX}px; spacing: 12px;`,
        });

        box.add_child(new ShellDialog.MessageDialogContent({
            title:       session.name || `pid ${session.pid}`,
            description: candidateText(session, channels),
        }));

        const toggles = new St.BoxLayout({
            style_class: THEME_BTN_BOX, // richiesto dal selettore del tema, vedi THEME_BTN
            style: 'spacing: 12px;',
            x_expand: true,
        });
        toggles.add_child(fieldToggle(state, 'priority'));
        toggles.add_child(fieldToggle(state, 'pinned'));
        box.add_child(toggles);

        const entry = new St.Entry({
            hint_text:   `${FIELD_GLYPH.note} nota della conversazione`,
            can_focus:   true,
            x_expand:    true,
        });
        entry.set_text(state.note);
        box.add_child(entry);

        // Un solo passaggio di scrittura, protetto da una guardia.
        //
        // La conferma ha DUE canali — il bottone di default (Return, gestito dal
        // Dialog dello shell) e l'`activate` del campo di testo (Return mentre il
        // campo ha il focus) — e quale dei due scatta dipende da chi ha il focus
        // da tastiera in quell'istante. Senza guardia, un caso in cui scattassero
        // entrambi appenderebbe due righe al sidecar per una pressione sola.
        let done = false;
        const confirm = () => {
            if (done) return;
            done = true;

            // I soli campi TOCCATI, tutti in un record: un record che porta
            // anche i campi non toccati li riscriverebbe, e il last-wins per
            // campo del sidecar trasformerebbe quella riscrittura in una
            // sovrascrittura di ciò che un altro scrittore (il deck) ha messo
            // nel frattempo.
            state.note = entry.get_text() ?? '';
            const fields = {};
            for (const f of ['priority', 'pinned', 'note'])
                if (state[f] !== before[f]) fields[f] = state[f];

            if (Object.keys(fields).length === 0) {
                log('[Compass] modale: nessun campo cambiato, niente da scrivere');
            } else if (!write) {
                log(`[Compass] modale: scrittura non agganciata — ` +
                    `${session.sessionId} ${JSON.stringify(fields)}`);
            } else if (!write(target.project.dir, session.sessionId, fields)) {
                log(`[Compass] modale: scrittura FALLITA su ${target.project.dir}`);
            }
            dlg.close();
        };

        entry.clutter_text.connect('activate', confirm);

        showContent(box);
        dlg.addButton({label: 'Annulla', action: () => dlg.close(),
                       key: Clutter.KEY_Escape});
        dlg.addButton({label: 'Conferma', action: confirm, default: true});

        // Focus sul campo di testo, non sul bottone: la nota è l'unico campo che
        // si compila digitando, e i due toggle si premono col mouse o si
        // raggiungono con Tab. Va chiesto dopo `open()` quando il modale è già
        // aperto — `setInitialKeyFocus` vale solo al momento del pushModal.
        if (dlg.state === ModalDialog.State.OPENED ||
            dlg.state === ModalDialog.State.OPENING)
            entry.grab_key_focus();
        else
            dlg.setInitialKeyFocus(entry);
    };

    // Una sola candidata: diretti al pannello, nessun passaggio di scelta da
    // attraversare per una lista che avrebbe una riga.
    if (target.sessions.length === 1) {
        openPanel(target.sessions[0]);
        dlg.open();
        return;
    }

    // ── Schermo di disambiguazione ───────────────────────────────────────────
    //
    // N candidate: si elencano e si scegli. MAI una scelta implicita — prendere
    // la prima scriverebbe la marca su una conversazione che non è quella
    // davanti, e il guasto si scoprirebbe molto dopo, senza niente che lo colleghi
    // a questa pressione di tasto.
    const box = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style: `width: ${DIALOG_WIDTH_PX}px;`,
    });
    box.add_child(new ShellDialog.MessageDialogContent({
        title:       target.title,
        description: `${target.sessions.length} conversazioni con questo titolo: ` +
                     `scegli quale.`,
    }));
    // Le righe stanno in un contenitore `modal-dialog-button-box` per la stessa
    // ragione dei toggle: è quello che accende `:focus` sulle righe, e una lista
    // che si sceglie coi tasti deve dire dove sei.
    const rows = new St.BoxLayout({
        style_class: THEME_BTN_BOX,
        orientation: Clutter.Orientation.VERTICAL,
        style: 'spacing: 6px;',
        x_expand: true,
    });
    for (const s of target.sessions) {
        const row = new St.Button({
            style_class: THEME_BTN,
            // Il tema mette `font-weight: bold` sui bottoni di dialogo, giusto
            // per «Conferma» e «Annulla» ma pesante su una riga di dati (età,
            // pid). Lo stile inline batte la classe sulla SOLA proprietà che
            // nomina, quindi focus, hover e checked restano quelli del tema.
            style: 'font-weight: normal;',
            label: candidateText(s, channels),
            can_focus: true, track_hover: true,
            x_expand: true,
        });
        row.connect('clicked', () => openPanel(s));
        rows.add_child(row);
    }
    box.add_child(rows);
    showContent(box);
    dlg.addButton({label: 'Annulla', action: () => dlg.close(),
                   key: Clutter.KEY_Escape});
    dlg.open();
}
