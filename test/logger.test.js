import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Logger, LOG_LEVELS } from "../src/core/Logger.js";

describe("Logger", () => {
    test("respeta el nivel mínimo configurado", () => {
        const entries = [];
        const log = new Logger({ level: "warn", sink: e => entries.push(e) });
        log.debug("no debería salir");
        log.info("no debería salir");
        log.warn("sí debería salir");
        log.error("sí debería salir");
        assert.equal(entries.length, 2);
        assert.equal(entries[0].level, "warn");
        assert.equal(entries[1].level, "error");
    });

    test("incluye scope, timestamp y meta en cada entrada", () => {
        const entries = [];
        const log = new Logger({ level: "debug", sink: e => entries.push(e), scope: "miScope" });
        log.info("mensaje", { foo: "bar" });
        assert.equal(entries[0].scope, "miScope");
        assert.equal(entries[0].message, "mensaje");
        assert.deepEqual(entries[0].meta, { foo: "bar" });
        assert.ok(entries[0].timestamp);
    });

    test("child() anida el scope sin afectar al logger padre", () => {
        const entries = [];
        const log = new Logger({ level: "debug", sink: e => entries.push(e), scope: "padre" });
        const child = log.child("hijo");
        child.info("desde el hijo");
        log.info("desde el padre");
        assert.equal(entries[0].scope, "padre:hijo");
        assert.equal(entries[1].scope, "padre");
    });

    test("setLevel cambia el filtrado en caliente", () => {
        const entries = [];
        const log = new Logger({ level: "error", sink: e => entries.push(e) });
        log.info("filtrado");
        log.setLevel("info");
        log.info("ahora sí pasa");
        assert.equal(entries.length, 1);
    });

    test("setLevel lanza con un nivel inválido", () => {
        const log = new Logger();
        assert.throws(() => log.setLevel("nivel-inexistente"), /INVALID_LOG_LEVEL/);
    });

    test("si el sink lanza, cae a la salida de consola sin propagar el error", () => {
        const log = new Logger({ level: "info", sink: () => { throw new Error("sink roto"); } });
        assert.doesNotThrow(() => log.info("mensaje de prueba"));
    });

    test("LOG_LEVELS expone el orden correcto de severidad", () => {
        assert.ok(LOG_LEVELS.debug < LOG_LEVELS.info);
        assert.ok(LOG_LEVELS.info < LOG_LEVELS.warn);
        assert.ok(LOG_LEVELS.warn < LOG_LEVELS.error);
        assert.ok(LOG_LEVELS.error < LOG_LEVELS.silent);
    });
});
