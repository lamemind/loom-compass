# loom-compass

Estensione GNOME Shell: **radar cross-desktop** dei progetti e delle sessioni [Claude Code](https://claude.com/claude-code) aperte. Vive nella top bar e risponde alla domanda *«dove sono?»* su tutti i desktop contemporaneamente — con focus cross-desktop funzionante anche su Wayland.

Membro della famiglia **loom**, insieme a [`loom-works-plugin`](https://github.com/lamemind/loom-works-plugin) (il plugin Claude Code che definisce il contratto) e [`loom-deck`](https://github.com/lamemind/loom-deck) (deck TUI per-progetto). Il cappello che li aggrega è [`loom-works`](https://github.com/lamemind/loom-works).

## Modello

Ogni progetto è un **cappello** nel menu; sotto vivono le **surface** — i modi di essere presenti nel progetto:

```
🧵 loom-works                    ← cappello (progetto)
  ├─ claude  #1  ⚙️ running      ┐ tracked: stato live, match finestra, click→focus
  ├─ claude  #2  ❓ ask          │
  ├─ deck        ○ open          ┘
  └─ codium      (apri)          ← launch: comando arbitrario @project-root
```

Il cappello mostra **un solo** pallino, per **rollup** degli stati figli con priorità `ask > done > running > idle` — un figlio che ti aspetta vince su tutto.

## Componenti

| Path | Cosa |
| --- | --- |
| `compass@lamemind/` | l'estensione GNOME (UUID dir, installabile via symlink) |
| `compass@lamemind/extension.js` | **stub-loader** sottile: re-importa `impl.js` con cache-busting a ogni `enable()` |
| `compass@lamemind/impl.js` | la radice del grafo dei moduli: ciclo di vita e stato dell'indicatore, canale di stato, badge e suono, focus di una conversazione e di un progetto, cablaggio dei fratelli |
| `compass@lamemind/model.js` | il dato: registri, registro dei processi vivi, stato per-sessione, rollup |
| `compass@lamemind/desktop.js` | le finestre e i processi: match titolo → progetto, focus, salto di tab, coalescing, spawn, suono |
| `compass@lamemind/menu.js` | il popup e la voce di progetto: zona scorrevole, coda «Impostazioni», riga-cappello coi bottoni surface, rami espandibili |
| `compass@lamemind/rows.js` | le righe delle conversazioni sotto il cappello, vive e pinnate: titolo-bottone, toggle 🚨 📌, contatore dei turni headless |
| `compass@lamemind/dialog.js` | il modale sulla conversazione in focus (scorciatoia globale) |
| `compass@lamemind/notify.js` | i banner in uscita, dalla sorgente unica di compass: «chiede conferma», spawn in attesa, esiti del focus, ripresa fallita |
| `compass@lamemind/usage.js` | il consumo dell'account in top bar |
| `compass@lamemind/focus-wait.js` | l'attesa della finestra del progetto (`AwaitProjectFocus`): attese aperte, scadenza, ascolto del focus |
| `compass@lamemind/dbus.js` | il contratto D-Bus `org.lamemind.Compass`: l'XML e il servizio che inoltra ogni metodo all'indicatore |
| `compass@lamemind/collaudo.js` | il collaudo del focus nella sessione reale, guidato da `$XDG_RUNTIME_DIR/compass-collaudo.json` |
| `compass@lamemind/prefs.js` | la finestra delle impostazioni (GTK4/libadwaita, gira fuori dallo shell) |
| `compass@lamemind/reorder.js` | il riordino dei progetti dalla finestra delle impostazioni: calcolo dei numeri `order`, riga del file di progetto, copia in dconf, commit |
| `compass@lamemind/ptyxis-tab.js` | helper di accessibilità (AT-SPI): porta davanti la tab di una conversazione, in un processo `gjs` a sé |
| `compass@lamemind/schemas/` | schema GSettings dell'estensione + il suo compilato |
| `bin/compass` | bridge CLI: hook di stato Claude → D-Bus + `reload` |
| `test/` | collaudi fuori dallo shell, uno per file: `gjs -m test/<nome>.test.js` |

`impl.js` importa i fratelli, nessun fratello importa `impl.js`; il grafo e la ragione di ogni casella stanno nella testata di `impl.js`. `prefs.js` (con `reorder.js`, importato solo da lui) e `ptyxis-tab.js` girano in un altro processo e non sono nel grafo.

**Perché lo stub-loader**: GNOME Shell tiene `extension.js` in cache nel module loader e non lo rilegge senza restart dello shell — che su Wayland significa **relogin**. Lo stub è un guscio che a ogni `enable()` importa `impl.js` con una
query monotonic (`?v=…`): URL nuovo → il loader lo rilegge da disco. Risultato:
si itera sul codice con un `disable && enable`, senza relogin.

## Installazione

```bash
git clone https://github.com/lamemind/loom-compass.git
ln -s "$PWD/loom-compass/compass@lamemind" ~/.local/share/gnome-shell/extensions/compass@lamemind
ln -s "$PWD/loom-compass/bin/compass"      ~/.local/bin/compass
gnome-extensions enable compass@lamemind
```

Il symlink (invece della copia) tiene **una sola** fonte di verità: editi il repo, `compass reload`, fatto.

### Hook di stato

Il pallino si popola dagli hook di Claude Code (`~/.claude/settings.json`), che annunciano lo stato della sessione via D-Bus:

```jsonc
{ "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "compass running" }] }],
    "Notification":    [{ "hooks": [{ "type": "command", "command": "compass ask"     }] }],
    "Stop":            [{ "hooks": [{ "type": "command", "command": "compass done"    }] }],
    "SessionEnd":      [{ "hooks": [{ "type": "command", "command": "compass end"     }] }]
}}
```

Lo stato è **keyed su `$PTYXIS_PROFILE`**, non sul titolo della finestra: il
titolo è posseduto da `claude --name`, quindi non può portare anche lo stato →
serve un canale separato. La variabile porta l'`id` del progetto, non l'UUID di
un profilo Ptyxis: la mette davanti a `claude` chi apre la tab (il bottone 🤖 di
compass, `deck-run` lato deck). Una sessione aperta a mano in una tab qualunque
annuncia l'UUID del profilo di default, che nessun progetto dichiara: niente
badge né suono, ma la sua riga nel menu resta. Fuori da Ptyxis la variabile non
esiste e l'hook esce silenzioso, senza rompere la sessione.

## Focus di una conversazione

Il clic sul titolo di una conversazione viva nel menu (riga sotto il cappello o pinnata) porta davanti la **sua tab** Ptyxis, nella sua finestra, e poi la finestra. Lo stesso fa «Vai» sulla notifica «chiede conferma». La tab si trova dal titolo, che è il `--name` passato a `claude`; il cambio di tab passa dal bus di accessibilità (AT-SPI, pacchetto `at-spi2-core`), in un processo `gjs` a sé (`ptyxis-tab.js`): le chiamate AT-SPI sono sincrone, e dentro lo shell fermerebbero il desktop.

Da fuori lo stesso focus si chiede via D-Bus, e la risposta è l'esito — è il canale del deck, che su Wayland non può portare davanti un'altra finestra:

```bash
gdbus call --session --dest org.lamemind.Compass --object-path /org/lamemind/Compass \
  --method org.lamemind.Compass.FocusSession <sessionId>
```

| Esito | Significato |
| --- | --- |
| `esatta` | la tab era già davanti |
| `tab` | tab cambiata |
| `ambigua` | più tab con lo stesso nome: resta sulla finestra, nessun salto |
| `assente` | nessuna tab con quel nome: finestra del progetto |
| `fallita` | il salto non è arrivato alla tab |
| `errore` | l'helper di accessibilità non ha risposto |
| `nessuna` | nessuna finestra da mostrare |
| `sconosciuta` | il `sessionId` non è nel registro dei processi vivi |

Ogni focus scrive una riga `[Compass] focus <esito> <origine>` nel journal dello shell, con origine fra `riga`, `pinnata`, `vai`, `dbus`, `collaudo`. Gli esiti fuori dalla tab arrivano anche come banner, tranne su `FocusSession`: lì l'esito è nella risposta.

## La finestra in focus è del progetto?

`ProjectFocused` risponde se la finestra in focus è una finestra Ptyxis del progetto, riconosciuta dal titolo come nel menu (`<emoji> <name>` in testa al titolo della tab attiva). È di sola lettura: non cambia tab, finestra o desktop.

```bash
gdbus call --session --dest org.lamemind.Compass --object-path /org/lamemind/Compass \
  --method org.lamemind.Compass.ProjectFocused "'<id del progetto>'"
```

| Esito | Significato |
| --- | --- |
| `si` | la finestra in focus è una finestra Ptyxis del progetto |
| `no` | non lo è: un altro progetto, un'altra applicazione, nessuna finestra in focus |
| `ignoto` | il progetto non è nel registry, compass non sa cosa cercare |

Lo chiama il deck prima di aprire una tab chiesta da una conversazione: Ptyxis apre `--tab` nella sua finestra attiva, e sul `no` il deck mette la richiesta in coda invece di aprire la tab nella finestra di un altro progetto. Ogni chiamata scrive una riga `[Compass] project-focused <esito> <id>` nel journal dello shell.

## Aspettare la finestra del progetto

`AwaitProjectFocus` aspetta che la finestra in focus diventi una finestra Ptyxis del progetto, e risponde in quel momento. Non sposta mai il focus: la finestra la porta davanti l'utente. Lo chiama il deck per uno spawn messo in coda, con il testo dell'avviso e la vita della richiesta in secondi.

```bash
gdbus call --session --dest org.lamemind.Compass --object-path /org/lamemind/Compass \
  --method org.lamemind.Compass.AwaitProjectFocus '<id del progetto>' 'spawn in attesa: T219 preflight' 1800
```

| Esito | Quando |
| --- | --- |
| `si` | la finestra in focus è del progetto: subito, se lo è già, o al ritorno |
| `scaduta` | sono passati i secondi della scadenza prima del focus |
| `interrotta` | compass si è spento o ricaricato durante l'attesa |
| `ignoto` | il progetto non è nel registry |

Mentre aspetta, compass mostra una notifica dello spawn in attesa: titolo l'etichetta del progetto, corpo l'avviso del deck, bottone **«Vai»** che porta davanti la finestra del progetto. Resta nel centro notifiche, senza suono, e compass la ritira quando l'attesa si chiude per qualunque via — focus arrivato col bottone o a mano, scadenza, chiamante sparito, spegnimento —, così non resta un «Vai» per uno spawn che non aspetta più. «Vai» trova una finestra solo se una finestra Ptyxis ha davanti una tab del progetto; altrimenti lo scrive nel journal e non fa niente.

Una finestra diventa del progetto in due modi, e l'attesa li ascolta entrambi: prende il focus, oppure è già in focus e l'utente passa a una tab del progetto, perché il titolo di una finestra Ptyxis è quello della sua tab attiva. compass ascolta il focus solo mentre almeno un'attesa è aperta, e segue il chiamante sul bus: un `gdbus call` che muore prima della risposta chiude la sua attesa. Ogni attesa scrive nel journal una riga all'apertura (`[Compass] await-focus attesa <id> <secondi>s «<avviso>»`) e una alla chiusura (`[Compass] await-focus <esito> <id>`, con `abbandonata` per il chiamante sparito).

## Impostazioni

La voce **Impostazioni**, in fondo al menu e fuori dalla zona che scorre, apre la finestra delle impostazioni dell'estensione (la stessa di `gnome-extensions prefs compass@lamemind`). La finestra elenca i progetti del registry nell'ordine del menu, con un interruttore e due frecce ↑/↓ ciascuno. Spento = il progetto non ha una riga nel menu; il cambio vale subito, senza reload.

Nascondere un progetto toglie **solo la sua riga dal menu**. Badge in top bar, suono, notifica «Vai» e modale sulla conversazione in focus lo trattano come ogni altro progetto: il badge può quindi mostrare l'emoji di un progetto che nel menu non c'è. Con tutti i progetti nascosti il menu mostra `— tutti i progetti sono nascosti —`, non `— registry vuoto —`.

### Riordinare i progetti

Le frecce spostano le righe della finestra, e basta: niente si scrive finché non si preme **Applica**, nella testata del gruppo. Applica è spento finché le righe sono nell'ordine salvato. Chiudere la finestra con spostamenti non applicati li scarta, senza conferma. I progetti nascosti stanno nella lista e contano come vicini.

L'ordine del menu viene dal campo `order` del `.claude/loom-works.json` di ogni progetto; il registry dconf ne tiene una copia, che `refresh.sh` riscrive dal file. Per questo Applica, per ogni progetto che cambia numero:

1. scrive il nuovo `order` nel file di progetto: cambia solo la cifra della riga `"order": N`, o aggiunge quella riga subito dopo la riga `"name"` quando manca. `git diff` mostra una riga sola, e il resto del file resta com'è;
2. scrive la stessa cifra in `/org/lamemind/loom/projects/<id>/order`;
3. committa il solo file nel repo del progetto, sul ramo corrente: `git commit -- .claude/loom-works.json`, messaggio `compass: order <id> → <N>`. Altri file in stage restano in stage.

**Compass non pusha.** Il commit resta locale finché non pushi tu quel repo: `git push` pubblicherebbe tutti i commit che il ramo ha in più del remote, non il solo commit di compass.

Il menu legge il registry a ogni apertura: l'ordine nuovo compare alla prossima, senza reload.

**Quali progetti cambiano numero.** Il minimo: ogni numero cambiato è un commit in un repo diverso. I numeri si calcolano sull'ordine finale delle righe, non sulla strada dei clic. Restano fermi quanti più progetti numerati si può; gli altri prendono un intero fra i due vicini, o l'ultimo numero più 10 in coda. Esempi:

| Ordine di partenza | Spostamento | Cambia |
| --- | --- | --- |
| loom-works 50, factory 52, money 60 | money fra loom-works e factory | money → 51 |
| 50, 51, 52, 60 | il 52 sopra il 51 | il 51 → 56: un vicino, non il progetto spostato |
| money 60, accollo (senza `order`), cc-host 70 | cc-host sotto accollo | accollo → 65 |

Il progetto che cambia numero può quindi essere un vicino di quello spostato, e il commit cade nel suo repo. A parità di costo resta fermo il progetto più in alto. I progetti senza `order` che chiudono la lista in ordine alfabetico restano senza; ogni altro progetto senza `order` prende un numero. Tutti a passi di 10 solo quando nessun numero si può tenere.

**Quando non si committa.** Il file viene scritto (file e dconf restano concordi) ma non committato in due casi, detti nel sottotitolo della riga del progetto:

| Caso | Perché |
| --- | --- |
| file non versionato | non c'è niente da committare |
| il file ha altre modifiche non committate | `git commit -- <file>` committa il file intero: le altre modifiche entrerebbero nel commit di compass |

**Quando non si scrive niente.** Prima di scrivere, Applica legge e prepara tutti i file. Un file illeggibile, un JSON invalido, un id diverso da quello del registry o un file senza le righe `"order"` o `"name"` su riga propria annullano l'applicazione intera: nessun file, nessun valore dconf. Le righe restano dove le hai messe, e Applica resta acceso. Se la scrittura in dconf fallisce, il file di quel progetto torna al testo di prima e l'applicazione si ferma; un commit fallito non disfa niente. Ogni errore compare nel sottotitolo della riga del suo progetto, al posto del percorso, finché la finestra è aperta; un toast riassume l'esito.

Il codice sta in `reorder.js`; `gjs -m test/reorder.test.js` collauda il calcolo dei numeri e la modifica della riga.

### Chiavi dconf

Le preferenze stanno nello schema GSettings dell'estensione, `org.gnome.shell.extensions.compass`, sotto `/org/gnome/shell/extensions/compass/`. Sono preferenze di **questa macchina**: il registry `/org/lamemind/loom/` descrive i progetti e lo scrive `loom-works init`. Compass ci scrive un campo solo, `order`, da Applica e sempre insieme al file di progetto da cui `refresh.sh` lo ricopia.

| Chiave | Tipo | Default | Cosa |
| --- | --- | --- | --- |
| `hidden-projects` | `as` | `[]` | id dei progetti nascosti dal menu |
| `open-session-dialog` | `as` | `['<Super>c']` | scorciatoia del modale sulla conversazione in focus |

`hidden-projects` elenca i **nascosti**, non i visibili: un progetto registrato dopo compare nel menu da sé. Un id che non è più nel registry resta nella lista senza effetto, e la finestra non lo mostra.

Le chiavi si leggono e si scrivono anche da terminale, e il menu segue anche lì senza reload:

```bash
dconf read  /org/gnome/shell/extensions/compass/hidden-projects
dconf write /org/gnome/shell/extensions/compass/hidden-projects "['money', 'cc-host']"
dconf reset /org/gnome/shell/extensions/compass/hidden-projects
```

### Il primo avvio della finestra chiede un relogin

GNOME Shell decide se un'estensione ha una finestra di impostazioni **una volta sola**, quando la carica al login: guarda se `prefs.js` c'è sul disco. Un `compass reload` non rifà quel controllo. Su un'installazione che è salita a questa versione senza relogin, quindi, la voce **Impostazioni** non apre niente e il journal dello shell registra `«Impostazioni»: nessuna finestra per compass@lamemind`. Dopo un relogin funziona.

Nell'attesa la finestra si apre chiamando direttamente il servizio che la ospita, che quel controllo non lo fa:

```bash
gdbus call --session --dest org.gnome.Shell.Extensions \
  --object-path /org/gnome/Shell/Extensions \
  --method org.gnome.Shell.Extensions.OpenExtensionPrefs compass@lamemind '' '{}'
```

La finestra gira in un processo separato dallo shell, che si chiude pochi secondi dopo la chiusura della finestra: un edit a `prefs.js` si vede alla riapertura successiva, senza `compass reload`.

### Modificare lo schema

Lo schema compilato, `schemas/gschemas.compiled`, è versionato: GNOME Shell legge quello, non l'XML. Dopo un edit a `org.gnome.shell.extensions.compass.gschema.xml`:

```bash
glib-compile-schemas --strict compass@lamemind/schemas/
compass reload
```

XML e compilato vanno nello stesso commit. Una chiave nuova si vede dopo il `compass reload`, senza relogin.

## Registry — due layer, in coesistenza

L'estensione legge i progetti da **due** sorgenti, in ordine:

| | `projects.json` (legacy) | registry dconf (loom) |
| --- | --- | --- |
| Dove | `compass@lamemind/projects.json` | `/org/lamemind/loom/projects/<id>/` |
| Chi scrive | `compass add` (rimosso da questo repo) | `loom-works init` e `refresh.sh` (loom-works-plugin); il solo `order` anche la finestra delle impostazioni |
| Stato | in dismissione | **corrente** |
| Versionato | ❌ gitignorato (path di lavoro + UUID locali) | — (per-macchina) |

`projects.json` **non è nel repo**: contiene path di lavoro e UUID di profili Ptyxis, roba per-macchina che non appartiene a un repo pubblico. Il modello è `compass@lamemind/projects.example.json`.

Il layer loom è la direzione: l'identità del progetto sta in un file committabile nel repo del progetto (`.claude/loom-works.json`), da cui `loom-works init` **registra** il progetto nel registry dconf. Le chiavi di match sono **derivate** (`{emoji} {name}`, una per surface), mai scritte a mano in più posti.

### Come compass legge dconf

Via **CLI `dconf dump /org/lamemind/loom/`** (`model.js`, `dconfDump`), non via `DConf.Client`: il typelib GJS di DConf non è installato di default su Fedora Workstation, quindi l'introspezione non è disponibile. Conseguenza pratica:
**niente `.watch()`** → nessuna notifica live sui cambi. Il registry viene
riletto **all'apertura del menu**, che per un indicatore top-bar è indistinguibile dal live. Se un giorno il typelib entra tra le dipendenze, `DConf.Client` + signal `changed` è un drop-in che elimina la rilettura.

> ⚠️ `gsettings` **non** funziona su questi path: sono dconf raw, senza schema
> GSettings installata. Serve `dconf` (CLI) o `DConf.Client` (GJS).

## Storia del repo

Il codice ha vissuto fino al 2026-07 dentro un repo privato di configurazione macchina, come sottocartella. La migrazione qui è un **import pulito** (nessuna history riscritta): la storia originale era di poche decine di commit, con messaggi legati a task di quel repo, e conteneva `projects.json` con path e nomi di lavoro reali — pubblicarla avrebbe richiesto comunque una riscrittura espurgante. Il valore archeologico non giustificava il rischio.

## Licenza

MIT — vedi [LICENSE](LICENSE).
