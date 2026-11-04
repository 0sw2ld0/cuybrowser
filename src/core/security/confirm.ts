import { randomBytes } from "node:crypto";
import { CuyError, type ToolResponse } from "../errors.js";
import type { Decision } from "./approver.js";

const EXPIRY_MS = 2 * 60_000;

export interface PendingConfirmation {
  id: string;
  description: string;
  expiresAt: number;
  abort: AbortController;
  execute: () => Promise<ToolResponse>;
  /** Limpia lo retenido si la acción no llega a ejecutarse. */
  discard: () => void;
  /** Decisión en curso; se comparte para no abrir otro diálogo al reintentar. */
  decision: Promise<Decision> | null;
  settleManually: ((decision: Decision) => void) | null;
  manualDecision: Promise<Decision>;
  manuallyDecided: boolean;
  timer: NodeJS.Timeout;
}

function denied(message: string): CuyError {
  return new CuyError("CONFIRMATION_DENIED", message);
}

export class ConfirmationStore {
  private items = new Map<string, PendingConfirmation>();
  private used = new Set<string>();

  create(
    description: string,
    execute: () => Promise<ToolResponse>,
    discard: () => void = () => {},
  ): PendingConfirmation {
    const id = randomBytes(8).toString("hex");
    let settle: ((decision: Decision) => void) | null = null;
    const manualDecision = new Promise<Decision>((resolve) => (settle = resolve));
    const pending: PendingConfirmation = {
      id,
      description,
      expiresAt: Date.now() + EXPIRY_MS,
      abort: new AbortController(),
      execute,
      discard,
      decision: null,
      settleManually: settle,
      manualDecision,
      manuallyDecided: false,
      timer: setTimeout(() => this.expire(id), EXPIRY_MS),
    };
    pending.timer.unref();
    this.items.set(id, pending);
    return pending;
  }

  private expire(id: string): void {
    const pending = this.items.get(id);
    if (!pending) return;
    pending.abort.abort();
    pending.settleManually?.("denied");
    this.drop(pending, true);
  }

  private drop(pending: PendingConfirmation, discard: boolean): void {
    clearTimeout(pending.timer);
    this.items.delete(pending.id);
    if (discard) pending.discard();
  }

  get(id: string): PendingConfirmation | undefined {
    return this.items.get(id);
  }

  /** Devuelve la solicitud vigente o explica por qué ya no se puede usar. */
  require(id: string): PendingConfirmation {
    const pending = this.items.get(id);
    if (pending) return pending;
    if (this.used.has(id)) {
      throw denied("Esta confirmación ya se usó. Revisa el estado de la página antes de repetir la acción.");
    }
    throw denied("La confirmación no existe o ha expirado.");
  }

  resolveManually(id: string, approved: boolean): void {
    const pending = this.require(id);
    pending.manuallyDecided = true;
    pending.settleManually?.(approved ? "approved" : "denied");
    pending.settleManually = null;
  }

  /** Solo un llamador consume la aprobación: es lo que hace de un solo uso a cada id. */
  consume(pending: PendingConfirmation): void {
    if (!this.items.has(pending.id)) {
      throw denied("Esta confirmación ya se usó. Revisa el estado de la página antes de repetir la acción.");
    }
    this.used.add(pending.id);
    this.drop(pending, false);
  }

  reject(pending: PendingConfirmation): void {
    if (this.items.has(pending.id)) this.drop(pending, true);
  }

  discardAll(): void {
    for (const pending of [...this.items.values()]) {
      pending.abort.abort();
      pending.settleManually?.("denied");
      this.drop(pending, true);
    }
  }
}
