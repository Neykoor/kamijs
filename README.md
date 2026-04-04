# ✨ kamijs

> Motor de Gacha con economía, IA de Compasión y seguridad transaccional para bots de WhatsApp.

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green?style=flat-square&logo=node.js)](https://nodejs.org)
[![SQLite](https://img.shields.io/badge/SQLite-3-blue?style=flat-square&logo=sqlite)](https://sqlite.org)
[![LidSync](https://img.shields.io/badge/LidSync-integrado-purple?style=flat-square)](https://github.com/Neykoor/LidSync)
[![License](https://img.shields.io/badge/Licencia-MIT-yellow?style=flat-square)](LICENSE)

**kamijs** es una librería modular y de alto rendimiento diseñada para implementar sistemas Gacha con economía y mercado abierto en bots de WhatsApp basados en [Baileys](https://github.com/WhiskeySockets/Baileys). Cuenta con transacciones seguras en SQLite, un sistema de IA de Compasión (Pity Adaptativo) y prevención nativa de duplicidad de usuarios mediante [LidSync](https://github.com/Neykoor/LidSync).

---

## ✨ Características

| Característica | Descripción |
|---|---|
| 🧠 **IA de Compasión** | Evalúa el estrés del usuario y su billetera para inclinar sutilmente la balanza en rolls futuros |
| 🛡️ **Transacciones Atómicas** | `BEGIN IMMEDIATE` en SQLite elimina race conditions en claims simultáneos |
| 🖼️ **Imágenes Dinámicas** | Genera URLs aleatorias en tiempo real desde Yande.re usando tags de booru |
| ⏱️ **Cooldowns en Memoria** | Sistema de verificación y confirmación en dos pasos, sin escrituras en disco |
| 🧬 **LidGuard Integrado** | Normaliza automáticamente todos los JIDs para mantener la base de datos limpia |

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

> **Requisito:** El socket de Baileys debe tener [LidSync](https://github.com/Neykoor/LidSync) aplicado antes de pasarlo a kamijs. Ver sección de integración.

---

## 🚀 Inicio Rápido

### 1. Inicialización

```js
import { Kamijs } from 'kamijs';

const gacha = new Kamijs({
    dbPath: './database/gacha.db',
    jsonPath: './database/characters.json'
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
        caption: `🌟 *${result.name}*\n💰 ${result.value} Yenes`
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
        reply('💸 No tienes suficientes Yenes.');
    }
}
```

### 4. Agregar Personaje (`#addchar`)

```js
await gacha.addCharacter({
    id: 'char_001',
    name: 'Marin Kitagawa',
    series: 'Sono Bisque Doll',
    gender: 'female',
    booru_tag: 'kitagawa_marin',
    value: 3500
});
```

---

## 📚 Referencia de API

### `await gacha.init()`
Crea las tablas en SQLite y el archivo `characters.json` si no existen. Debe llamarse una vez al arrancar el bot.

---

### `await gacha.roll(sock, jid)`
Ejecuta un roll del gacha para el usuario.

**Retorna:**
```js
{
    id: 'char_001',
    name: 'Marin Kitagawa',
    value: 3500,
    imageUrl: 'https://...',
    pityActive: false,
    resolvedJid: '521234567890@s.whatsapp.net'
}
```

**Errores:**
```js
{ error: 'COOLDOWN', remaining: 42 }  // segundos restantes
{ error: 'NOT_FOUND' }                // pool vacío
```

---

### `gacha.confirmRoll(resolvedJid)`
Método **síncrono**. Aplica el cooldown al usuario. Debe llamarse **únicamente** después de que el mensaje se haya enviado con éxito a WhatsApp.

---

### `await gacha.claim(sock, jid, charId)`
Intenta comprar un personaje. Usa `BEGIN IMMEDIATE` para garantizar que no haya dos claims simultáneos del mismo personaje.

**Throws:**
- `ALREADY_CLAIMED` — el personaje ya tiene dueño
- `INSUFFICIENT_FUNDS` — el usuario no tiene saldo suficiente

---

### `await gacha.reportMissedClaim(sock, jid)`
Incrementa el `stress_level` del usuario en 1 (máximo 5). Debe llamarse cuando el usuario pierde un claim ante otro jugador, para que la IA de Compasión lo detecte en el próximo roll.

---

### `await gacha.addCharacter(data)`
Añade un personaje a SQLite y lo respalda en `characters.json`.

| Campo | Tipo | Requerido | Default |
|---|---|---|---|
| `id` | string | ✅ | — |
| `name` | string | ✅ | — |
| `series` | string | ✅ | — |
| `gender` | string | ✅ | — |
| `booru_tag` | string | ✅ | — |
| `value` | number | ❌ | `3000` |

> ⚠️ Este método reescribe el JSON completo en cada llamada. Para importaciones masivas, usa `bulkImport()`.

---

### `await gacha.bulkImport(characters[])` *(próximamente)*
Método optimizado para cargar miles de personajes en una sola transacción SQL, sin reescribir el JSON en cada inserción. Ideal para migrar catálogos existentes.

---

## 🗄️ Estructura de Base de Datos

### `characters`
| Campo | Tipo | Descripción |
|---|---|---|
| `id` | TEXT PK | Identificador único del personaje |
| `name` | TEXT | Nombre del personaje |
| `series` | TEXT | Serie o franquicia |
| `gender` | TEXT | Género |
| `booru_tag` | TEXT | Tag para búsqueda en Yande.re |
| `value` | INTEGER | Precio en Yenes (default: 3000) |
| `owner_id` | TEXT | JID del dueño actual (`NULL` si está libre) |
| `votes` | INTEGER | Votos de popularidad |

### `users`
| Campo | Tipo | Descripción |
|---|---|---|
| `jid` | TEXT PK | JID normalizado del usuario |
| `yenes` | INTEGER | Saldo actual |
| `stress_level` | INTEGER | Nivel de estrés 0–5 (alimenta la IA de Compasión) |
| `last_interaction` | INTEGER | Timestamp del último roll (para decaimiento de estrés) |

---

## 🧠 IA de Compasión

El Mercy System de kamijs no es un pity de rareza clásico. Es un **pity de disponibilidad y billetera**.

**¿Cómo funciona?**

1. Cada vez que un usuario pierde un claim (`reportMissedClaim`), su `stress_level` sube.
2. Si el estrés llega a 3 o más, la IA tiene un 40% de probabilidad de intervenir en el próximo roll.
3. Cuando interviene, el roll filtra solo personajes **libres** y con `value <= saldo del usuario`, garantizando que el resultado sea alcanzable.
4. El estrés **decae naturalmente**: por cada 2 horas de inactividad, baja 1 punto. Un usuario que abandona el juego pierde su ventaja acumulada.

---

## 🔗 Integración con LidSync

kamijs requiere que el socket de Baileys tenga LidSync aplicado para normalizar JIDs correctamente.

```js
import { pluginLid } from 'lidsync';
import store from './lib/store.js';
import { Kamijs } from 'kamijs';

let sock = await connectToWhatsApp();
store.bind(sock.ev);
sock = pluginLid(sock, { store });

const gacha = new Kamijs({ dbPath: './gacha.db' });
await gacha.init();
```

---

## ⚠️ Consideraciones

- **Socket requerido:** Todos los métodos que reciben `jid` también requieren `sock` para resolver LIDs a través de LidSync.
- **Imágenes:** Las URLs de Yande.re son dinámicas. El mismo personaje puede mostrar una imagen diferente en cada roll. Esto es intencional.
- **Importaciones masivas:** `addCharacter` no está optimizado para bulk. Usa `bulkImport()` cuando esté disponible.

---

## 📄 Licencia

MIT — [Neykoor](https://github.com/Neykoor)
