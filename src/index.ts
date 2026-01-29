import axios from "axios"
import ping from "ping"
import arp from "node-arp"
import wol from "node-wol"
import { spawn } from "node:child_process"
import type { AddressModel } from "./models/address.model"
import { configDotenv } from "dotenv"
import type { CommandModel } from "./models/command.model"

// Read the node configuration
configDotenv()
const DEVICE_CHECK_INTERVAL = Number(process.env.DEVICE_CHECK_INTERVAL)
const COMMAND_CHECK_INTERVAL = Number(process.env.COMMAND_CHECK_INTERVAL)
const TERMINAL_MAX_LINES = Number(process.env.TERMINAL_MAX_LINES)
const COMMAND_TIMEOUT_MS = Number(process.env.COMMAND_TIMEOUT_MS)

// Creating a base connection object with the REST API
const client = axios.create({
    baseURL: process.env.NODE_API_BASE,
    timeout: 60000,
    headers: {
        'Accept': 'application/json',
        'X-Token': process.env.NODE_API_KEY
    }
})

// Function that adapts ARP cache readout in more friendly syncronous way
const getMacFromIp = async (ip: string): Promise<string | null> => {
    return new Promise((resolve, reject) => {
        arp.getMAC(ip, (err, mac) => {
            if (err) {
                reject(err);
            } else {
                resolve(mac || null);
            }
        });
    });
};

async function run() {
    try {
        // Keep note of the date and time the application is started
        const now = new Date()
        console.log('Report started on', now)

        // Retrieving data for the current node
        // Result is an address array that should be checked based on criteria
        const rsp = await client.get<AddressModel[]>('/node/heartbeat')
        const arr = []
        for (let addr of rsp.data) {
            try {
                // Send a ICMP packet to check if the device is online
                const reply = await ping.promise.probe(addr.value, { min_reply: 1 })

                // Try to retrieve the mac address from the systems arp cache
                const mac = await getMacFromIp(addr.value)

                // Friendly console information
                // Exists for monitoring purposes - application stuck or such issues
                console.log(`Host ${addr.value} (${mac}) is ${reply.alive ? 'online' : 'offline'}`)

                // Attempt to wake the device
                if (!reply.alive && addr.wol) {
                    console.log('Attempting to wake device:', mac)
                    wol.wake(mac, (e: any) => {
                        // Waking the device should be async since the result will anyways be known
                        // on the next status update
                        e ?? console.log(`Failed to wake device ${mac}`)
                    })
                }

                // Appending the report to the response array
                // This will be sent in bulk later after all the marked addresses are checked
                arr.push({
                    addressId: addr.addressId,
                    alive: reply.alive,
                    mac: mac,
                    timestamp: new Date()
                })
            } catch (e) {
                console.log(`Host ${addr.value} is unavailable`)
            }
        }

        // Send data back to master server
        console.log('Sending report back')
        client.request({
            url: '/node/heartbeat',
            method: 'post',
            data: {
                timestamp: now,
                report: arr
            }
        })
        console.log('Report finished')
    } catch (e) {
        console.log('Failed:', e)
    }
}

// Run monitoring once since interval by default doesnt have an initial run when set
// After that monitoring will be run on time specified in node configuration file
run()
setInterval(run, DEVICE_CHECK_INTERVAL)

// Remote Terminal Command Listener
let stopped = false;
let running = false;

function getDefaultShell(): { shell: string; argsPrefix: string[] } {
    if (process.platform === "win32") {
        // cmd.exe is the default Windows shell
        return {
            shell: process.env.ComSpec ?? "cmd.exe",
            argsPrefix: ["/d", "/s", "/c"],
        };
    }
    // use user's shell if available, fallback to sh
    return {
        shell: process.env.SHELL ?? "/bin/sh",
        argsPrefix: ["-lc"],
    };
}

async function runInDefaultShell(command: string): Promise<string[]> {
    const { shell, argsPrefix } = getDefaultShell();

    return new Promise((resolve) => {
        const lines: string[] = [];
        let killed = false;

        const child = spawn(shell, [...argsPrefix, command], {
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        });

        const addChunk = (buf: Buffer, prefix = "") => {
            const text = buf.toString("utf8").replace(/\r\n/g, "\n");
            for (const l of text.split("\n")) {
                if (!l) continue;
                lines.push(prefix + l);

                if (lines.length >= TERMINAL_MAX_LINES && !killed) {
                    killed = true;
                    // stop the process after enough lines
                    try {
                        child.kill();
                    } catch { }
                    break;
                }
            }
        };

        child.stdout?.on("data", (d: Buffer) => addChunk(d));
        child.stderr?.on("data", (d: Buffer) => addChunk(d));

        const timer = setTimeout(() => {
            if (!killed) {
                killed = true;
                try {
                    child.kill();
                } catch { }
            }
        }, COMMAND_TIMEOUT_MS);

        child.on("error", (err) => {
            clearTimeout(timer);
            resolve([`spawn error: ${String((err as any)?.message ?? err)}`]);
        });

        child.on("close", () => {
            clearTimeout(timer);
            resolve(lines);
        });
    });
}

// Remote Terminal Command Listener
setInterval(async () => {
    if (stopped) return;
    if (running) return;

    running = true;
    try {
        const rsp = await client.get<CommandModel[]>("/node/retrieve-commands");
        const commands = rsp.data ?? [];

        for (const cmd of commands) {
            const value = (cmd.value ?? "").trim();

            // exact stop condition
            if (value === "stop" || value === "exit") {
                stopped = true;
                break;
            }

            console.log(`Upstream Command ${cmd.commandId}: ${value}`);
            await client.request({
                url: '/node/command-reply',
                method: 'POST',
                data: {
                    commandId: cmd.commandId,
                    replies: await runInDefaultShell(value)
                }
            })
        }
    } catch (e) {
        console.log("Failed:", e);
    } finally {
        running = false;
    }
}, COMMAND_CHECK_INTERVAL);