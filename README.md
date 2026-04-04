# ✨ kamijs

> Motor de Gacha con economía, trades, IA de Compasión y seguridad transaccional para bots de WhatsApp.

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
| 🛡️ **Transacciones Atómicas** | `BEGIN IMMEDIATE` + modo WAL en SQLite elimina race conditions en claims simultáneos |
| 🔄 **Sistema de Trades** | Intercambio de personajes entre usuarios con expiración automática (5 min) y verificación en transacción |
| 🖼️ **Imágenes Dinámicas** | Genera URLs aleatorias en tiempo real desde Yande.re usando tags de booru |
| ⏱️ **Cooldowns en Memoria** | Sistema de verificación y confirmación en dos pasos, sin escrituras en disco |
| 🧬 **LidGuard Integrado** | Normaliza automáticamente todos los JIDs para mantener la base de datos limpia |
| 💱 **Moneda Personalizable** | Configura el nombre de la moneda del juego (`yenes`, `coins`, `rubíes`, etc.) |
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

> **Requisito:** El socket de Baileys debe tener [LidSync](https://github.com/Neykoor/LidSync) aplicado antes de pasarlo a kamijs. Ver [sección de integración](#-integración-con-lidsync).

---

## 🚀 Inicio Rápido

### 1. Inicialización

```js
import { Kamijs } from 'kamijs';

const gacha = new Kamijs({
    dbPath: './database/gacha.db',
    jsonPath: './database/characters.json',
    currency: 'yenes'          // Nombre de la moneda (opcional, default: 'yenes')
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

    // CRÍTICO: Solo confirmar si el mensaje se envió con éxito
    gacha.confirmRoll(result.resolvedJid);

} catch (err) {
    console.error('[kamijs] Error de red, cooldown no aplicado.');
}
```

### 3. Claim (`#claim`)

```js
try {
    await gacha.claim(sock, m.sender, charId);
    reply('🎉 ¡Personaje reclamado con éxito!');

} catch (err) {
    if (err.message === 'ALREADY_CLAIMED') {
        await gacha.reportMissedClaim(sock, m.sender);
        reply('❌ Alguien fue más rápido que tú.');
    } else if (err.message === 'INSUFFICIENT_FUNDS') {
        reply('💸 No tienes suficiente saldo.');
    } else if (err.message === 'CHARACTER_NOT_FOUND') {
        reply('❓ Personaje no encontrado.');
    }
}
```

### 4. Trade (`#trade`)

```js
// Proponer un intercambio
const trade = await gacha.proposeTrade(sock, m.sender, targetJid, offeredCharId, requestedCharId);
if (trade.error === 'COOLDOWN') return reply(`⏳ Espera ${trade.remaining}s.`);

reply(`🔄 Trade *${trade.trade.id}* enviado. El destinatario tiene 5 minutos para confirmar.`);

// Confirmar (el destinatario)
await gacha.confirmTrade(sock, m.sender, tradeId);
reply('✅ ¡Trade completado!');

// Cancelar (cualquiera de los dos) — método síncrono
gacha.cancelTrade(sock, m.sender, tradeId);
reply('❌ Trade cancelado.');
```

### 5. Perfil de usuario (`#perfil`)

```js
const profile = await gacha.getUserProfile(sock, m.sender);
reply(
    `💼 *Perfil*\n` +
    `💰 Saldo: ${profile.balance} ${profile.currencyName}\n` +
    `🎴 Personajes: ${profile.characters.length}`
);
```

### 6. Agregar Personaje (`#addchar`)

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

### 7. Carga masiva (Seeder)

```js
const characters = [
    { id: 'marin-kitagawa', name: 'Marin Kitagawa', series: 'Sono Bisque Doll', gender: 'female', booru_tag: 'kitagawa_marin', value: 8000 },
    { id: 'wakana-gojo',    name: 'Wakana Gojo',    series: 'Sono Bisque Doll', gender: 'male',   booru_tag: 'gojou_wakana',   value: 3000 },
];

const added = await gacha.bulkAddCharacters(characters);
console.log(`${added} personajes nuevos cargados.`);
```

---

## 📚 Referencia de API

### `await gacha.init()`
Crea las tablas en SQLite, activa el modo WAL y genera `characters.json` si no existe. Debe llamarse una vez al arrancar el bot.

---

### `await gacha.roll(sock, jid)`
Ejecuta un roll del gacha para el usuario.

**Retorna:**
```js
{
    id: 'marin-kitagawa',
    name: 'Marin Kitagawa',
    series: 'Sono Bisque Doll',
    gender: 'female',
    value: 8000,
    currencyName: 'yenes',
    imageUrl: 'https://...',
    pityActive: false,
    resolvedJid: '521234567890@s.whatsapp.net'
}
```

**Errores:**
```js
{ error: 'COOLDOWN', remaining: 42 }
{ error: 'NOT_FOUND' }
```

---

### `gacha.confirmRoll(resolvedJid)`
Método **síncrono**. Aplica el cooldown al usuario. Debe llamarse **únicamente** después de que el mensaje se haya enviado exitosamente a WhatsApp.

---

### `await gacha.claim(sock, jid, charId)`
Intenta comprar un personaje. Usa `BEGIN IMMEDIATE` para garantizar atomicidad ante claims simultáneos.

**Retorna:** `{ success: true, characterValue, characterId }`

**Throws:**
- `CHARACTER_NOT_FOUND` — el personaje no existe
- `ALREADY_CLAIMED` — el personaje ya tiene dueño
- `INSUFFICIENT_FUNDS` — saldo insuficiente

---

### `await gacha.reportMissedClaim(sock, jid)`
Incrementa el `stress_level` del usuario en 1 (máximo 5). Llámalo cuando el usuario pierde un claim ante otro jugador para activar la IA de Compasión.

---

### `await gacha.getUserProfile(sock, jid)`
Obtiene el perfil completo del usuario.

**Retorna:**
```js
{
    balance: 12500,
    currencyName: 'yenes',
    characters: [
        { id: 'marin-kitagawa', name: 'Marin Kitagawa', series: 'Sono Bisque Doll', value: 8000 },
        ...
    ]
}
```

---

### `await gacha.proposeTrade(sock, proposerJid, targetJid, offeredCharId, requestedCharId)`
Crea una propuesta de intercambio entre dos usuarios. El trade expira automáticamente en **5 minutos**.

**Retorna:** `{ success: true, trade: { id, proposerJid, targetJid, offeredCharId, requestedCharId, expiresAt } }`

**Throws:**
- `SELF_TRADE` — el usuario intenta hacer trade consigo mismo
- `OFFERED_CHAR_NOT_OWNED` — el personaje ofrecido no pertenece al proponente
- `REQUESTED_CHAR_NOT_OWNED` — el personaje solicitado no pertenece al destinatario

> ⚠️ Los trades activos se almacenan en memoria. Si el bot se reinicia, los trades pendientes se pierden.

---

### `await gacha.confirmTrade(sock, targetJid, tradeId)`
El destinatario confirma el trade. Ejecuta el intercambio en una transacción atómica con verificación de propiedad al momento de confirmar.

**Throws:**
- `TRADE_NOT_FOUND_OR_EXPIRED`
- `UNAUTHORIZED_CONFIRMATION`
- `OWNERSHIP_CHANGED_DURING_TRADE` — algún personaje cambió de dueño mientras el trade estaba pendiente

---

### `gacha.cancelTrade(sock, jid, tradeId)`
Método **síncrono**. Cancela un trade activo. Puede ser llamado por cualquiera de los dos participantes.

---

### `await gacha.addCharacter(data)`
Añade un personaje a SQLite y lo respalda en `characters.json`. Si el personaje ya existe, lo ignora silenciosamente.

| Campo | Tipo | Requerido | Default |
|---|---|---|---|
| `id` | string | ✅ | — |
| `name` | string | ✅ | — |
| `series` | string | ✅ | — |
| `gender` | string | ✅ | — |
| `booru_tag` | string | ✅ | — |
| `value` | number | ❌ | `3000` |

> ⚠️ Este método reescribe el JSON completo en cada llamada. Para importaciones masivas usa `bulkAddCharacters()`.

---

### `await gacha.bulkAddCharacters(dataArray)`
Carga un array de personajes en una sola transacción SQL y escribe el JSON una sola vez al finalizar. Personajes con campos faltantes se omiten con un warning, sin abortar el proceso.

**Retorna:** `number` — cantidad de personajes nuevos insertados.

```js
const added = await gacha.bulkAddCharacters(characters);
// → 47 (personajes nuevos, los duplicados se ignoran)
```

---

### `await gacha.voteCharacter(charId)`
Incrementa en 1 el contador de votos de un personaje.

**Throws:** `CHARACTER_NOT_FOUND`

---

### `await gacha.getTopCharacters(limit?)`
Retorna los personajes con más votos ordenados descendentemente.

**Parámetros:** `limit` (default: `10`)

**Retorna:**
```js
[
    { id: 'marin-kitagawa', name: 'Marin Kitagawa', series: 'Sono Bisque Doll', gender: 'female', votes: 142 },
    ...
]
```

---

## 🗄️ Estructura de Base de Datos

### `characters`
| Campo | Tipo | Descripción |
|---|---|---|
| `id` | TEXT PK | Identificador único |
| `name` | TEXT | Nombre del personaje |
| `series` | TEXT | Serie o franquicia |
| `gender` | TEXT | Género |
| `booru_tag` | TEXT | Tag para búsqueda en Yande.re |
| `value` | INTEGER | Precio (default: 3000) |
| `owner_id` | TEXT | JID del dueño (`NULL` si libre) |
| `votes` | INTEGER | Votos de popularidad |

### `users`
| Campo | Tipo | Descripción |
|---|---|---|
| `jid` | TEXT PK | JID normalizado |
| `balance` | INTEGER | Saldo actual (default: 0) |
| `stress_level` | INTEGER | Nivel de estrés 0–5 |
| `last_interaction` | INTEGER | Timestamp de la última acción |

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

El Mercy System de kamijs no es un pity de rareza clásico. Es un **pity de disponibilidad y billetera**.

1. Cada vez que un usuario pierde un claim, su `stress_level` sube (`reportMissedClaim`).
2. Con estrés ≥ 3, la IA tiene un **40% de probabilidad** de intervenir en el próximo roll.
3. Cuando interviene, el roll filtra solo personajes **libres** con `value ≤ saldo del usuario`.
4. Si el pity no encuentra personajes asequibles, hace fallback a un roll normal.
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

    const gacha = new Kamijs({
        dbPath: './database/gacha.db',
        currency: 'yenes'
    });
    await gacha.init();
}
```

---

## ⚠️ Consideraciones

- **Socket requerido:** Todos los métodos con `jid` requieren `sock` para resolver LIDs vía LidSync.
- **Trades en memoria:** Los trades pendientes se pierden si el proceso se reinicia.
- **Imágenes dinámicas:** El mismo personaje puede mostrar imagen diferente en cada roll. Es intencional.
- **`addCharacter` vs `bulkAddCharacters`:** Para un personaje usa `addCharacter`. Para carga masiva usa `bulkAddCharacters`.

---

## 📄 Licencia

MIT — [Neykoor](https://github.com/Neykoor)
