# ✨ kamijs

> Motor de Gacha con economía, mercado, trades, IA de Compasión y seguridad transaccional para bots de WhatsApp.

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green?style=flat-square&logo=node.js)](https://nodejs.org)
[![SQLite](https://img.shields.io/badge/SQLite-WAL-blue?style=flat-square&logo=sqlite)](https://sqlite.org)
[![LidSync](https://img.shields.io/badge/LidSync-integrado-purple?style=flat-square)](https://github.com/Neykoor/LidSync)
[![npm](https://img.shields.io/badge/npm-próximamente-lightgrey?style=flat-square&logo=npm)](https://github.com/Neykoor/kamijs)
[![License](https://img.shields.io/badge/Licencia-MIT-yellow?style=flat-square)](LICENSE)

**kamijs** es una librería modular y de alto rendimiento diseñada para implementar sistemas Gacha con economía y mercado abierto en bots de WhatsApp basados en [Baileys](https://github.com/WhiskeySockets/Baileys). Cuenta con transacciones seguras en SQLite (modo WAL), un sistema de IA de Compasión (Pity Adaptativo), trades entre usuarios y normalización automática de JIDs mediante [LidSync](https://github.com/Neykoor/LidSync).

---

## ✨ Características

| Característica | Descripción |
|---|---|
| 🧠 **IA de Compasión** | Evalúa el estrés del usuario y su saldo para inclinar sutilmente la balanza en rolls futuros |
| 🛡️ **Transacciones Atómicas** | `BEGIN IMMEDIATE` + modo WAL elimina race conditions en claims y compras simultáneas |
| 🔄 **Sistema de Trades** | Intercambio de personajes con expiración automática (5 min) y verificación de propiedad en transacción |
| 🏪 **Mercado Abierto** | Listado, compra y retiro de personajes con detección de ambigüedad por nombre |
| 🖼️ **Imágenes Dinámicas** | URLs aleatorias en tiempo real desde Yande.re usando tags de booru |
| ⏱️ **Cooldowns en Memoria** | Sistema de verificación y confirmación en dos pasos, sin escrituras en disco |
| 🧬 **LidGuard Integrado** | Normaliza automáticamente todos los JIDs incluyendo sufijos de dispositivo (`:0`, `:1`) |
| 💱 **Moneda Personalizable** | Configura el nombre de la moneda (`yenes`, `coins`, `rubíes`, etc.) |
| 💬 **Mensaje de Claim Personalizado** | Cada usuario puede definir su propio texto de captura con variables dinámicas |
| 📦 **Carga Masiva** | `bulkAddCharacters()` carga miles de personajes en una sola transacción SQL |

---

## 📦 Instalación

```bash
npm install git+https://github.com/Neykoor/kamijs.git
```

O agrega manualmente a tu `package.json`:

```json
"dependencies": {
  "kamijs": "git+https://github.com/Neykoor/kamijs.git",
  "lidsync": "git+https://github.com/Neykoor/LidSync.git",
  "sqlite3": "^5.1.7",
  "sqlite": "^5.1.1"
}
```

> **Requisito:** El socket de Baileys debe tener [LidSync](https://github.com/Neykoor/LidSync) aplicado antes de pasarlo a kamijs.

---

## 🚀 Inicio Rápido

### 1. Inicialización

```js
import { Kamijs } from 'kamijs';

const gacha = new Kamijs({
    dbPath: './database/gacha.db',
    jsonPath: './database/characters.json',
    currency: 'yenes'
});

await gacha.init();
```

### 2. Roll (`#rw`)

```js
const result = await gacha.roll(sock, m.sender);

if (result.error === 'COOLDOWN') return reply(`⏳ Espera ${result.remaining}s.`);
if (result.error === 'NOT_FOUND') return reply(`❌ No hay personajes disponibles.`);

try {
    await sock.sendMessage(m.chat, {
        image: { url: result.imageUrl },
        caption: `🌟 *${result.name}*\n📺 ${result.series}\n💰 ${result.value} ${result.currencyName}`
    });
    gacha.confirmRoll(result.resolvedJid); // Solo confirmar si el envío fue exitoso
} catch (err) {
    console.error('[kamijs] Error de red, cooldown no aplicado.');
}
```

### 3. Claim (`#claim`)

```js
try {
    const result = await gacha.claim(sock, m.sender, charName);
    reply(result.customMsg || '🎉 ¡Personaje reclamado!');
} catch (err) {
    if (err.message === 'ALREADY_CLAIMED') {
        await gacha.reportMissedClaim(sock, m.sender);
        reply('❌ Alguien fue más rápido.');
    } else if (err.message === 'INSUFFICIENT_FUNDS') {
        reply('💸 No tienes suficiente saldo.');
    }
}
```

### 4. Mercado (`#market`, `#sell`, `#buy`)

```js
// Ver el mercado (paginado)
const market = await gacha.getMarketplace(page, 10);
reply(market.items.map(c => `[${c.id}] ${c.name} — ${c.market_price}¥`).join('\n'));

// Poner en venta
await gacha.listCharacter(sock, m.sender, 'Marin Kitagawa', 5000);

// Comprar
try {
    const result = await gacha.buyCharacter(sock, m.sender, 'Marin Kitagawa');
    reply(`✅ Compraste a ${result.charName} por ${result.price}¥`);
} catch (err) {
    if (err.message.startsWith('AMBIGUOUS_BUY')) {
        reply(`Hay varias en venta, elige por ID:\n${err.message.replace('AMBIGUOUS_BUY:\n', '')}`);
    }
}
```

### 5. Trade (`#trade`)

```js
const trade = await gacha.proposeTrade(sock, m.sender, targetJid, 'Marin', 'Sakura');
reply(`🔄 Trade *${trade.trade.id}* enviado. 5 minutos para confirmar.`);

await gacha.confirmTrade(sock, m.sender, tradeId);
gacha.cancelTrade(sock, m.sender, tradeId);
```

### 6. Agregar personaje (`#addchar`)

```js
await gacha.addCharacter({
    id: 'marin-kitagawa',
    name: 'Marin Kitagawa',
    series: 'Sono Bisque Doll',
    gender: 'female',
    booru_tag: 'kitagawa_marin',
    value: 8000
});
```

---

## 📚 Referencia de API

### 🎲 Núcleo del juego

#### `await gacha.roll(sock, jid)`
Ejecuta un roll para el usuario. Activa el análisis de la IA de Compasión automáticamente.

**Retorna:**
```js
{
    id, name, series, gender, value,
    currencyName: 'yenes',
    imageUrl: 'https://...',
    pityActive: false,
    resolvedJid: '521234567890@s.whatsapp.net'
}
```
**Errores:** `{ error: 'COOLDOWN', remaining: 42 }` · `{ error: 'NOT_FOUND' }`

---

#### `gacha.confirmRoll(resolvedJid)`
**Síncrono.** Aplica el cooldown. Llamar **solo** después de enviar el mensaje exitosamente.

---

#### `await gacha.claim(sock, jid, query)`
Compra un personaje. Acepta nombre o ID como `query`.

**Retorna:** `{ success: true, characterValue, characterId, customMsg }`

**Throws:** `CHARACTER_NOT_FOUND_OR_CLAIMED` · `ALREADY_CLAIMED` · `INSUFFICIENT_FUNDS` · `AMBIGUOUS_QUERY:\n[lista de IDs]`

---

#### `await gacha.reportMissedClaim(sock, jid)`
Sube el `stress_level` en 1 (máx 5) cuando el usuario pierde un claim.

---

### 💰 Economía

#### `await gacha.addBalance(sock, jid, amount)`
Añade saldo al usuario. Crea el usuario si no existe.

---

#### `await gacha.setClaimMsg(sock, jid, message)`
Define el mensaje personalizado que aparece cuando el usuario reclama un personaje.

- **Límite sugerido:** 150-200 caracteres
- **Variables disponibles:** `{{user}}` (número del reclamante), `{{char}}` (nombre del personaje)
- Si no se define, el bot usa el mensaje predeterminado

```js
await gacha.setClaimMsg(sock, m.sender, '¡{{char}} es mía ahora, @{{user}}! 💖');
```

---

### 🏪 Mercado

#### `await gacha.getMarketplace(page?, limit?)`
Lista los personajes en venta ordenados por precio ascendente.

**Retorna:** `{ items, totalPages, currentPage, totalItems }`

---

#### `await gacha.listCharacter(sock, jid, query, price)`
Pone un personaje en venta. Valida propiedad con doble capa de seguridad.

**Throws:** `INVALID_PRICE` · `CHARACTER_NOT_FOUND` · `NOT_OWNER_OR_NOT_FOUND`

---

#### `await gacha.buyCharacter(sock, jid, query)`
Compra un personaje del mercado. Si hay varios con el mismo nombre, lanza `AMBIGUOUS_BUY` con la lista de IDs para elegir.

**Throws:** `NOT_FOR_SALE` · `AMBIGUOUS_BUY:\n[lista]` · `ALREADY_SOLD_OR_WITHDRAWN` · `ALREADY_OWNED_BY_YOU` · `INSUFFICIENT_FUNDS`

---

### 🎒 Gestión del Harem

#### `await gacha.withdrawCharacter(sock, jid, query)`
Retira un personaje del mercado sin liberarlo. Útil para cambiar el precio.

> 🛡️ Doble capa de seguridad: valida propiedad en `#resolveCharacter` y en el `UPDATE AND owner_id = ?`.

---

#### `await gacha.deleteClaim(sock, jid, query)`
Libera un personaje de vuelta al pool (disponible para rolls futuros).

> 🛡️ Doble capa de seguridad: igual que `withdrawCharacter`.

---

#### `await gacha.giveCharacter(sock, fromJid, toJid, query)`
Regala un personaje específico a otro usuario.

**Throws:** `CANNOT_GIVE_TO_SELF` · `CHARACTER_NOT_FOUND` · `TRANSFER_FAILED`

---

#### `await gacha.giveAllHarem(sock, fromJid, toJid)`
Transfiere toda la colección en una sola transacción atómica.

**Throws:** `CANNOT_GIVE_TO_SELF` · `EMPTY_HAREM`

---

### 🔄 Trades

#### `await gacha.proposeTrade(sock, fromJid, toJid, offeredQuery, requestedQuery)`
Propone un intercambio. Expira en **5 minutos**. Los trades activos se almacenan en memoria.

**Retorna:** `{ success: true, trade: { id, ... }, offeredRealName, requestedRealName }`

**Throws:** `SELF_TRADE` · `OFFERED_CHAR_NOT_OWNED` · `REQUESTED_CHAR_NOT_OWNED`

> ⚠️ Si el bot se reinicia, los trades pendientes se pierden.

---

#### `await gacha.confirmTrade(sock, targetJid, tradeId)`
Confirma el trade. Verifica propiedad en transacción al momento de ejecutar.

**Throws:** `TRADE_NOT_FOUND_OR_EXPIRED` · `UNAUTHORIZED_CONFIRMATION` · `OWNERSHIP_CHANGED_DURING_TRADE`

---

#### `gacha.cancelTrade(sock, jid, tradeId)`
**Síncrono.** Cancela un trade activo. Puede ser llamado por cualquiera de los dos participantes.

---

### 📊 Información y Rankings

#### `await gacha.getCharacterInfo(query)`
Ficha completa del personaje con imagen dinámica y tag del dueño si tiene.

**Retorna:** `{ id, name, series, gender, value, votes, owner_id, ownerTag, imageUrl, ... }`

---

#### `await gacha.getUserProfile(sock, jid)`
Perfil del usuario con colección, saldo y cooldowns activos.

**Retorna:**
```js
{
    balance: 12500,
    currencyName: 'yenes',
    characters: [{ id, name, series, value }, ...],
    cooldowns: { roll: 0, vote: 42 }  // segundos restantes, 0 = disponible
}
```

---

#### `await gacha.getSeriesInfo(seriesName)`
Estadísticas de una serie: total de personajes y cuántos están reclamados.

---

#### `await gacha.listSeries(page?, limit?)`
Lista paginada de todas las series disponibles en la DB.

---

#### `await gacha.getTopWaifus(limit?)`
Top de personajes ordenados por votos descendentes.

---

#### `await gacha.voteCharacter(sock, jid, query)`
Vota por un personaje. Cooldown de **1 hora** por usuario.

**Retorna:** `{ name, newVotes }`

---

#### `await gacha.getCharacterImage(query?)`
Obtiene una imagen dinámica. Sin `query`, elige un personaje aleatorio de la DB.

---

#### `await gacha.getRandomAvailable()`
Retorna un personaje libre al azar (sin dueño).

---

### 🛠️ Admin

#### `await gacha.addCharacter(data)`

| Campo | Tipo | Requerido | Default |
|---|---|---|---|
| `id` | string | ❌ | auto-generado |
| `name` | string | ✅ | — |
| `series` | string | ✅ | — |
| `gender` | string | ✅ | — |
| `booru_tag` | string | ✅ | — |
| `value` | number | ❌ | `3000` |

> ⚠️ Reescribe el JSON completo en cada llamada. Para carga masiva usa `bulkAddCharacters()`.

---

#### `await gacha.bulkAddCharacters(dataArray)`
Carga masiva en una sola transacción. Personajes con campos faltantes se omiten con warning.

**Retorna:** `number` — cantidad de personajes nuevos insertados.

---

## 🗄️ Estructura de Base de Datos

### `characters`
| Campo | Tipo | Descripción |
|---|---|---|
| `id` | TEXT PK | Identificador único (auto-generado si no se provee) |
| `name` | TEXT | Nombre del personaje |
| `series` | TEXT | Serie o franquicia |
| `gender` | TEXT | Género |
| `booru_tag` | TEXT | Tag para búsqueda en Yande.re |
| `value` | INTEGER | Precio base (default: 3000) |
| `owner_id` | TEXT | JID del dueño (`NULL` si libre) |
| `votes` | INTEGER | Votos de popularidad |
| `market_price` | INTEGER | Precio en el mercado (`NULL` si no está en venta) |

### `users`
| Campo | Tipo | Descripción |
|---|---|---|
| `jid` | TEXT PK | JID normalizado |
| `balance` | INTEGER | Saldo actual |
| `stress_level` | INTEGER | Nivel de estrés 0–5 (IA de Compasión) |
| `last_interaction` | INTEGER | Timestamp del último roll |
| `claim_msg` | TEXT | Mensaje personalizado de captura |

### `trade_history`
| Campo | Tipo | Descripción |
|---|---|---|
| `id` | TEXT PK | ID del trade |
| `proposer_jid` | TEXT | JID del proponente |
| `target_jid` | TEXT | JID del destinatario |
| `offered_char` | TEXT | ID del personaje ofrecido |
| `requested_char` | TEXT | ID del personaje solicitado |
| `timestamp` | INTEGER | Fecha de ejecución |

---

## 🧠 IA de Compasión

El Mercy System de kamijs es un **pity de disponibilidad y billetera**, no de rareza.

1. Cada claim perdido sube `stress_level` en 1 via `reportMissedClaim`.
2. Con estrés ≥ 3, la IA tiene **40% de probabilidad** de intervenir en el próximo roll.
3. Cuando interviene, filtra solo personajes **libres** con `value ≤ saldo del usuario`.
4. Si no encuentra personajes asequibles, hace fallback a roll normal.
5. El estrés **decae naturalmente**: cada 2 horas de inactividad baja 1 punto.

---

## 🔗 Integración con LidSync

```js
import { connectToWhatsApp } from './connection.js';
import { pluginLid } from 'lidsync';
import store from './lib/store.js';
import { Kamijs } from 'kamijs';

async function start() {
    let sock = await connectToWhatsApp();
    store.bind(sock.ev);
    sock = pluginLid(sock, { store });

    const gacha = new Kamijs({ dbPath: './database/gacha.db', currency: 'yenes' });
    await gacha.init();
}
```

---

## ⚠️ Consideraciones

- **Socket requerido:** Todos los métodos con `jid` requieren `sock` para resolver LIDs vía LidSync.
- **Trades en memoria:** Los trades pendientes se pierden si el proceso se reinicia.
- **Imágenes dinámicas:** El mismo personaje puede mostrar imagen diferente en cada aparición. Es intencional.
- **Seguridad de operaciones:** `withdrawCharacter`, `deleteClaim`, `listCharacter` y `giveCharacter` tienen doble capa de validación de propiedad — en `#resolveCharacter` y en el `UPDATE AND owner_id = ?`.
- **`addCharacter` vs `bulkAddCharacters`:** Para un personaje usa `addCharacter`. Para carga masiva usa `bulkAddCharacters`.

---

## 📄 Licencia

MIT — [Neykoor](https://github.com/Neykoor)
