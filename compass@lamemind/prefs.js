// prefs.js — compass@lamemind — LA FINESTRA DELLE IMPOSTAZIONI
//
// Una pagina, una funzione: quali progetti del registry loom compaiono nel menu
// della top bar. Una riga per progetto, nell'ordine del menu, con un
// interruttore: acceso = visibile. Scrive la chiave `hidden-projects` dello
// schema GSettings dell'estensione, e lo shell ricostruisce il menu sul
// `changed::` di quella chiave (impl.js) — nessun reload, nessun relogin.
//
// NON gira dentro gnome-shell. La carica il servizio `org.gnome.Shell.Extensions`
// (`gjs -m /usr/share/gnome-shell/org.gnome.Shell.Extensions`), un processo a
// parte: qui ci sono GTK4 e libadwaita, non St né i moduli
// `resource:///org/gnome/shell/ui/*`. Per questo non importa impl.js né menu.js,
// ma solo model.js, che usa soltanto GLib e Gio.
//
// L'import di model.js è statico, senza il token di cache-busting dei fratelli
// in impl.js: questo file stesso è importato senza query, quindi il token
// sarebbe vuoto. Non serve comunque: il servizio si chiude pochi secondi dopo
// la chiusura della finestra, e ogni apertura successiva rilegge i due file da
// disco.
//
// Interruttore e non casella: le HIG di GNOME danno l'interruttore alle opzioni
// che si applicano subito, la casella a quelle che aspettano un «Applica». Qui
// ogni cambio si scrive nell'istante.

import Adw from 'gi://Adw';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as Model from './model.js';

const KEY = Model.HIDDEN_PROJECTS_KEY;

export default class CompassPreferences extends ExtensionPreferences {

    fillPreferencesWindow(window) {
        // Id passato esplicitamente, come in impl.js: il metadata non è la
        // fonte di cui fidarsi sotto hot-reload.
        const settings = this.getSettings(Model.SETTINGS_SCHEMA_ID);

        const page  = new Adw.PreferencesPage({
            title: 'Progetti',
            icon_name: 'view-list-symbolic',
        });
        const group = new Adw.PreferencesGroup({
            title: 'Progetti nel menu',
            description: 'Spento: il progetto non ha una riga nel menu della top bar. ' +
                'Badge, suono e notifiche lo trattano come gli altri.',
        });
        page.add(group);
        window.add(page);

        // id progetto → riga, per riallineare gli interruttori a un cambio
        // arrivato da fuori (un `dconf write`, o la chiave resettata).
        const rows = new Map();

        // Connesso PRIMA di leggere la chiave: GSettings emette `changed::` solo
        // per le chiavi lette almeno una volta con un handler già connesso.
        //
        // Il riallineamento tocca solo le righe che divergono: una riga che
        // cambia stato riscrive la chiave (vedi `setHidden`), e riscrivere un
        // valore identico non serve a niente.
        const changedId = settings.connect(`changed::${KEY}`, () => {
            const hidden = new Set(settings.get_strv(KEY));
            for (const [id, row] of rows) {
                const active = !hidden.has(id);
                if (row.active !== active) row.active = active;
            }
        });
        // Il Gio.Settings muore col processo, ma la finestra può chiudersi prima:
        // un handler rimasto appeso scriverebbe su righe già distrutte.
        window.connect('close-request', () => {
            settings.disconnect(changedId);
            return false;
        });

        // Lo stesso lettore del menu, quindi lo stesso ordine: `order` del file
        // di progetto, poi l'id per chi non lo dichiara.
        const registry = Model.loadLoomRegistry();
        if (registry.length === 0) {
            group.add(new Adw.ActionRow({
                title: 'Nessun progetto registrato',
                subtitle: 'Un progetto entra nel registry con loom-works init.',
            }));
            return;
        }

        // Un id nascosto che non è più nel registry non ha riga: non ha emoji
        // né nome da mostrare, e resta nella chiave senza effetto.
        const hidden = new Set(settings.get_strv(KEY));
        for (const project of registry) {
            const row = new Adw.SwitchRow({
                title: `${project.emoji} ${project.name}`,
                subtitle: project.dir,
                // Nomi e percorsi sono testo, non markup: con il default
                // (markup attivo) un `&` nel nome svuoterebbe la riga.
                use_markup: false,
                active: !hidden.has(project.id),
            });
            row.connect('notify::active', () => setHidden(settings, project.id, !row.active));
            group.add(row);
            rows.set(project.id, row);
        }
    }
}

// Aggiunge o toglie un id dalla lista dei nascosti, partendo dal valore ATTUALE
// della chiave e non da una copia tenuta dalla finestra: un id scritto da fuori
// mentre la finestra è aperta non va perso alla prima riga toccata.
function setHidden(settings, id, hide) {
    const current = settings.get_strv(KEY);
    if (current.includes(id) === hide) return;
    settings.set_strv(KEY, hide ? [...current, id] : current.filter(x => x !== id));
}
