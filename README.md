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
| `compass@lamemind/impl.js` | la logica vera (indicatore, menu, D-Bus, registry) |
| `compass@lamemind/prefs.js` | la finestra delle impostazioni (GTK4/libadwaita, gira fuori dallo shell) |
| `compass@lamemind/schemas/` | schema GSettings dell'estensione + il suo compilato |
| `bin/compass` | bridge CLI: hook di stato Claude → D-Bus + `reload` |

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
serve un canale separato. Fuori da Ptyxis la variabile non esiste e l'hook esce silenzioso, senza rompere la sessione.

## Impostazioni

La voce **Impostazioni**, in fondo al menu e fuori dalla zona che scorre, apre la finestra delle impostazioni dell'estensione (la stessa di `gnome-extensions prefs compass@lamemind`). La finestra elenca i progetti del registry nell'ordine del menu, con un interruttore ciascuno: spento = il progetto non ha una riga nel menu. Il cambio vale subito, senza reload.

Nascondere un progetto toglie **solo la sua riga dal menu**. Badge in top bar, suono, notifica «Vai» e modale sulla conversazione in focus lo trattano come ogni altro progetto: il badge può quindi mostrare l'emoji di un progetto che nel menu non c'è. Con tutti i progetti nascosti il menu mostra `— tutti i progetti sono nascosti —`, non `— registry vuoto —`.

### Chiavi dconf

Le preferenze stanno nello schema GSettings dell'estensione, `org.gnome.shell.extensions.compass`, sotto `/org/gnome/shell/extensions/compass/`. Sono preferenze di **questa macchina**: il registry `/org/lamemind/loom/` descrive i progetti e lo scrive `loom-works init`, compass lo legge soltanto e non ci aggiunge niente.

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
| Chi scrive | `compass add` (rimosso da questo repo) | `loom-works init` (loom-works-plugin) |
| Stato | in dismissione | **corrente** |
| Versionato | ❌ gitignorato (path di lavoro + UUID locali) | — (per-macchina) |

`projects.json` **non è nel repo**: contiene path di lavoro e UUID di profili Ptyxis, roba per-macchina che non appartiene a un repo pubblico. Il modello è `compass@lamemind/projects.example.json`.

Il layer loom è la direzione: l'identità del progetto sta in un file committabile nel repo del progetto (`.claude/loom-works.json`), da cui `loom-works init` **registra** il progetto nel registry dconf. Le chiavi di match sono **derivate** (`{emoji} {name}`, una per surface), mai scritte a mano in più posti.

### Come compass legge dconf

Via **CLI `dconf dump /org/lamemind/loom/`** (`impl.js`, `_dconfDump`), non via `DConf.Client`: il typelib GJS di DConf non è installato di default su Fedora Workstation, quindi l'introspezione non è disponibile. Conseguenza pratica:
**niente `.watch()`** → nessuna notifica live sui cambi. Il registry viene
riletto **all'apertura del menu**, che per un indicatore top-bar è indistinguibile dal live. Se un giorno il typelib entra tra le dipendenze, `DConf.Client` + signal `changed` è un drop-in che elimina la rilettura.

> ⚠️ `gsettings` **non** funziona su questi path: sono dconf raw, senza schema
> GSettings installata. Serve `dconf` (CLI) o `DConf.Client` (GJS).

## Storia del repo

Il codice ha vissuto fino al 2026-07 dentro un repo privato di configurazione macchina, come sottocartella. La migrazione qui è un **import pulito** (nessuna history riscritta): la storia originale era di poche decine di commit, con messaggi legati a task di quel repo, e conteneva `projects.json` con path e nomi di lavoro reali — pubblicarla avrebbe richiesto comunque una riscrittura espurgante. Il valore archeologico non giustificava il rischio.

## Licenza

MIT — vedi [LICENSE](LICENSE).
