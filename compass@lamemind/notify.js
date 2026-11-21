// notify.js — compass@lamemind — I BANNER IN USCITA
//
// Le notifiche di compass, tutte dalla stessa sorgente `MessageTray` («Project
// Compass»): la stessa estensione resta una voce sola nel centro notifiche.
// Quattro banner, ognuno chiesto da un flusso diverso dell'indicatore:
//
//   ask          «chiede conferma», col «Vai» alla tab o alla finestra
//   focusWait    lo spawn in attesa del focus di un progetto (T229), col «Vai»
//                alla finestra del progetto, ritirato a fine attesa
//   focusOutcome l'esito di un focus che non porta alla tab (`FOCUS_NOTICE`)
//   resumeFailed una pinnata che non si è riaperta
//
// `Notifier` tiene la sorgente come proprio stato, e non sa niente
// dell'indicatore: il registry loom corrente e il focus di una conversazione
// li chiede con due callback passate alla costruzione. Il registry si legge al
// clic e non alla nascita del banner: un banner resta nel centro notifiche per
// minuti, e l'indicatore nel frattempo rilegge il registry e riassegna il campo.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

// Cache-busting propagato: vedi la testata di impl.js.
const _Q = import.meta.url.includes('?') ? '?' + import.meta.url.split('?')[1] : '';
const Desktop = await import('./desktop.js' + _Q);

// ── Esiti del focus che non portano alla tab ─────────────────────────────────
//
// Testi di coda@lamemind, da cui il focus della tab è trascritto. `tab` ed
// `esatta` non hanno testo: arrivano solo nel journal. Gli altri arrivano anche
// a schermo, perché chi resta sulla tab sbagliata senza saperlo non rilegge il
// journal.
const FOCUS_NOTICE = {
    ambigua: name => `Più tab si chiamano «${name}»: resto sulla finestra, la tab scegli tu`,
    assente: name => `Nessuna tab si chiama «${name}»: mostro la finestra del progetto`,
    fallita: name => `Il salto alla tab «${name}» non è arrivato`,
    errore:  name => `Tab di «${name}» non raggiungibile: l'helper di accessibilità non ha risposto`,
    nessuna: name => `Nessuna finestra Ptyxis per «${name}»`,
    // Il `sessionId` non è più nel registro vivo: non c'è un nome da dire.
    sconosciuta: () => 'Conversazione non più viva: mostro la finestra del progetto',
};

export class Notifier {
    // `registry` = () → il registry loom corrente dell'indicatore.
    // `focusSession` = (sessionId, origin, project) → Promise dell'esito: il
    // focus della tab di una conversazione, che resta dell'indicatore.
    constructor({registry, focusSession}) {
        this._registry     = registry;
        this._focusSession = focusSession;
        this._source       = null;
    }

    _getOrCreateSource() {
        if (this._source) return this._source;

        try {
            // GNOME 45+ object-init API
            this._source = new MessageTray.Source({
                title:    'Project Compass',
                iconName: 'utilities-terminal',
            });
        } catch (_e) {
            // Fallback GNOME 44 string API
            this._source = new MessageTray.Source(
                'Project Compass', 'utilities-terminal'
            );
        }

        this._source.connect('destroy', () => {
            this._source = null;
        });
        Main.messageTray.add(this._source);
        return this._source;
    }

    // Una notifica della sorgente di compass, non ancora consegnata: chi la
    // chiede può aggiungerle un'azione prima di `addNotification`.
    //
    // `transient` = sparisce dal centro notifiche dopo il banner. Lo vuole un
    // avviso che riguarda un clic appena fatto; non lo vuole «chiede
    // conferma», che porta un «Vai» da usare anche minuti dopo.
    _newNotification(title, body, transient = false) {
        const source = this._getOrCreateSource();
        let notification;
        try {
            // GNOME 45+ object-init API
            notification = new MessageTray.Notification({source, title, body, isTransient: transient});
        } catch (_e) {
            // Fallback GNOME 44 string API
            notification = new MessageTray.Notification(source, title, body);
            notification.setTransient?.(transient);
        }
        return notification;
    }

    _add(notification) {
        this._getOrCreateSource().addNotification(notification);
    }

    // Il «Vai» verso la finestra del progetto, comune ai due banner che lo
    // portano. `ts` lo cattura il chiamante dentro l'evento del clic: la
    // chiusura del banner può far arrivare l'activate fuori dal contesto
    // dell'evento, e con un timestamp corrente/0 la focus-stealing-prevention
    // di Mutter lo scarta (stesso vincolo del click sul bottone-nome,
    // §Coalescing).
    //
    // Log sul MISS: senza, un matcher che non aggancia più è indistinguibile da
    // un bottone che non fa niente — è esattamente così che un matcher rotto è
    // passato inosservato una volta.
    _focusProjectWindow(project, ts, missLog) {
        const win = Desktop.findNotificationWindow(this._registry(), project);
        if (!win) {
            log(missLog);
            return;
        }
        Desktop.focusWindow(win, ts);
    }

    // «chiede conferma». «Vai» porta alla tab della conversazione che chiede,
    // quando il `sessionId` è arrivato (`SetSessionState`); sul canale vecchio
    // (`SetState`) porta alla finestra del progetto, come prima della tab.
    //
    // `project` = la voce di projects.json, o null; `loomProject` = il
    // cappello del registry loom, o null. Almeno uno dei due c'è.
    ask(project, loomProject, sessionId = null) {
        const displayName  = loomProject?.label ?? project.display ?? project.label;
        const notification = this._newNotification(displayName, 'chiede conferma');

        try {
            notification.addAction('Vai', () => {
                if (sessionId) {
                    this._focusSession(sessionId, 'vai', loomProject)
                        .catch(e => logError(e, '[Compass] "Vai"'));
                    return;
                }
                this._focusProjectWindow(loomProject, global.get_current_time(),
                    `[Compass] "Vai": nessuna finestra per ${displayName}`);
            });
        } catch (_e) {}

        this._add(notification);
    }

    // T229 — la notifica dello spawn in attesa: titolo l'etichetta del
    // progetto, corpo l'avviso che il deck passa («spawn in attesa: T219
    // preflight»), bottone «Vai» che porta davanti la finestra del progetto col
    // codice del «Vai» di «chiede conferma» sul canale senza `sessionId`. Il
    // deck non può portare quel bottone: su Wayland un clic che torna al deck
    // non sposta il focus, e solo compass, dentro Mutter, può farlo.
    //
    // Resta nel centro notifiche e non suona: l'utente la usa quando torna, non
    // nell'istante in cui il deck la chiede. → la pulizia, che l'attesa chiama
    // alla chiusura per qualunque via — focus arrivato anche a mano, scadenza,
    // chiamante sparito, spegnimento —: nel centro notifiche non resta un «Vai»
    // per uno spawn che non aspetta più.
    //
    // «Vai» trova una finestra solo se una finestra Ptyxis ha davanti una tab
    // del progetto (`findNotificationWindow`); altrimenti lo scrive nel journal
    // e non fa niente, come il «Vai» di «chiede conferma».
    focusWait(projectId, notice) {
        const project = this._registry().find(p => p.id === projectId) ?? null;
        const notification = this._newNotification(project?.label ?? projectId, notice);
        let gone = false;
        notification.connect('destroy', () => {
            gone = true;
        });
        try {
            notification.addAction('Vai', () => {
                this._focusProjectWindow(project, global.get_current_time(),
                    `[Compass] "Vai" spawn in attesa: nessuna finestra per ${projectId}`);
            });
        } catch (_e) {}
        this._add(notification);
        return () => {
            if (!gone) notification.destroy();
        };
    }

    // L'esito di un focus che non porta alla tab, a schermo. `tab` ed `esatta`
    // non hanno testo, e non producono niente.
    focusOutcome(outcome, project, name) {
        const notice = FOCUS_NOTICE[outcome];
        if (!notice) return;
        this._add(this._newNotification(project?.label ?? 'Project Compass', notice(name), true));
    }

    // Una pinnata che non si è riaperta (`Desktop.launchResume`): transient
    // come `focusOutcome`, perché riguarda il clic appena fatto.
    resumeFailed(project, reason) {
        this._add(this._newNotification(
            project?.label ?? 'Project Compass', `ripresa non riuscita — ${reason}`, true));
    }

    destroy() {
        if (this._source) {
            this._source.destroy();
            this._source = null;
        }
    }
}
