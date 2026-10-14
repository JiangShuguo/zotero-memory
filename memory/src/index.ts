import { MemoryPlugin } from "./plugin";

type ZoteroWithMemory = typeof Zotero & { Memory?: any };

let plugin: MemoryPlugin | undefined;

/** Entry point called from bootstrap.js once Zotero has started. */
export async function startup(): Promise<void> {
  const zotero = Zotero as ZoteroWithMemory;
  await zotero.initializationPromise;
  await (zotero as any).unlockPromise;
  await (zotero as any).uiReadyPromise;
  stopPrevious(zotero.Memory);
  plugin = new MemoryPlugin();
  zotero.Memory = plugin;
  await plugin.start();
}

export function shutdown(): void {
  const zotero = Zotero as ZoteroWithMemory;
  plugin?.stop();
  if (zotero.Memory === plugin) delete zotero.Memory;
  plugin = undefined;
}

export function onMainWindowLoad({ window }: { window: Window }): void {
  plugin?.onMainWindowLoad(window);
}

/** An instance that was not shut down cleanly would keep drawing a second set of cards. */
function stopPrevious(previous: any): void {
  if (!previous || previous === plugin) return;
  try {
    if (typeof previous.stop === "function") previous.stop();
    else if (typeof previous.hooks?.onShutdown === "function") previous.hooks.onShutdown();
  } catch {
    // Whatever is left of it is removed by the overlay cleanup.
  }
}
