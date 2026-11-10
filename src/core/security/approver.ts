import { spawn } from "node:child_process";

export type Decision = "approved" | "denied" | "unavailable";

export interface ApprovalRequest {
  description: string;
  seconds: number;
  signal: AbortSignal;
  kind?: "approval" | "handoff";
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
  kind: "approval" | "handoff" = "approval",
): DialogCommand[] {
  const approve = kind === "handoff" ? "Continuar" : APPROVE;
  const reject = kind === "handoff" ? "Cancelar" : REJECT;
  if (platform === "darwin") {
    return [
      {
        command: "osascript",
        args: [
          "-e",
          "on run argv",
          "-e",
          `set r to display dialog (item 1 of argv) with title "CuyBrowser" buttons {"${reject}", "${approve}"} default button "${reject}" with icon caution giving up after (item 2 of argv as integer)`,
          "-e",
          'return (button returned of r) & "|" & (gave up of r)',
          "-e",
          "end run",
          text,
          String(seconds),
        ],
        interpret: (code, stdout) => {
          if (code !== 0) return null;
          return stdout.trim() === `${approve}|false` ? "approved" : "denied";
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
          kind === "handoff"
            ? "Add-Type -AssemblyName PresentationFramework; $w = New-Object System.Windows.Window; $w.Title = 'CuyBrowser'; $w.SizeToContent = 'WidthAndHeight'; $w.WindowStartupLocation = 'CenterScreen'; $p = New-Object System.Windows.Controls.StackPanel; $p.Margin = 20; $t = New-Object System.Windows.Controls.TextBlock; $t.Text = $env:CUYBROWSER_DIALOG_TEXT; $t.TextWrapping = 'Wrap'; $t.Width = 480; $p.Children.Add($t) | Out-Null; $no = New-Object System.Windows.Controls.Button; $no.Content = 'Cancelar'; $no.IsCancel = $true; $no.IsDefault = $true; $no.Add_Click({ $w.DialogResult = $false }); $p.Children.Add($no) | Out-Null; $yes = New-Object System.Windows.Controls.Button; $yes.Content = 'Continuar'; $yes.Add_Click({ $w.DialogResult = $true }); $p.Children.Add($yes) | Out-Null; $w.Content = $p; if ($w.ShowDialog()) { 'Yes' } else { 'No' }"
            : "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show($env:CUYBROWSER_DIALOG_TEXT, 'CuyBrowser', 'YesNo', 'Warning', 'No')",
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
        `--ok-label=${approve}`,
        `--cancel-label=${reject}`,
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
      args: ["--title", "CuyBrowser", "--yes-label", approve, "--no-label", reject, "--yesno", text],
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
    async request({ description, seconds, signal, kind = "approval" }) {
      const text = kind === "handoff"
        ? `El agente espera tu intervención:\n\n${description}\n\nHaz tu parte en el navegador y pulsa Continuar. Puedes cancelar el relevo.`
        : `Un agente de IA pide permiso para esta acción:\n\n${description}\n\nApruébala solo si la has pedido tú.`;
      for (const dialog of dialogCommands(platform, text, seconds, process.env, kind)) {
        const decision = await run(dialog, signal);
        if (decision) return decision;
      }
      return "unavailable";
    },
  };
}
