<p align="center">
  <img src="./assets/banner.png" alt="kamijs banner" width="100%" />
</p>

<h1 align="center">Kamijs</h1>

<p align="center">
  <b>Motor de gacha de personajes para bots de WhatsApp (Baileys)</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-5.5.0-blue.svg" alt="version" />
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
- 🎟️ **Sistema de tickets** con tasa de éxito configurable (por defecto 30%).
- 🖼️ **Proveedor de imágenes** integrado (yande.re) con filtro de contenido (rating + tags prohibidos), detección de género por tags, fallback al tag base cuando hay pocos resultados, deduplicación de peticiones concurrentes (`#inflight`) y caché en memoria con auto-limpieza (TTL de 5 min).
- 🗄️ **Migraciones automáticas** de base de datos al iniciar.
- 🧹 **Limpieza de usuarios inactivos** que devuelve su saldo al banco en vez de borrarlo.
- 📊 **Seguimiento de progreso genver** (`getGenverProgress` / `setGenverProgress` / `resetGenverProgress`).
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
  ticketSuccessRate: 0.30,       // probabilidad de éxito del ticket (0-1, opcional)
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

Los niveles numéricos están exportados como `LOG_LEVELS`:

```js
import { LOG_LEVELS } from "kamijs";
// LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 }
```

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
| `getGenverProgress(series)` | Obtiene el progreso de generación de personajes para una serie. |
| `setGenverProgress(series, done, added)` | Actualiza el progreso de generación de una serie. |
| `resetGenverProgress(series)` | Borra el registro de progreso de una serie. |

> ⚠️ **Cambio importante (v5.1.0):** el orden de parámetros de `withdrawBank` cambió de `(amount, toJid, sock)` a `(toJid, amount, sock)`.

> `ImageProvider.getRandomUrl(tag)` también se exporta por separado si necesitas obtener una imagen de un personaje de forma manual. `ImageProvider.getRandomPost(tag)` devuelve el post completo (`id`, `url`, `file_url`, `sample_url`, `jpeg_url`, `tags`, `rating`, `score`, `author`, `source`, `width`, `height`, `gender`) en lugar de solo la URL. `ImageProvider.clearCache()` vacía la caché y las peticiones en curso manualmente. `LOG_LEVELS` también se exporta para consultar los valores numéricos de severidad.

## ✏️ CRUD de personajes

```js
const charId = await kami.addCharacter({ name: "Rem", series: "Re:Zero", gender: "F", global_limit: 1 });

await kami.updateCharacter(charId, { value: 5000, booru_tag: "rem_(re:zero)" });

// Si nadie lo posee, se elimina directamente.
// Si tiene dueños, lanza CHARACTER_HAS_OWNERS a menos que pases { force: true }.
await kami.removeCharacter(charId, { force: true });
```

> **Nota sobre `booru_tag`:** si no se especifica al crear un personaje, queda como `null` y el `pull10` no intentará buscar imagen para ese personaje. Asígnalo explícitamente si quieres imágenes (ej. `"rem_(re:zero)"`).

## 📊 Progreso de generación (genver)

La tabla `genver_progress` permite que tu bot lleve el estado de procesos de carga masiva de personajes (como el comando `.genchar` de Eris-MD) entre reinicios:

```js
// Guardar progreso
await kami.setGenverProgress("Re:Zero", 45, 23); // 45 procesados, 23 añadidos

// Consultar progreso
const prog = await kami.getGenverProgress("Re:Zero");
// → { series: "Re:Zero", done: 45, added: 23 } o null si no existe

// Limpiar tras completar
await kami.resetGenverProgress("Re:Zero");
```

## 🔍 Búsqueda y paginación

```js
const { items, total, hasMore } = await kami.searchCharacters("rem", { limit: 20, offset: 0 });
const { items: page2 } = await kami.searchCharacters("rem", { limit: 20, offset: 20 });

const market = await kami.getMarket(20, 0); // { items, total, limit, offset, hasMore }
```

## ⚖️ Sobre el pity y los repetidos (v5.2.0)

El contador de pity (`pity_count`) y la suerte acumulada (`luck`) **solo se resetean cuando obtienes un personaje nuevo** (uno que no estaba ya en tu harem ni en el de otro usuario). Si una tirada te da un personaje repetido o compensado, tu progreso de pity **se conserva** — no se "gasta" en repeticiones. Esto significa que rachas largas sin personajes nuevos disponibles en el pool acumulan pity de forma continua hasta el límite garantizado (`PITY_LIMIT_RW = 100`).

## 🧱 Limitaciones conocidas

- **Punto único de serialización**: todas las transacciones (de todos los usuarios) pasan por una sola cola en memoria (`#txQueue`) y un único banco global. Esto evita corrupción de datos y funciona bien para un bot mediano, pero si escalas a muchos grupos/usuarios simultáneos con alto volumen, esa cola se vuelve un cuello de botella. Resolverlo implicaría partir el estado en shards o migrar a una base de datos con mejor soporte de escritura concurrente.

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

## 📋 Changelog

### v5.5.0
- **Reescritura (ImageProvider):** arquitectura alineada con `konachan-scraper` — pool de resultados con fallback automático al tag base (ej. `rem_(re:zero)` → `rem` si el tag completo trae menos de 3 resultados), en lugar del waterfall con early-exit anterior.
- **Mejora (ImageProvider):** lista de tags prohibidos ampliada con `child`, `toddler` e `infant`.
- **Mejora (ImageProvider):** rating permitido ahora se valida contra un `Set` explícito (`s`, `q`) en vez de inferirse solo de los tags.
- **Nuevo (ImageProvider):** `getRandomPost(tag)` — devuelve el post completo con metadata (id, urls, tags, rating, score, autor, fuente, dimensiones) y género detectado por tags (`female` / `male` / `mixed` / `unknown`).
- **Nuevo (ImageProvider):** `clearCache()` — permite vaciar la caché y las peticiones en curso manualmente.

### v5.4.0
- **Perf (ImageProvider):** añadido mapa `#inflight` para deduplicar fetches concurrentes al mismo tag — si 10 personajes del mismo pull comparten tag, se hace **1 sola** petición HTTP en lugar de 10.
- **Perf (ImageProvider):** `#fetchBestFor` cambiado de `Promise.allSettled` (3 fetches siempre) a waterfall con early-exit — en el caso mayoritario se hace **1 fetch** en lugar de 3.
- **Perf (pull10):** `available` ahora es un array con swap-and-pop O(1) en lugar de `Array.filter` O(n) en cada hit del loop — con 1 000 personajes pasa de ~10 000 iteraciones a ~10.
- **Perf (pull10):** `#getPoolSnapshot` y la query `myOwnedIds` se ejecutan en **paralelo** (`Promise.all`).
- **Perf (pull10):** deduplicación de `booru_tag` en la fase de imágenes — varios chars con el mismo tag hacen una sola llamada a `ImageProvider`.
- **Perf (getPoolSnapshot):** eliminada la correlated subquery por fila para `other_owner`; reemplazada por un LEFT JOIN con subquery derivada — un solo scan de `claims` en lugar de N.
- **Perf (searchCharacters / listCharacters / getMarket):** queries de items y COUNT ejecutadas en paralelo con `Promise.all`.
- **Perf (cleanInactiveUsers):** los tres `DELETE` ahora usan un CTE compartido para evaluar la lista de JIDs inactivos una sola vez.
- **Perf (SQLite):** `cache_size` aumentado a 16 MB, añadidos `mmap_size = 128 MB` y `temp_store = MEMORY`.
- **Perf (SQLite):** nuevos índices compuestos `idx_claims_owner_char`, `idx_market_char_seller` e `idx_claims_char_at` para acelerar lookups frecuentes.

### v5.3.0
- **Bugfix:** la subquery `other_owner` en el snapshot del pool ahora usa `ORDER BY claimed_at ASC` para devolver siempre el primer dueño en reclamar, no uno arbitrario.
- **Bugfix:** la migración v2 ya no resetea a 1 personajes con `global_limit > 1` válido. Solo corrige `NULL`.
- **Bugfix:** `deposit`, `addTickets` y `withdrawBank` ahora inicializan `last_active` al crear usuarios nuevos, evitando "usuarios zombie" que escapaban a `cleanInactiveUsers`.
- **Bugfix:** `addCharacter` ya no usaba el nombre del personaje como `booru_tag` de respaldo; el campo queda `null` si no se especifica, previniendo búsquedas de imagen incorrectas.
- **Mejora:** `ticketSuccessRate` ahora es configurable en el constructor (por defecto `0.30`).
- **Mejora:** se exponen los métodos `getGenverProgress`, `setGenverProgress` y `resetGenverProgress` para gestionar la tabla `genver_progress` que ya existía en el schema sin API pública.
- **Mejora:** `LOG_LEVELS` ahora se exporta correctamente desde `src/index.js`.
- **Mejora:** `KAMIJS_EVENTS` declarado como `Readonly<...>` en los tipos TypeScript.
- **Mejora:** `GenverProgress` añadido al archivo de tipos.

### v5.2.0
- Pity y luck solo se resetean al obtener un personaje nuevo (no en repetidos).

### v5.1.0
- Orden de parámetros de `withdrawBank` cambiado a `(toJid, amount, sock)`.

## 📄 Licencia

Distribuido bajo licencia **MIT**. Ver [LICENSE](./LICENSE) para más detalles.

---

<p align="center">Hecho con 💜 para la comunidad de bots de WhatsApp</p>
