export class TTLCache<V> {
	private entries = new Map<string, { value: V; expires: number }>();

	constructor(private ttlSeconds: number) {}

	set(key: string, value: V): void {
		this.entries.set(key, { value, expires: Date.now() + this.ttlSeconds });
	}

	get(key: string): V | undefined {
		const entry = this.entries.get(key);
		if (!entry || entry.expires < Date.now()) return undefined;
		return entry.value;
	}
}
