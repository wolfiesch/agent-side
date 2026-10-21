/** Process-table helpers for finding the agent that owns a shell or a terminal pane. */
import { readlinkSync } from "node:fs";
import { checked, type Runner } from "./terminal";

export interface ProcessInfo {
	pid: number;
	ppid: number;
	/** Executable path on macOS; the short command name on Linux. */
	comm: string;
	/** Full command line as `ps` reports it. */
	args: string;
}

export type ProcessTable = Map<number, ProcessInfo>;

function parseColumns(output: string, columns: number): string[][] {
	const rows: string[][] = [];
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const parts = trimmed.split(/\s+/);
		if (parts.length < columns) continue;
		// The last column keeps its spaces: executable paths and command lines may contain them.
		rows.push([...parts.slice(0, columns - 1), parts.slice(columns - 1).join(" ")]);
	}
	return rows;
}

export async function readProcessTable(run: Runner): Promise<ProcessTable> {
	const [comms, args] = await Promise.all([
		checked(run, "ps", ["-A", "-o", "pid=,ppid=,comm="]),
		checked(run, "ps", ["-A", "-o", "pid=,args="]),
	]);
	const argsByPid = new Map<number, string>();
	for (const [pid, line] of parseColumns(args, 2)) argsByPid.set(Number(pid), line);
	const table: ProcessTable = new Map();
	for (const [pid, ppid, comm] of parseColumns(comms, 3)) {
		const id = Number(pid);
		table.set(id, { pid: id, ppid: Number(ppid), comm, args: argsByPid.get(id) ?? comm });
	}
	return table;
}

/** `pid` first, then its parent, up to the root. */
export function ancestors(table: ProcessTable, pid: number): ProcessInfo[] {
	const chain: ProcessInfo[] = [];
	const seen = new Set<number>();
	for (let current = table.get(pid); current && !seen.has(current.pid); current = table.get(current.ppid)) {
		seen.add(current.pid);
		chain.push(current);
	}
	return chain;
}

/** Breadth-first descendants of `pid`, nearest generation first, excluding `pid` itself. */
export function descendants(table: ProcessTable, pid: number): ProcessInfo[] {
	const children = new Map<number, ProcessInfo[]>();
	for (const info of table.values()) {
		const list = children.get(info.ppid);
		if (list) list.push(info);
		else children.set(info.ppid, [info]);
	}
	const out: ProcessInfo[] = [];
	const queue = [...(children.get(pid) ?? [])];
	while (queue.length > 0) {
		const next = queue.shift() as ProcessInfo;
		out.push(next);
		queue.push(...(children.get(next.pid) ?? []));
	}
	return out;
}

/** The binary a process is running, as an absolute path when the platform reports one. */
export function executablePath(info: ProcessInfo, platform: NodeJS.Platform = process.platform): string | undefined {
	if (platform === "linux") {
		try {
			return readlinkSync(`/proc/${info.pid}/exe`);
		} catch {
			return undefined;
		}
	}
	return info.comm.startsWith("/") ? info.comm : undefined;
}
