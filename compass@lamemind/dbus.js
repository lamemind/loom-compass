// dbus.js — compass@lamemind — IL CONTRATTO D-BUS IN INGRESSO
//
// L'interfaccia `org.lamemind.Compass` (XML) e l'oggetto che la implementa,
// `CompassService`. Chi la chiama vive fuori da questo repo: gli hook di stato
// del plugin (`bin/compass`, `announce-state.sh`) e il deck.
//
// I nomi dei metodi della classe SONO il contratto, e vivono in due posti che
// devono restare allineati — il corpo della classe e `DBUS_INTERFACE_XML`.
// `CompassService` non è GObject: `Gio.DBusExportedObject.wrapJSObject` la
// ispeziona per nome di metodo, e un nome che manca non dà errore all'export
// ma al primo chiamante. Il presidio è `gjs -m test/dbus-contract.test.js`,
// che confronta i due elenchi; stare nello stesso file, a poche righe di
// distanza, aiuta chi li modifica a vederli insieme.
//
// Il servizio non fa niente da sé: inoltra ogni chiamata all'indicatore, che
// riceve per argomento e non importa. Ciclo di vita (export, nome sul bus,
// unexport) e ordine dello spegnimento restano in `impl.js`.
//
// Soli GLib e Gio a livello di modulo: il file si carica anche fuori da GNOME
// Shell.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

/** Il nome ben noto che compass chiede sul bus di sessione. */
export const BUS_NAME = 'org.lamemind.Compass';

/** Il path dell'oggetto esportato. */
export const OBJECT_PATH = '/org/lamemind/Compass';

export const DBUS_INTERFACE_XML = `
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
    <!-- Porta davanti la tab della conversazione e risponde con l'esito
         (esatta, tab, ambigua, assente, fallita, errore, nessuna, sconosciuta).
         Lo chiama il deck, che su Wayland non può portare davanti un'altra
         finestra: compass gira dentro Mutter e sì. -->
    <method name="FocusSession">
      <arg type="s" name="session_id" direction="in"/>
      <arg type="s" name="esito"      direction="out"/>
    </method>
    <!-- Sola lettura: dice se la finestra in focus è del progetto (si, no,
         ignoto) senza cambiare tab, finestra o desktop. Lo chiama il deck prima
         di aprire una tab chiesta da una conversazione (T198). -->
    <method name="ProjectFocused">
      <arg type="s" name="project_id" direction="in"/>
      <arg type="s" name="esito"      direction="out"/>
    </method>
    <!-- Aspetta che la finestra in focus diventi del progetto, e risponde in
         quel momento: si, scaduta, interrotta, ignoto. Risponde si subito se lo
         è già. Lo chiama il deck per uno spawn messo in coda (T229); avviso è
         il testo della notifica dello spawn in attesa, scadenza_s la vita
         della richiesta in coda. Il focus non lo sposta mai: lo porta l'utente. -->
    <method name="AwaitProjectFocus">
      <arg type="s" name="project_id" direction="in"/>
      <arg type="s" name="avviso"     direction="in"/>
      <arg type="u" name="scadenza_s" direction="in"/>
      <arg type="s" name="esito"      direction="out"/>
    </method>
  </interface>
</node>`;

export class CompassService {
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

    // Risponde DOPO il salto (~0,3 s): GJS manda la risposta al bus quando la
    // Promise ritornata risolve, e un errore D-Bus se rigetta. Il rigetto qui
    // non arriva: un'eccezione si logga e diventa l'esito `errore`, così il
    // chiamante legge sempre una parola dello stesso vocabolario.
    async FocusSession(sessionId) {
        let outcome;
        try {
            outcome = await this._indicator.focusSession(sessionId, 'dbus');
        } catch (e) {
            logError(e, '[Compass] FocusSession');
            outcome = 'errore';
        }
        return new GLib.Variant('(s)', [outcome]);
    }

    // Sincrono: legge il focus e il registry già in memoria, nessuna attesa.
    // Un'eccezione diventa un errore D-Bus, che il deck tratta come «non lo
    // so» — apre e lo dice —, e non un `no` che rifiuterebbe a torto.
    ProjectFocused(projectId) {
        return new GLib.Variant('(s)', [this._indicator.projectFocused(projectId)]);
    }

    // T229 — la forma `…Async` e non una Promise: è l'unica in cui GJS passa
    // l'invocazione, e dall'invocazione viene il chiamante da seguire sul bus
    // (`awaitProjectFocus`). La risposta parte quando l'attesa si chiude, anche
    // dopo minuti: GJS non la manda da sé, la manda `return_value`.
    AwaitProjectFocusAsync([projectId, notice, deadlineS], invocation) {
        this._indicator.awaitProjectFocus(projectId, notice, deadlineS,
            invocation.get_connection(), invocation.get_sender(),
            outcome => invocation.return_value(new GLib.Variant('(s)', [outcome])));
    }
}

// Esporta il servizio sul bus di sessione, al path `OBJECT_PATH`. → l'oggetto
// esportato: chi lo esporta lo toglie dal bus con `unexport()`, nell'ordine
// dello spegnimento che `impl.js` stabilisce.
export function exportService(indicator) {
    const exported = Gio.DBusExportedObject.wrapJSObject(DBUS_INTERFACE_XML, new CompassService(indicator));
    exported.export(Gio.DBus.session, OBJECT_PATH);
    return exported;
}
