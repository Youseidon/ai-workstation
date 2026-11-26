import assert from "node:assert/strict";
import test from "node:test";
import { setBrowserIdentity, userLocalStorage, userSessionStorage } from "../../lib/identityStorage";

function memoryStorage(): Storage {
  const data: Record<string, string> = {};
  return new Proxy({
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => { data[key] = value; },
    removeItem: (key: string) => { delete data[key]; },
  }, { ownKeys: () => Object.keys(data), getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true }) }) as Storage;
}

test("drafts migrate only to the original account and stay separate across sign-ins", () => {
  const localStorage = memoryStorage();
  const sessionStorage = memoryStorage();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage, sessionStorage } });
  try {
    localStorage.setItem("hydra.chat-tabs.v1", "original private tabs");
    sessionStorage.setItem("chat-draft:1", "original private draft");
    const second = { id: "second", username: "second", ownsLegacyData: false };
    const owner = { id: "owner", username: "owner", ownsLegacyData: true };
    setBrowserIdentity(second);
    assert.equal(userLocalStorage.getItem("hydra.chat-tabs.v1"), null);
    assert.equal(userSessionStorage.getItem("chat-draft:1"), null);
    userSessionStorage.setItem("chat-draft:1", "second user's draft");
    setBrowserIdentity(owner);
    assert.equal(userLocalStorage.getItem("hydra.chat-tabs.v1"), "original private tabs");
    assert.equal(userSessionStorage.getItem("chat-draft:1"), "original private draft");
    assert.equal(localStorage.getItem("hydra.chat-tabs.v1"), null);
    userSessionStorage.removeItem("chat-draft:1");
    setBrowserIdentity(owner);
    assert.equal(userSessionStorage.getItem("chat-draft:1"), null, "deleted drafts do not reappear after migration");
    setBrowserIdentity(second);
    assert.equal(userSessionStorage.getItem("chat-draft:1"), "second user's draft");
    setBrowserIdentity(null);
    assert.equal(userSessionStorage.getItem("chat-draft:1"), null);
    userSessionStorage.setItem("chat-draft:1", "discard signed-out writes");
    setBrowserIdentity(second);
    assert.equal(userSessionStorage.getItem("chat-draft:1"), "second user's draft");
  } finally {
    setBrowserIdentity(null);
    if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window");
  }
});
