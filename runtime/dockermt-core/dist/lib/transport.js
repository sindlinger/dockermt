import net from "node:net";
export function parseHosts(hosts) {
    if (!hosts)
        return [];
    return hosts
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean);
}
async function connectOnce(host, port, timeoutMs, payload) {
    return new Promise((resolve, reject) => {
        const traceSocket = process.env.DOCKERMT_TRACE_SOCKET === "1";
        if (traceSocket) {
            process.stderr.write(`[sock] connect ${host}:${port} timeout=${timeoutMs}\n`);
        }
        const socket = net.createConnection({ host, port });
        let data = "";
        let done = false;
        const finish = (err) => {
            if (done)
                return;
            done = true;
            try {
                socket.destroy();
            }
            catch {
                // ignore
            }
            if (err)
                reject(err);
        };
        socket.setTimeout(timeoutMs);
        socket.on("timeout", () => finish(new Error("timeout")));
        socket.on("error", (err) => finish(err));
        socket.on("connect", () => {
            if (traceSocket) {
                process.stderr.write(`[sock] connected ${host}:${port}\n`);
            }
            socket.write(payload, "utf8");
        });
        socket.on("data", (chunk) => {
            if (traceSocket) {
                process.stderr.write(`[sock] data ${host}:${port} bytes=${chunk.length}\n`);
            }
            data += chunk.toString("utf8");
        });
        socket.on("end", () => {
            if (done)
                return;
            done = true;
            resolve(data);
        });
        socket.on("close", () => {
            if (done)
                return;
            done = true;
            if (traceSocket) {
                process.stderr.write(`[sock] close ${host}:${port}\n`);
            }
            resolve(data);
        });
    });
}
export async function sendLine(line, opts) {
    const payload = line.endsWith("\n") ? line : line + "\n";
    let lastErr = null;
    for (const host of opts.hosts) {
        try {
            return await connectOnce(host, opts.port, opts.timeoutMs, payload);
        }
        catch (err) {
            lastErr = err;
        }
    }
    throw lastErr ?? new Error("connection failed");
}
export async function sendJson(obj, opts) {
    const payload = JSON.stringify(obj) + "\n";
    return sendLine(payload, opts);
}
