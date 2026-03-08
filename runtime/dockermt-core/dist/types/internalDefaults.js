// Internal defaults for cmdmt's dedicated MT5 instance.
//
// These are intentionally not user-configurable. cmdmt should not accidentally
// connect to the user's live MT5 terminal/service.
export const INTERNAL_TELNET_HOSTS = ["127.0.0.1"];
// NOTE: This must match the TelnetMT service port configured in the MT5 runtime.
export const INTERNAL_TELNET_PORT = 41122;
