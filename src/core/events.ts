export type EventType = "console" | "network" | "dialog" | "navigation" | "download";

/** Se devuelven los más recientes: el agente suele querer saber qué acaba de pasar. */
export function latest<T>(events: T[], limit: number, warnings: string[]): T[] {
  if (events.length <= limit) return events;
  warnings.push(`Se muestran los ${limit} eventos más recientes de ${events.length}. Usa since, un filtro o un limit mayor.`);
  return events.slice(-limit);
}

export interface BrowserEvent {
  seq: number;
  time: string;
  type: EventType;
  tab: string;
  data: Record<string, unknown>;
}

/** Por tipo: una página con mucho tráfico de red no debe expulsar los mensajes de consola ni los diálogos. */
export const MAX_EVENTS_PER_TYPE = 1000;

export class EventBuffer {
  private seq = 0;
  private items = new Map<EventType, BrowserEvent[]>();
  private listeners = new Set<(event: BrowserEvent) => void>();

  push(type: EventType, tab: string, data: Record<string, unknown>): void {
    const event: BrowserEvent = { seq: ++this.seq, time: new Date().toISOString(), type, tab, data };
    let list = this.items.get(type);
    if (!list) this.items.set(type, (list = []));
    list.push(event);
    if (list.length > MAX_EVENTS_PER_TYPE) list.shift();
    for (const listener of this.listeners) listener(event);
  }

  list(type: EventType, since = 0): BrowserEvent[] {
    return (this.items.get(type) ?? []).filter((event) => event.seq > since);
  }

  get lastSeq(): number {
    return this.seq;
  }

  subscribe(listener: (event: BrowserEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
