export type EventType = "console" | "network" | "dialog" | "navigation" | "download";

export interface BrowserEvent {
  seq: number;
  time: string;
  type: EventType;
  tab: string;
  data: Record<string, unknown>;
}

const MAX_EVENTS = 2000;

export class EventBuffer {
  private seq = 0;
  private items: BrowserEvent[] = [];
  private listeners = new Set<(event: BrowserEvent) => void>();

  push(type: EventType, tab: string, data: Record<string, unknown>): void {
    const event: BrowserEvent = { seq: ++this.seq, time: new Date().toISOString(), type, tab, data };
    this.items.push(event);
    if (this.items.length > MAX_EVENTS) this.items.shift();
    for (const listener of this.listeners) listener(event);
  }

  list(type: EventType, since = 0): BrowserEvent[] {
    return this.items.filter((event) => event.type === type && event.seq > since);
  }

  get lastSeq(): number {
    return this.seq;
  }

  subscribe(listener: (event: BrowserEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
