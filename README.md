<p align="center">
  <img src="./assets/banner.png" alt="kamijs banner" width="100%" />
</p>

<h1 align="center">Kamijs</h1>

<p align="center">
  <b>Motor de gacha de personajes para bots de WhatsApp (Baileys)</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-5.2.0-blue.svg" alt="version" />
  <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="license" />
  <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-339933.svg" alt="node" />
</p>

---

## ✨ ¿Qué es Kamijs?

**Kamijs** es un motor de gacha (estilo *waifu/husbando*) pensado para integrarse en bots de WhatsApp construidos sobre **Baileys**. Maneja todo el ciclo de vida del juego: economía, pity system, mercado entre usuarios, intercambios, tickets de selección y banco global — todo persistido en **SQLite**.

## 🚀 Características

- 🎰 **Sistema de pulls (10x)** con pity, suerte acumulada (luck) y multiplicadores de evento configurables.
- 💰 **Economía completa**: balance por usuario, banco global, jackpot e impuestos en el mercado.
- 🛒 **Mercado (marketplace)** paginado: listar, comprar y des-listar personajes entre usuarios.
- 🔁 **Intercambios (trade)** directos entre dos usuarios.
- 🎟️ **Sistema de tickets** de selección de personaje garantizado.
- 🖼️ **Proveedor de imágenes** integrado (yande.re) con filtro de contenido y caché en memoria con auto-limpieza (TTL de 5 min).
- 🗄️ **Migraciones automáticas** de base de datos al iniciar.
- 🧹 **Limpieza de usuarios inactivos** que devuelve su saldo al banco en vez de borrarlo.
- ✅ **Validación de JIDs** en todos los métodos públicos.
- 🪵 **Logging interno** con niveles, scopes y `sink` configurable para redirigir logs a tu propio sistema.
- 📡 **Eventos/hooks** (`onPull`, `onTrade`, etc.) para reaccionar sin envolver cada llamada manualmente.
- ⏱️ **Cooldowns configurables** por acción para prevenir spam (`pull10`, `useTicket`, `claimStarter`, etc.).
- ✏️ **CRUD completo de personajes**: crear, actualizar y eliminar (con protección si tiene dueños).
- 🔍 **Búsqueda parcial y paginación** de personajes y del mercado.
- 🧾 **Tipos incluidos** (`.d.ts`) para autocompletado en el editor.
- ⚡ Sin dependencias externas de gestión de LID: confía en la resolución de JIDs que ya provee tu socket de Baileys.

## 📦 Instalación

```bash
npm install ./kamijs
# o, si lo publicas en tu propio registro/monorepo:
npm install kamijs
```

Requiere **Node.js 18+**.

## 🔧 Uso rápido

```js
import { Kamijs } from "kamijs";

const kami = new Kamijs({
  dbPath: "./database/gacha.db",
  logLevel: "info",              // "debug" | "info" | "warn" | "error" | "silent"
  cooldowns: { pull10: 3000 },   // ms de cooldown por acción (opcional)
});
await kami.init();

// Escuchar eventos
kami.on("pull", ({ jid, results }) => {
  console.log(`${jid} hizo un pull10, hits:`, results.filter(r => r.char).length);
});

// Depositar monedas
await kami.deposit(jid, 5000, sock);

// Hacer un pull x10
const results = await kami.pull10(jid, { sock, chatId, eventConfig: { rateMultiplier: 1.5 } });

// Ver harem (personajes obtenidos)
const harem = await kami.getHarem(jid, sock);

// Al apagar el bot
await kami.close();
```

## 🪵 Logging

Por defecto, Kamijs registra internamente eventos relevantes (inicialización, errores en transacciones, fallos de imagen, etc.) usando `console`. Puedes redirigir esos logs a tu propio sistema (Winston, Pino, un archivo, Discord webhook, lo que sea) con `logSink`:

```js
const kami = new Kamijs({
  dbPath: "./database/gacha.db",
  logLevel: "debug",
  logSink: (entry) => {
    // entry: { timestamp, level, scope, message, meta }
    miLogger.log(entry.level, entry.message, entry.meta);
  },
});
```

También puedes acceder al logger directamente: `kami.logger.warn("mensaje", { extra: 1 })`.

## 📡 Eventos

Kamijs expone un `EventBus` propio (sin dependencias). Te suscribes con `kami.on(evento, handler)`:

```js
kami.on("pull", ({ jid, results, finalTickets }) => { /* ... */ });
kami.on("trade", ({ fromJid, toJid, charId }) => { /* ... */ });
kami.on("marketBought", ({ jid, charId, price, sellerJid, tax }) => { /* ... */ });
kami.on("characterAdded", ({ charId, data }) => { /* ... */ });
kami.on("error", ({ context, error }) => { /* método que falló y el error */ });
```

Eventos disponibles (también exportados como constantes en `KAMIJS_EVENTS`):

| Evento | Se emite cuando... |
|---|---|
| `pull` | Se completa un `pull10` exitoso. |
| `starterClaimed` | Un usuario reclama su personaje inicial. |
| `ticketUsed` / `ticketFailed` | Un ticket de selección tiene éxito o falla. |
| `deposit` | Se deposita saldo a un usuario. |
| `marketListed` / `marketDelisted` / `marketBought` | Eventos del mercado. |
| `trade` | Se completa un intercambio entre dos usuarios. |
| `characterReleased` | Un usuario libera un personaje de su harem. |
| `characterAdded` / `characterUpdated` / `characterRemoved` | Cambios en el catálogo de personajes. |
| `usersCleaned` | Se ejecuta `cleanInactiveUsers()`. |
| `error` | Cualquier operación que lance una excepción. |

`kami.on()` devuelve una función para desuscribirte; también puedes usar `kami.off(evento, handler)` o `kami.once(evento, handler)`.

## ⏱️ Cooldowns / rate limiting

Configura cooldowns por acción al crear la instancia. Si no se especifica una acción, no tiene límite:

```js
const kami = new Kamijs({
  dbPath: "./database/gacha.db",
  cooldowns: {
    pull10: 3000,        // 3s entre pulls del mismo usuario
    useTicket: 1000,
    claimStarter: 0,     // sin límite
  },
});
```

Si un usuario excede el cooldown, el método correspondiente lanza un error `COOLDOWN_ACTIVE` con una propiedad `remainingMs` indicando cuánto falta:

```js
try {
  await kami.pull10(jid);
} catch (e) {
  if (e.message === "COOLDOWN_ACTIVE") {
    console.log(`Espera ${e.remainingMs}ms antes de volver a tirar.`);
  }
}
```

También puedes acceder al limitador directamente vía `kami.rateLimiter` (métodos `setCooldown`, `reset`, `clear`).

## 📚 API principal

| Método | Descripción |
|---|---|
| `init()` | Inicializa la base de datos y corre migraciones. |
| `close()` | Cierra la conexión a la base de datos. |
| `on(evento, handler)` / `once(evento, handler)` / `off(evento, handler)` | Suscripción a eventos. |
| `claimStarter(jid, charId, sock)` | Reclama el personaje inicial gratuito. |
| `pull10(jid, { sock, chatId, eventConfig })` | Realiza 10 tiradas de gacha. |
| `useTicket(jid, charId, sock)` | Usa un ticket para intentar obtener un personaje específico. |
| `addTickets(jid, amount, sock)` | Otorga tickets a un usuario. |
| `deposit(jid, amount, sock)` | Agrega saldo al usuario. |
| `getUser(jid, sock)` | Obtiene los datos de un usuario. |
| `getHarem(jid, sock)` | Lista los personajes que posee un usuario. |
| `getMarket(limit, offset)` | Lista publicaciones del mercado, paginado (`{ items, total, hasMore }`). |
| `listMarket(jid, charId, price, sock)` | Pone un personaje en venta. |
| `buyFromMarket(jid, marketId, sock)` | Compra un personaje del mercado. |
| `delistMarket(jid, marketId, sock)` | Retira una publicación del mercado. |
| `trade(fromJid, toJid, charId, sock)` | Intercambia un personaje entre dos usuarios. |
| `releaseCharacter(jid, charId, sock)` | Libera/elimina un personaje del harem. |
| `addCharacter(data)` | Agrega un nuevo personaje al pool. |
| `updateCharacter(charId, changes)` | Modifica campos de un personaje existente. |
| `removeCharacter(charId, { force })` | Elimina un personaje del catálogo. Lanza `CHARACTER_HAS_OWNERS` si alguien lo posee, salvo `force: true`. |
| `getCharacter(id)` / `getRandomCharacterBySeries(series)` | Consulta personajes puntuales. |
| `getSeriesCharacters(series)` | Lista personajes de una serie con sus dueños. |
| `searchCharacters(query, { limit, offset })` | Búsqueda parcial por nombre o serie, paginada. |
| `listCharacters({ limit, offset })` | Lista todo el catálogo, paginado. |
| `getBank()` / `withdrawBank(toJid, amount, sock)` | Consulta y retira del banco global. |
| `cleanInactiveUsers()` | Limpia usuarios inactivos (14+ días); su saldo vuelve al banco. |

> ⚠️ **Cambio importante (v5.1.0):** el orden de parámetros de `withdrawBank` cambió de `(amount, toJid, sock)` a `(toJid, amount, sock)`.

> `ImageProvider.getRandomUrl(tag)` también se exporta por separado si necesitas obtener una imagen de un personaje de forma manual.

## ✏️ CRUD de personajes

```js
const charId = await kami.addCharacter({ name: "Rem", series: "Re:Zero", gender: "F", global_limit: 1 });

await kami.updateCharacter(charId, { value: 5000, booru_tag: "rem_(re:zero)" });

// Si nadie lo posee, se elimina directamente.
// Si tiene dueños, lanza CHARACTER_HAS_OWNERS a menos que pases { force: true }.
await kami.removeCharacter(charId, { force: true });
```

## 🔍 Búsqueda y paginación

```js
const { items, total, hasMore } = await kami.searchCharacters("rem", { limit: 20, offset: 0 });
const { items: page2 } = await kami.searchCharacters("rem", { limit: 20, offset: 20 });

const market = await kami.getMarket(20, 0); // { items, total, limit, offset, hasMore }
```

## ⚖️ Sobre el pity y los repetidos (v5.2.0)

El contador de pity (`pity_count`) y la suerte acumulada (`luck`) **solo se resetean cuando obtienes un personaje nuevo** (uno que no estaba ya en tu harem ni en el de otro usuario). Si una tirada te da un personaje repetido o compensado, tu progreso de pity **se conserva** — no se "gasta" en repeticiones. Esto significa que rachas largas sin personajes nuevos disponibles en el pool acumulan pity de forma continua hasta el límite garantizado (`PITY_LIMIT_RW`).

## 🧱 Limitaciones conocidas

- **Punto único de serialización**: todas las transacciones (de todos los usuarios) pasan por una sola cola en memoria (`#txQueue`) y un único banco global. Esto evita corrupción de datos y funciona bien para un bot mediano, pero si escalas a muchos grupos/usuarios simultáneos con alto volumen, esa cola se vuelve un cuello de botella. Resolverlo implicaría partir el estado en shards (por ejemplo, por grupo o por rango de usuarios) o migrar a una base de datos con mejor soporte de escritura concurrente — es un cambio de arquitectura mayor, fuera del alcance de este ajuste.

## 🧪 Tests

```bash
npm install
npm test
```

La suite usa el runner nativo `node:test` (sin dependencias adicionales) y cubre: economía, CRUD de personajes, búsqueda/paginación, gacha (incluyendo el comportamiento de pity en repetidos), mercado, intercambios, cooldowns, eventos y concurrencia de transacciones.

## 🗂️ Estructura del proyecto

```
kamijs/
├── src/
│   ├── Kamijs.js              # Lógica principal del gacha y la economía
│   ├── core/
│   │   ├── ImageProvider.js   # Proveedor de imágenes con caché en memoria
│   │   ├── Logger.js          # Logger interno (niveles, scopes, sink configurable)
│   │   ├── EventBus.js        # Sistema de eventos/hooks
│   │   └── RateLimiter.js     # Cooldowns por acción/usuario
│   └── index.js               # Punto de entrada / exports
├── types/
│   └── index.d.ts             # Tipos para autocompletado en el editor
├── test/                      # Suite de tests (node:test)
├── assets/
│   └── banner.png             # 👈 reemplaza esto con tu propia imagen
├── package.json
└── LICENSE
```

## 📄 Licencia

Distribuido bajo licencia **MIT**. Ver [LICENSE](./LICENSE) para más detalles.

---

<p align="center">Hecho con 💜 para la comunidad de bots de WhatsApp</p>
