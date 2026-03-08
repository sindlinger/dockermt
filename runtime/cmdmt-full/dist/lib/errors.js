export function handleError(err) {
    if (err instanceof Error) {
        const msg = err.message || String(err);
        if (msg.startsWith("compile retornou") ||
            msg.startsWith("compile nao configurado") ||
            msg.startsWith("Uso: mt5-compile")) {
            process.stderr.write(`${msg}\n`);
        }
        else {
            const stack = err.stack || msg;
            process.stderr.write(`${stack}\n`);
        }
    }
    else {
        process.stderr.write(`${String(err)}\n`);
    }
    process.exit(1);
}
