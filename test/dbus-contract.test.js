// dbus-contract.test.js — collaudo del contratto D-Bus di compass: ogni metodo
// dell'XML ha il suo metodo in `CompassService`, e ogni metodo pubblico del
// servizio è nell'XML.
//
// Eseguire dalla root del repo:
//
//     gjs -m test/dbus-contract.test.js
//
// Nessun framework, come `twin-title.test.js`: il primo caso sbagliato lancia e
// `gjs -m` esce non-zero. `dbus.js` si importa fuori da GNOME Shell (soli GLib
// e Gio a livello di modulo).
//
// Perché serve: `Gio.DBusExportedObject.wrapJSObject` cerca i metodi per nome,
// e un nome che manca non dà errore all'export — dà un errore D-Bus al primo
// chiamante, cioè a un hook o al deck, fuori da questo repo. La forma `…Async`
// conta come lo stesso metodo: è quella che riceve l'invocazione.

import Gio from 'gi://Gio';

import {DBUS_INTERFACE_XML, CompassService, BUS_NAME} from '../compass@lamemind/dbus.js';

function ok(cond, label) {
    if (!cond) throw new Error(label);
    print(`ok - ${label}`);
}

const node  = Gio.DBusNodeInfo.new_for_xml(DBUS_INTERFACE_XML);
const iface = node.lookup_interface(BUS_NAME);
ok(iface !== null, `l'XML dichiara l'interfaccia ${BUS_NAME}`);

const xmlMethods = iface.methods.map(m => m.name);
ok(xmlMethods.length > 0, `l'interfaccia ha metodi (${xmlMethods.length})`);

const proto = CompassService.prototype;
for (const name of xmlMethods) {
    const impl = typeof proto[name] === 'function' || typeof proto[`${name}Async`] === 'function';
    ok(impl, `${name} dell'XML ha il suo metodo nel servizio`);
}

// Un metodo pubblico del servizio (iniziale maiuscola, come i nomi D-Bus) che
// l'XML non dichiara non è raggiungibile da nessun chiamante.
const serviceMethods = Object.getOwnPropertyNames(proto)
    .filter(n => n !== 'constructor' && /^[A-Z]/.test(n))
    .map(n => n.replace(/Async$/, ''));
for (const name of serviceMethods)
    ok(xmlMethods.includes(name), `${name} del servizio è dichiarato nell'XML`);
