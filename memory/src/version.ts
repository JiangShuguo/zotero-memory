declare const __MEMORY_VERSION__: string | undefined;

/** Set at build time from `tools/build_xpi.py`. */
export const VERSION: string = typeof __MEMORY_VERSION__ === "string" ? __MEMORY_VERSION__ : "0.0.0";
