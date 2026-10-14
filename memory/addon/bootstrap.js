/**
 * Memory - bootstrapped plugin for Zotero 7-10
 * Scope: comment cards beside PDF pages in the Zotero reader.
 */

var Memory;
var chromeHandle;

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  rootURI = rootURI || resourceURI.spec;
  const startupService = Cc["@mozilla.org/addons/addon-manager-startup;1"].getService(
    Ci.amIAddonManagerStartup,
  );
  chromeHandle = startupService.registerChrome(Services.io.newURI(rootURI + "manifest.json"), [
    ["content", "memory", rootURI + "content/"],
  ]);
  Services.scriptloader.loadSubScript(rootURI + "content/memory.js");
  await Memory.startup();
}

function onMainWindowLoad(data, reason) {
  if (typeof Memory !== "undefined" && Memory?.onMainWindowLoad) {
    Memory.onMainWindowLoad(data);
  }
}

function onMainWindowUnload({ window }, reason) {}

function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (typeof APP_SHUTDOWN !== "undefined" && reason === APP_SHUTDOWN) {
    return;
  }
  if (typeof Memory !== "undefined" && Memory) {
    Memory.shutdown();
  }
  Memory = undefined;
  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = undefined;
  }
  // Without this an upgrade can keep running the previous build from the startup cache.
  Services.obs.notifyObservers(null, "startupcache-invalidate");
}

function uninstall(data, reason) {}
