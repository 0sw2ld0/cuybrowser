import { spawn } from "node:child_process";

export type Decision = "approved" | "denied" | "unavailable";

export interface ApprovalRequest {
  description: string;
  seconds: number;
  signal: AbortSignal;
}

export interface Approver {
  request(request: ApprovalRequest): Promise<Decision>;
}

export interface DialogCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** null significa que el diálogo no se pudo mostrar. */
  interpret: (code: number | null, stdout: string) => Decision | null;
}

const APPROVE = "Aprobar";
const REJECT = "Rechazar";

/** El texto contiene datos de la página: siempre viaja como argumento o variable, nunca dentro de un script. */
export function dialogCommands(
  platform: NodeJS.Platform,
  text: string,
  seconds: number,
  env: NodeJS.ProcessEnv = process.env,
): DialogCommand[] {
  if (platform === "darwin") {
    return [
      {
        command: "osascript",
        args: [
          "-e",
          "on run argv",
          "-e",
          `set r to display dialog (item 1 of argv) with title "CuyBrowser" buttons {"${REJECT}", "${APPROVE}"} default button "${REJECT}" with icon caution giving up after (item 2 of argv as integer)`,
          "-e",
          'return (button returned of r) & "|" & (gave up of r)',
          "-e",
          "end run",
          text,
          String(seconds),
        ],
        interpret: (code, stdout) => {
          if (code !== 0) return null;
          return stdout.trim() === `${APPROVE}|false` ? "approved" : "denied";
        },
      },
    ];
  }
  if (platform === "win32") {
    return [
      {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show($env:CUYBROWSER_DIALOG_TEXT, 'CuyBrowser', 'YesNo', 'Warning', 'No')",
        ],
        env: { CUYBROWSER_DIALOG_TEXT: text },
        interpret: (code, stdout) => {
          if (code !== 0) return null;
          return stdout.trim() === "Yes" ? "approved" : "denied";
        },
      },
    ];
  }
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return [];
  return [
    {
      command: "zenity",
      args: [
        "--question",
        "--no-markup",
        "--title=CuyBrowser",
        `--text=${text}`,
        `--ok-label=${APPROVE}`,
        `--cancel-label=${REJECT}`,
        "--default-cancel",
        `--timeout=${seconds}`,
      ],
      interpret: (code) => {
        if (code === 0) return "approved";
        return code === 1 || code === 5 ? "denied" : null;
      },
    },
    {
      command: "kdialog",
      args: ["--title", "CuyBrowser", "--yes-label", APPROVE, "--no-label", REJECT, "--yesno", text],
      interpret: (code) => {
        if (code === 0) return "approved";
        return code === 1 ? "denied" : null;
      },
    },
  ];
}

function run(dialog: DialogCommand, signal: AbortSignal): Promise<Decision | null> {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn(dialog.command, dialog.args, {
      env: { ...process.env, ...dialog.env },
      stdio: ["ignore", "pipe", "ignore"],
      signal,
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.once("error", (err) => {
      resolve(err.name === "AbortError" ? "denied" : null);
    });
    child.once("close", (code) => {
      resolve(signal.aborted ? "denied" : dialog.interpret(code, stdout));
    });
  });
}

export function createNativeApprover(platform: NodeJS.Platform = process.platform): Approver {
  return {
    async request({ description, seconds, signal }) {
      const text = `Un agente de IA pide permiso para esta acción:\n\n${description}\n\nApruébala solo si la has pedido tú.`;
      for (const dialog of dialogCommands(platform, text, seconds)) {
        const decision = await run(dialog, signal);
        if (decision) return decision;
      }
      return "unavailable";
    },
  };
}
