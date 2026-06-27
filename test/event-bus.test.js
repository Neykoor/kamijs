import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventBus, KAMIJS_EVENTS } from "../src/core/EventBus.js";

describe("EventBus", () => {
    test("on() registra un handler que recibe el payload", () => {
        const bus = new EventBus();
        let received = null;
        bus.on("pull", payload => { received = payload; });
        bus.emit("pull", { jid: "123" });
        assert.deepEqual(received, { jid: "123" });
    });

    test("permite múltiples handlers para el mismo evento", () => {
        const bus = new EventBus();
        let count = 0;
        bus.on("trade", () => count++);
        bus.on("trade", () => count++);
        bus.emit("trade");
        assert.equal(count, 2);
    });

    test("off() detiene las notificaciones a ese handler", () => {
        const bus = new EventBus();
        let count = 0;
        const handler = () => count++;
        bus.on("x", handler);
        bus.emit("x");
        bus.off("x", handler);
        bus.emit("x");
        assert.equal(count, 1);
    });

    test("on() devuelve una función de desuscripción equivalente a off()", () => {
        const bus = new EventBus();
        let count = 0;
        const unsubscribe = bus.on("x", () => count++);
        bus.emit("x");
        unsubscribe();
        bus.emit("x");
        assert.equal(count, 1);
    });

    test("once() solo se ejecuta una vez", () => {
        const bus = new EventBus();
        let count = 0;
        bus.once("y", () => count++);
        bus.emit("y");
        bus.emit("y");
        bus.emit("y");
        assert.equal(count, 1);
    });

    test("removeAllListeners(event) limpia solo ese evento", () => {
        const bus = new EventBus();
        let a = 0, b = 0;
        bus.on("a", () => a++);
        bus.on("b", () => b++);
        bus.removeAllListeners("a");
        bus.emit("a");
        bus.emit("b");
        assert.equal(a, 0);
        assert.equal(b, 1);
    });

    test("un handler que lanza no rompe a los demás handlers", () => {
        const bus = new EventBus();
        let secondRan = false;
        bus.on("z", () => { throw new Error("falla"); });
        bus.on("z", () => { secondRan = true; });
        assert.doesNotThrow(() => bus.emit("z"));
        assert.equal(secondRan, true);
    });

    test("errores síncronos en handlers se reenvían al evento 'error'", () => {
        const bus = new EventBus();
        let captured = null;
        bus.on("error", e => { captured = e; });
        bus.on("pull", () => { throw new Error("boom"); });
        bus.emit("pull");
        assert.equal(captured.sourceEvent, "pull");
        assert.equal(captured.error.message, "boom");
    });

    test("errores en handlers async (promesas rechazadas) también van a 'error'", async () => {
        const bus = new EventBus();
        let captured = null;
        bus.on("error", e => { captured = e; });
        bus.on("trade", async () => { throw new Error("boom async"); });
        bus.emit("trade");
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(captured.sourceEvent, "trade");
        assert.equal(captured.error.message, "boom async");
    });

    test("un handler de 'error' que falla no entra en bucle infinito", () => {
        const bus = new EventBus();
        bus.on("error", () => { throw new Error("error en el propio handler de error"); });
        assert.doesNotThrow(() => bus.emit("error", { sourceEvent: "x", error: new Error("y") }));
    });

    test("KAMIJS_EVENTS expone los nombres esperados", () => {
        assert.equal(KAMIJS_EVENTS.PULL, "pull");
        assert.equal(KAMIJS_EVENTS.TRADE, "trade");
        assert.equal(KAMIJS_EVENTS.ERROR, "error");
        assert.equal(KAMIJS_EVENTS.CHARACTER_ADDED, "characterAdded");
        assert.equal(KAMIJS_EVENTS.CHARACTER_UPDATED, "characterUpdated");
        assert.equal(KAMIJS_EVENTS.CHARACTER_REMOVED, "characterRemoved");
    });
});
