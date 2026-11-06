import { CuyError } from "../errors.js";

export interface RefTarget {
  backendNodeId: number;
  frameKey: string;
}

/** Solo sirven para explicar mejor el error; en una sesión larga no deben crecer sin límite. */
export const MAX_STALE_REFS = 10_000;

function mapKey(frameKey: string, backendNodeId: number): string {
  return `${frameKey}:${backendNodeId}`;
}

/** Refs de una pestaña. Nunca se reutilizan, así una ref antigua no apunta a otro nodo. */
export class RefTable {
  private counter = 0;
  private refToNode = new Map<string, RefTarget>();
  private nodeToRef = new Map<string, string>();
  private stale = new Set<string>();

  /** Los elementos de un iframe llevan el prefijo de su frame, como f1e7. */
  refFor(backendNodeId: number, frameKey = ""): string {
    const key = mapKey(frameKey, backendNodeId);
    const existing = this.nodeToRef.get(key);
    if (existing) return existing;
    const ref = `${frameKey}e${++this.counter}`;
    this.refToNode.set(ref, { backendNodeId, frameKey });
    this.nodeToRef.set(key, ref);
    return ref;
  }

  resolve(ref: string): RefTarget {
    const target = this.refToNode.get(ref);
    if (target) return target;
    if (this.stale.has(ref)) {
      throw new CuyError(
        "REF_STALE",
        `La ref ${ref} pertenece a un documento anterior.`,
        "Toma un snapshot nuevo.",
      );
    }
    throw new CuyError("REF_NOT_FOUND", `La ref ${ref} no existe.`, "Toma un snapshot nuevo.");
  }

  /** Sin argumento invalida todo; con un frame, solo sus refs. */
  invalidate(frameKey?: string): void {
    for (const [ref, target] of this.refToNode) {
      if (frameKey !== undefined && target.frameKey !== frameKey) continue;
      this.stale.add(ref);
      this.refToNode.delete(ref);
      this.nodeToRef.delete(mapKey(target.frameKey, target.backendNodeId));
    }
    // Un Set recorre en orden de inserción: se olvidan primero las más antiguas.
    for (const ref of this.stale) {
      if (this.stale.size <= MAX_STALE_REFS) break;
      this.stale.delete(ref);
    }
  }
}
