import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../src/core/RateLimiter.js";

describe("RateLimiter", () => {
    test("permite la primera llamada de cualquier acción", () => {
        const rl = new RateLimiter({ pull10: 5000 });
        const result = rl.check("pull10", "jid1");
        assert.equal(result.allowed, true);
        assert.equal(result.remainingMs, 0);
    });

    test("bloquea llamadas repetidas dentro del cooldown", () => {
        const rl = new RateLimiter({ pull10: 5000 });
        rl.hit("pull10", "jid1");
        const result = rl.check("pull10", "jid1");
        assert.equal(result.allowed, false);
        assert.ok(result.remainingMs > 0 && result.remainingMs <= 5000);
    });

    test("cada jid tiene su propio cooldown independiente", () => {
        const rl = new RateLimiter({ pull10: 5000 });
        rl.hit("pull10", "jid1");
        assert.equal(rl.check("pull10", "jid1").allowed, false);
        assert.equal(rl.check("pull10", "jid2").allowed, true);
    });

    test("cada acción tiene su propio cooldown independiente", () => {
        const rl = new RateLimiter({ pull10: 5000, useTicket: 1000 });
        rl.hit("pull10", "jid1");
        assert.equal(rl.check("pull10", "jid1").allowed, false);
        assert.equal(rl.check("useTicket", "jid1").allowed, true);
    });

    test("una acción sin cooldown configurado (0 o ausente) siempre permite", () => {
        const rl = new RateLimiter({ pull10: 5000 });
        assert.equal(rl.check("accionSinConfigurar", "jid1").allowed, true);
    });

    test("el cooldown expira pasado el tiempo configurado", async () => {
        const rl = new RateLimiter({ pull10: 30 });
        rl.hit("pull10", "jid1");
        assert.equal(rl.check("pull10", "jid1").allowed, false);
        await new Promise(resolve => setTimeout(resolve, 60));
        assert.equal(rl.check("pull10", "jid1").allowed, true);
    });

    test("reset() libera el cooldown manualmente", () => {
        const rl = new RateLimiter({ pull10: 5000 });
        rl.hit("pull10", "jid1");
        assert.equal(rl.check("pull10", "jid1").allowed, false);
        rl.reset("pull10", "jid1");
        assert.equal(rl.check("pull10", "jid1").allowed, true);
    });

    test("clear() libera todos los cooldowns de golpe", () => {
        const rl = new RateLimiter({ pull10: 5000 });
        rl.hit("pull10", "jid1");
        rl.hit("pull10", "jid2");
        rl.clear();
        assert.equal(rl.check("pull10", "jid1").allowed, true);
        assert.equal(rl.check("pull10", "jid2").allowed, true);
    });

    test("setCooldown() permite ajustar cooldowns en caliente", () => {
        const rl = new RateLimiter({ pull10: 5000 });
        rl.setCooldown("pull10", 0);
        rl.hit("pull10", "jid1");
        assert.equal(rl.check("pull10", "jid1").allowed, true);
    });

    test("setCooldown() rechaza valores negativos o no enteros", () => {
        const rl = new RateLimiter();
        assert.throws(() => rl.setCooldown("pull10", -1));
        assert.throws(() => rl.setCooldown("pull10", 1.5));
    });

    test("getCooldown() devuelve el valor configurado", () => {
        const rl = new RateLimiter({ pull10: 3000 });
        assert.equal(rl.getCooldown("pull10"), 3000);
        assert.equal(rl.getCooldown("inexistente"), 0);
    });

    test("hit() en una acción sin cooldown no genera estado innecesario", () => {
        const rl = new RateLimiter({});
        rl.hit("pull10", "jid1");
        assert.equal(rl.check("pull10", "jid1").allowed, true);
    });

    test("el sweep respeta el cooldown con JIDs que contienen ':' (JIDs tipo lid)", async () => {
        const rl = new RateLimiter({ pull10: 5000 }, { sweepEveryMs: 10 });
        const lidJid = "123456789:12@lid";
        rl.hit("pull10", lidJid);
        
        await new Promise(resolve => setTimeout(resolve, 20));
        rl.check("otraAccion", "otroJid");
                assert.equal(rl.check("pull10", lidJid).allowed, false);
    });
});
