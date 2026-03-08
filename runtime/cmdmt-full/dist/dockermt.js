#!/usr/bin/env node
process.env.CMDMT_BRAND = process.env.CMDMT_BRAND || "dockermt";
await import("./index.js");
export {};
