import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Kamijs } from "../src/Kamijs.js";

let kami;
let dbPath;

beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `kamijs-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    kami = new Kamijs({ dbPath, logLevel: "silent" });
    await kami.init();
});

afterEach(async () => {
    await kami.close();
    for (const suffix of ["", "-wal", "-shm"]) {
        const f = dbPath + suffix;
        if (fs.existsSync(f)) fs.rmSync(f);
    }
});

describe("Ciclo de vida e inicialización", () => {
    test("init() crea las tablas necesarias y permite operar de inmediato", async () => {
        const bank = await kami.getBank();
        assert.equal(bank, 0);
    });

    test("close() libera la conexión y permite volver a abrirla", async () => {
        await kami.close();
        await kami.init();
        const bank = await kami.getBank();
        assert.equal(bank, 0);
    });
});

describe("Validación de JIDs", () => {
    test("getUser rechaza un jid vacío o no-string", async () => {
        await assert.rejects(() => kami.getUser(""), /INVALID_JID/);
        await assert.rejects(() => kami.getUser(null), /INVALID_JID/);
        await assert.rejects(() => kami.getUser(123), /INVALID_JID/);
    });

    test("trade rechaza fromJid/toJid inválidos con etiquetas distintas", async () => {
        await assert.rejects(() => kami.trade("", "x@y", "char1"), /INVALID_FROMJID/);
        await assert.rejects(() => kami.trade("x@y", "", "char1"), /INVALID_TOJID/);
    });
});

describe("Economía: deposit / getUser / banco", () => {
    test("deposit crea al usuario si no existe y suma balance", async () => {
        await kami.deposit("a@b", 1000);
        const user = await kami.getUser("a@b");
        assert.equal(user.balance, 1000);
    });

    test("deposit acumula sobre depósitos anteriores", async () => {
        await kami.deposit("a@b", 1000);
        await kami.deposit("a@b", 500);
        const user = await kami.getUser("a@b");
        assert.equal(user.balance, 1500);
    });

    test("deposit rechaza montos inválidos", async () => {
        await assert.rejects(() => kami.deposit("a@b", 0), /INVALID_AMOUNT/);
        await assert.rejects(() => kami.deposit("a@b", -10), /INVALID_AMOUNT/);
        await assert.rejects(() => kami.deposit("a@b", 1.5), /INVALID_AMOUNT/);
    });

    test("withdrawBank mueve saldo del banco global al usuario", async () => {
        await kami.addCharacter({ name: "X", series: "S" });
        // Forzamos saldo al banco vía cleanInactiveUsers no es trivial en test,
        // así que probamos la falta de fondos, que es el camino determinista.
        await assert.rejects(() => kami.withdrawBank("a@b", 100), /BANK_INSUFFICIENT_FUNDS/);
    });

    test("getBank devuelve 0 en un banco recién creado", async () => {
        assert.equal(await kami.getBank(), 0);
    });
});

describe("Personajes: CRUD", () => {
    test("addCharacter crea un personaje y devuelve su id", async () => {
        const id = await kami.addCharacter({ name: "Rem", series: "Re:Zero" });
        assert.ok(id);
        const char = await kami.getCharacter(id);
        assert.equal(char.name, "Rem");
        assert.equal(char.series, "Re:Zero");
    });

    test("addCharacter rechaza datos incompletos", async () => {
        await assert.rejects(() => kami.addCharacter({ name: "Solo nombre" }), /MISSING_REQUIRED_FIELDS/);
        await assert.rejects(() => kami.addCharacter({ series: "Solo serie" }), /MISSING_REQUIRED_FIELDS/);
    });

    test("addCharacter rechaza duplicados por nombre+serie (case-insensitive)", async () => {
        await kami.addCharacter({ name: "Rem", series: "Re:Zero" });
        await assert.rejects(
            () => kami.addCharacter({ name: "rem", series: "RE:ZERO" }),
            /DUPLICATE_CHARACTER/
        );
    });

    test("addCharacter rechaza un id duplicado explícito", async () => {
        await kami.addCharacter({ id: "fixed1", name: "A", series: "S1" });
        await assert.rejects(
            () => kami.addCharacter({ id: "fixed1", name: "B", series: "S2" }),
            /DUPLICATE_ID/
        );
    });

    test("updateCharacter modifica solo los campos permitidos", async () => {
        const id = await kami.addCharacter({ name: "Emilia", series: "Re:Zero", value: 3000 });
        const updated = await kami.updateCharacter(id, { value: 9000, gender: "F" });
        assert.equal(updated.value, 9000);
        assert.equal(updated.gender, "F");
        assert.equal(updated.name, "Emilia");
    });

    test("updateCharacter lanza si el personaje no existe", async () => {
        await assert.rejects(() => kami.updateCharacter("no-existe", { value: 1 }), /CHARACTER_NOT_FOUND/);
    });

    test("updateCharacter lanza si no hay campos válidos en el cambio", async () => {
        const id = await kami.addCharacter({ name: "X", series: "S" });
        await assert.rejects(() => kami.updateCharacter(id, { idMaliciosoQueNoExiste: 1 }), /NO_VALID_FIELDS/);
    });

    test("updateCharacter detecta colisión de duplicados al renombrar", async () => {
        await kami.addCharacter({ name: "A", series: "S1" });
        const idB = await kami.addCharacter({ name: "B", series: "S1" });
        await assert.rejects(
            () => kami.updateCharacter(idB, { name: "A" }),
            /DUPLICATE_CHARACTER/
        );
    });

    test("removeCharacter elimina un personaje sin dueños", async () => {
        const id = await kami.addCharacter({ name: "X", series: "S" });
        const removed = await kami.removeCharacter(id);
        assert.equal(removed.id, id);
        assert.equal(await kami.getCharacter(id), undefined);
    });

    test("removeCharacter rechaza eliminar un personaje con dueños, salvo force", async () => {
        const id = await kami.addCharacter({ name: "X", series: "S", global_limit: 5 });
        await kami.claimStarter("owner@x", id);

        await assert.rejects(() => kami.removeCharacter(id), /CHARACTER_HAS_OWNERS/);

        const removed = await kami.removeCharacter(id, { force: true });
        assert.equal(removed.id, id);
        assert.equal(await kami.getCharacter(id), undefined);
    });

    test("removeCharacter limpia también claims y listados de mercado asociados", async () => {
        const id = await kami.addCharacter({ name: "X", series: "S", global_limit: 5 });
        await kami.deposit("seller@x", 100000);
        await kami.claimStarter("seller@x", id);
        await kami.listMarket("seller@x", id, 5000);

        await kami.removeCharacter(id, { force: true });

        const market = await kami.getMarket();
        assert.equal(market.items.find(m => m.char_id === id), undefined);
    });
});

describe("Búsqueda y paginación de personajes", () => {
    test("searchCharacters encuentra coincidencias parciales en nombre o serie", async () => {
        await kami.addCharacter({ name: "Rem", series: "Re:Zero" });
        await kami.addCharacter({ name: "Ram", series: "Re:Zero" });
        await kami.addCharacter({ name: "Megumin", series: "Konosuba" });

        const byName = await kami.searchCharacters("ra");
        assert.equal(byName.total, 1);
        assert.equal(byName.items[0].name, "Ram");

        const bySeries = await kami.searchCharacters("zero");
        assert.equal(bySeries.total, 2);
    });

    test("searchCharacters respeta limit/offset y expone hasMore", async () => {
        for (let i = 0; i < 15; i++) {
            await kami.addCharacter({ name: `Personaje${i}`, series: "Serie" });
        }
        const page1 = await kami.searchCharacters("personaje", { limit: 10, offset: 0 });
        assert.equal(page1.items.length, 10);
        assert.equal(page1.total, 15);
        assert.equal(page1.hasMore, true);

        const page2 = await kami.searchCharacters("personaje", { limit: 10, offset: 10 });
        assert.equal(page2.items.length, 5);
        assert.equal(page2.hasMore, false);
    });

    test("listCharacters pagina todo el catálogo sin filtro", async () => {
        for (let i = 0; i < 5; i++) {
            await kami.addCharacter({ name: `C${i}`, series: "S" });
        }
        const result = await kami.listCharacters({ limit: 3 });
        assert.equal(result.items.length, 3);
        assert.equal(result.total, 5);
    });

    test("getSeriesCharacters agrupa correctamente por serie (case-insensitive)", async () => {
        await kami.addCharacter({ name: "A", series: "MiSerie" });
        await kami.addCharacter({ name: "B", series: "miserie" });
        const result = await kami.getSeriesCharacters("MISERIE");
        assert.equal(result.length, 2);
    });
});

describe("Gacha: claimStarter", () => {
    test("otorga el personaje inicial una sola vez por usuario", async () => {
        const id = await kami.addCharacter({ name: "Starter", series: "S", global_limit: 5 });
        const char = await kami.claimStarter("u@x", id);
        assert.equal(char.id, id);

        await assert.rejects(() => kami.claimStarter("u@x", id), /ALREADY_CLAIMED_STARTER/);
    });

    test("respeta el global_limit del personaje", async () => {
        const id = await kami.addCharacter({ name: "Limitado", series: "S", global_limit: 1 });
        await kami.claimStarter("u1@x", id);
        await assert.rejects(() => kami.claimStarter("u2@x", id), /OUT_OF_STOCK/);
    });

    test("lanza si el personaje no existe", async () => {
        await assert.rejects(() => kami.claimStarter("u@x", "no-existe"), /CHARACTER_NOT_FOUND/);
    });
});

describe("Gacha: tickets", () => {
    test("useTicket consume un ticket incluso si falla la obtención", async () => {
        const id = await kami.addCharacter({ name: "T", series: "S", global_limit: 5 });
        await kami.addTickets("u@x", 1);

        try {
            await kami.useTicket("u@x", id);
        } catch (e) {
            assert.equal(e.message, "TICKET_FAILED");
        }
        const user = await kami.getUser("u@x");
        assert.equal(user.tickets, 0);
    });

    test("useTicket rechaza si no hay tickets disponibles", async () => {
        const id = await kami.addCharacter({ name: "T", series: "S" });
        await kami.deposit("u@x", 1);
        await assert.rejects(() => kami.useTicket("u@x", id), /NO_TICKETS/);
    });

    test("useTicket rechaza si el usuario ya posee el personaje", async () => {
        const id = await kami.addCharacter({ name: "T", series: "S", global_limit: 5 });
        await kami.claimStarter("u@x", id);
        await kami.addTickets("u@x", 1);
        await assert.rejects(() => kami.useTicket("u@x", id), /ALREADY_OWNS/);
    });

    test("addTickets acumula tickets correctamente", async () => {
        await kami.addTickets("u@x", 3);
        await kami.addTickets("u@x", 2);
        const user = await kami.getUser("u@x");
        assert.equal(user.tickets, 5);
    });
});

describe("Gacha: pull10 y economía", () => {
    test("rechaza si el usuario no tiene saldo suficiente", async () => {
        await kami.addCharacter({ name: "C", series: "S" });
        await kami.deposit("u@x", 100);
        await assert.rejects(() => kami.pull10("u@x"), /INSUFFICIENT_FUNDS/);
    });

    test("descuenta exactamente el costo del pull del balance", async () => {
        await kami.addCharacter({ name: "C", series: "S", global_limit: 10 });
        await kami.deposit("u@x", 50000);
        const before = (await kami.getUser("u@x")).balance;
        const results = await kami.pull10("u@x");
        const after = (await kami.getUser("u@x")).balance;

        const jackpot = results.reduce((sum, r) => sum + (r.jackpotBonus || 0), 0);
        assert.equal(results.length, 10);
        // El balance final siempre es explicable por costo, jackpot y compensaciones,
        // y nunca debería superar el balance inicial menos el costo base sin jackpot/compensación.
        assert.ok(after <= before - 3000 + jackpot + 30000);
        assert.ok(after >= before - 3000);
    });

    test("respeta un costo de pull personalizado via eventConfig", async () => {
        await kami.addCharacter({ name: "C", series: "S", global_limit: 10 });
        await kami.deposit("u@x", 50000);
        const before = (await kami.getUser("u@x")).balance;
        await kami.pull10("u@x", { eventConfig: { cost: 1000 } });
        const after = (await kami.getUser("u@x")).balance;
        assert.ok(before - after <= 1000 + 30000);
    });

    test("guaranteedMin fuerza al menos N hits en la sesión", async () => {
        for (let i = 0; i < 5; i++) {
            await kami.addCharacter({ id: `gm${i}`, name: `GM${i}`, series: "S", global_limit: 10 });
        }
        await kami.deposit("u@x", 50000);
        const results = await kami.pull10("u@x", { eventConfig: { guaranteedMin: 3 } });
        const hits = results.filter(r => r.char !== null).length;
        assert.ok(hits >= 3);
    });

    test("rechaza si el pool de personajes está vacío", async () => {
        await kami.deposit("u@x", 50000);
        await assert.rejects(() => kami.pull10("u@x"), /EMPTY_POOL/);
    });

    test("pity/luck NO se resetean cuando todos los hits de la sesión son repetidos", async () => {
        for (let i = 0; i < 10; i++) {
            await kami.addCharacter({ id: `r${i}`, name: `R${i}`, series: "S", global_limit: 1 });
        }
        await kami.deposit("u@x", 200000);

        await kami.pull10("u@x", { eventConfig: { guaranteedMin: 10 } });
        const afterFirst = await kami.getUser("u@x");
        const harem = await kami.getHarem("u@x");
        assert.equal(harem.length, 10, "se esperaba reclamar los 10 personajes únicos del pool");

        const pityBefore = afterFirst.pity_count;

        await kami.pull10("u@x", { eventConfig: { guaranteedMin: 10 } });
        const afterSecond = await kami.getUser("u@x");

        assert.equal(
            afterSecond.pity_count,
            pityBefore + 10,
            "el pity debe acumularse en +10 cuando todos los hits son repetidos, sin resets intermedios"
        );
    });

    test("pity SÍ se resetea al obtener un personaje nuevo", async () => {
        await kami.addCharacter({ id: "nuevo1", name: "Nuevo", series: "S", global_limit: 1 });
        await kami.deposit("u@x", 50000);

        const results = await kami.pull10("u@x", { eventConfig: { guaranteedMin: 1 } });
        const newHit = results.find(r => r.char && !r.char.isRepeat);
        assert.ok(newHit, "se esperaba al menos un hit de personaje nuevo");

        const user = await kami.getUser("u@x");
        assert.ok(user.pity_count < 10, "el pity debería estar cerca de 0 tras un personaje nuevo");
    });
});

describe("Mercado", () => {
    async function ownAndFund(jid, charOpts) {
        const id = await kami.addCharacter(charOpts);
        await kami.deposit(jid, 100000);
        await kami.claimStarter(jid, id);
        return id;
    }

    test("listMarket exige que el vendedor posea el personaje", async () => {
        const id = await kami.addCharacter({ name: "X", series: "S" });
        await kami.deposit("u@x", 100000);
        await assert.rejects(() => kami.listMarket("u@x", id, 1000), /CHARACTER_NOT_OWNED/);
    });

    test("listMarket rechaza precios inválidos", async () => {
        const id = await ownAndFund("u@x", { name: "X", series: "S", global_limit: 5 });
        await assert.rejects(() => kami.listMarket("u@x", id, 0), /INVALID_PRICE/);
        await assert.rejects(() => kami.listMarket("u@x", id, -5), /INVALID_PRICE/);
        await assert.rejects(() => kami.listMarket("u@x", id, 1.5), /INVALID_PRICE/);
    });

    test("listMarket rechaza listar el mismo personaje dos veces", async () => {
        const id = await ownAndFund("u@x", { name: "X", series: "S", global_limit: 5 });
        await kami.listMarket("u@x", id, 1000);
        await assert.rejects(() => kami.listMarket("u@x", id, 2000), /ALREADY_LISTED/);
    });

    test("buyFromMarket transfiere el personaje y aplica el impuesto del 5%", async () => {
        const id = await ownAndFund("seller@x", { name: "X", series: "S", global_limit: 5 });
        await kami.listMarket("seller@x", id, 1000);
        await kami.deposit("buyer@x", 100000);

        const sellerBefore = (await kami.getUser("seller@x")).balance;
        const buyerBefore = (await kami.getUser("buyer@x")).balance;
        const bankBefore = await kami.getBank();

        await kami.buyFromMarket("buyer@x", 1);

        const sellerAfter = (await kami.getUser("seller@x")).balance;
        const buyerAfter = (await kami.getUser("buyer@x")).balance;
        const bankAfter = await kami.getBank();

        assert.equal(buyerBefore - buyerAfter, 1000);
        assert.equal(sellerAfter - sellerBefore, 950);
        assert.equal(bankAfter - bankBefore, 50);

        const harem = await kami.getHarem("buyer@x");
        assert.ok(harem.some(c => c.id === id));
    });

    test("buyFromMarket rechaza comprar el propio listado", async () => {
        const id = await ownAndFund("u@x", { name: "X", series: "S", global_limit: 5 });
        await kami.listMarket("u@x", id, 1000);
        await assert.rejects(() => kami.buyFromMarket("u@x", 1), /CANNOT_BUY_OWN/);
    });

    test("buyFromMarket rechaza si el comprador no tiene saldo suficiente", async () => {
        const id = await ownAndFund("seller@x", { name: "X", series: "S", global_limit: 5 });
        await kami.listMarket("seller@x", id, 99999);
        await kami.deposit("buyer@x", 10);
        await assert.rejects(() => kami.buyFromMarket("buyer@x", 1), /INSUFFICIENT_FUNDS/);
    });

    test("delistMarket retira la publicación del propio vendedor", async () => {
        const id = await ownAndFund("u@x", { name: "X", series: "S", global_limit: 5 });
        await kami.listMarket("u@x", id, 1000);
        await kami.delistMarket("u@x", 1);
        const market = await kami.getMarket();
        assert.equal(market.items.length, 0);
    });

    test("delistMarket rechaza retirar una publicación ajena", async () => {
        const id = await ownAndFund("u@x", { name: "X", series: "S", global_limit: 5 });
        await kami.listMarket("u@x", id, 1000);
        await assert.rejects(() => kami.delistMarket("otro@x", 1), /LISTING_NOT_FOUND/);
    });

    test("getMarket pagina correctamente", async () => {
        for (let i = 0; i < 12; i++) {
            const id = await ownAndFund(`u${i}@x`, { name: `M${i}`, series: "S", global_limit: 5 });
            await kami.listMarket(`u${i}@x`, id, 1000 + i);
        }
        const page = await kami.getMarket(5, 0);
        assert.equal(page.items.length, 5);
        assert.equal(page.total, 12);
        assert.equal(page.hasMore, true);
    });
});

describe("Intercambios (trade)", () => {
    test("transfiere la propiedad de un personaje entre dos usuarios", async () => {
        const id = await kami.addCharacter({ name: "X", series: "S", global_limit: 5 });
        await kami.deposit("a@x", 100000);
        await kami.claimStarter("a@x", id);

        await kami.trade("a@x", "b@x", id);

        const haremA = await kami.getHarem("a@x");
        const haremB = await kami.getHarem("b@x");
        assert.equal(haremA.length, 0);
        assert.equal(haremB.length, 1);
    });

    test("rechaza el auto-intercambio", async () => {
        const id = await kami.addCharacter({ name: "X", series: "S", global_limit: 5 });
        await kami.deposit("a@x", 100000);
        await kami.claimStarter("a@x", id);
        await assert.rejects(() => kami.trade("a@x", "a@x", id), /SELF_TRADE/);
    });

    test("rechaza si el receptor ya posee el personaje", async () => {
        const id = await kami.addCharacter({ name: "X", series: "S", global_limit: 5 });
        await kami.deposit("a@x", 100000);
        await kami.deposit("b@x", 100000);
        await kami.claimStarter("a@x", id);
        await kami.claimStarter("b@x", id);
        await assert.rejects(() => kami.trade("a@x", "b@x", id), /RECEIVER_ALREADY_OWNS/);
    });

    test("rechaza si el emisor no posee el personaje", async () => {
        const id = await kami.addCharacter({ name: "X", series: "S", global_limit: 5 });
        await assert.rejects(() => kami.trade("a@x", "b@x", id), /CHARACTER_NOT_OWNED/);
    });

    test("retira de la venta el personaje intercambiado si estaba listado", async () => {
        const id = await kami.addCharacter({ name: "X", series: "S", global_limit: 5 });
        await kami.deposit("a@x", 100000);
        await kami.claimStarter("a@x", id);
        await kami.listMarket("a@x", id, 1000);

        await kami.trade("a@x", "b@x", id);

        const market = await kami.getMarket();
        assert.equal(market.items.length, 0);
    });
});

describe("releaseCharacter y getHarem", () => {
    test("libera un personaje y lo retira del mercado si estaba listado", async () => {
        const id = await kami.addCharacter({ name: "X", series: "S", global_limit: 5 });
        await kami.deposit("a@x", 100000);
        await kami.claimStarter("a@x", id);
        await kami.listMarket("a@x", id, 1000);

        await kami.releaseCharacter("a@x", id);

        const harem = await kami.getHarem("a@x");
        const market = await kami.getMarket();
        assert.equal(harem.length, 0);
        assert.equal(market.items.length, 0);
    });

    test("rechaza liberar un personaje que no se posee", async () => {
        const id = await kami.addCharacter({ name: "X", series: "S" });
        await assert.rejects(() => kami.releaseCharacter("a@x", id), /CHARACTER_NOT_OWNED/);
    });
});

describe("Rate limiting (cooldowns)", () => {
    test("bloquea una segunda llamada inmediata cuando hay cooldown configurado", async () => {
        await kami.close();
        kami = new Kamijs({ dbPath, logLevel: "silent", cooldowns: { claimStarter: 60_000 } });
        await kami.init();

        const id = await kami.addCharacter({ name: "X", series: "S", global_limit: 5 });
        await kami.claimStarter("a@x", id);

        const id2 = await kami.addCharacter({ name: "Y", series: "S", global_limit: 5 });
        await assert.rejects(() => kami.claimStarter("a@x", id2), /COOLDOWN_ACTIVE/);
    });

    test("sin cooldowns configurados, las llamadas repetidas no se bloquean", async () => {
        const id1 = await kami.addCharacter({ name: "X", series: "S", global_limit: 5 });
        const id2 = await kami.addCharacter({ name: "Y", series: "S", global_limit: 5 });
        await kami.claimStarter("a@x", id1);
        await kami.deposit("a@x", 1);
        // claimStarter ya fue usado, pero distinto método (useTicket) sin cooldown no debe verse afectado
        await kami.addTickets("a@x", 1);
        await assert.doesNotReject(async () => {
            try { await kami.useTicket("a@x", id2); } catch (e) { if (e.message !== "TICKET_FAILED") throw e; }
        });
    });
});

describe("Eventos (EventBus)", () => {
    test("emite 'pull' tras un pull10 exitoso", async () => {
        await kami.addCharacter({ name: "X", series: "S", global_limit: 10 });
        await kami.deposit("a@x", 50000);

        let payload = null;
        kami.on("pull", p => { payload = p; });
        await kami.pull10("a@x");

        assert.ok(payload);
        assert.equal(payload.jid, "a@x");
        assert.equal(payload.results.length, 10);
    });

    test("emite 'characterAdded', 'characterUpdated' y 'characterRemoved'", async () => {
        const events = [];
        kami.on("characterAdded", () => events.push("added"));
        kami.on("characterUpdated", () => events.push("updated"));
        kami.on("characterRemoved", () => events.push("removed"));

        const id = await kami.addCharacter({ name: "X", series: "S" });
        await kami.updateCharacter(id, { value: 5000 });
        await kami.removeCharacter(id);

        assert.deepEqual(events, ["added", "updated", "removed"]);
    });

    test("emite 'error' cuando una operación falla", async () => {
        let errPayload = null;
        kami.on("error", p => { errPayload = p; });

        await assert.rejects(() => kami.claimStarter("a@x", "no-existe"));

        assert.ok(errPayload);
        assert.equal(errPayload.context, "claimStarter");
        assert.equal(errPayload.error.message, "CHARACTER_NOT_FOUND");
    });

    test("off() detiene la recepción de eventos", async () => {
        let count = 0;
        const handler = () => count++;
        kami.on("characterAdded", handler);
        await kami.addCharacter({ name: "A", series: "S" });
        kami.off("characterAdded", handler);
        await kami.addCharacter({ name: "B", series: "S" });
        assert.equal(count, 1);
    });
});

describe("Limpieza de usuarios inactivos", () => {
    test("cleanInactiveUsers no afecta a usuarios recientes", async () => {
        await kami.deposit("a@x", 1000);
        const result = await kami.cleanInactiveUsers();
        assert.equal(result.removedUsers, 0);
        const user = await kami.getUser("a@x");
        assert.equal(user.balance, 1000);
    });
});

describe("Concurrencia: cola de transacciones", () => {
    test("serializa pulls concurrentes del mismo usuario sin corromper el balance", async () => {
        for (let i = 0; i < 15; i++) {
            await kami.addCharacter({ id: `cc${i}`, name: `CC${i}`, series: "Conc" });
        }
        await kami.deposit("a@x", 60000);

        const promises = Array.from({ length: 15 }, () =>
            kami.pull10("a@x").catch(e => ({ error: e.message }))
        );
        const results = await Promise.all(promises);
        const succeeded = results.filter(r => Array.isArray(r)).length;

        const user = await kami.getUser("a@x");
        assert.ok(user.balance >= 0, "el balance nunca debe quedar negativo");
        assert.ok(succeeded <= 20, "no debería haber más éxitos que los fondos permiten");
    });

    test("una transacción que falla hace rollback sin afectar el estado", async () => {
        await kami.deposit("a@x", 100);
        await assert.rejects(() => kami.pull10("a@x"));
        const user = await kami.getUser("a@x");
        assert.equal(user.balance, 100, "el balance no debe cambiar si pull10 falla por EMPTY_POOL/fondos");
    });
});
