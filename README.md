# CuyBrowser

Control de Chrome para agentes de IA, con un único núcleo y varias interfaces. La especificación completa está en [ESPEC-cuybrowser.md](ESPEC-cuybrowser.md).

> **Estado: versión 0.1.0, de prueba. No está en npm.** Antes de enviar formularios, comprar, subir o descargar archivos, o ejecutar JavaScript, CuyBrowser pide tu aprobación en un diálogo del sistema. Esa detección es una heurística: un botón de una aplicación web que no pertenezca a un formulario ni parezca una compra se pulsa sin preguntar, así que supervisa al agente en cuentas importantes. Solo se ha probado en macOS; Linux y Windows están implementados pero sin probar.

## Requisitos

- Node.js 20 o superior
- Google Chrome instalado. No hace falta ninguna extensión: CuyBrowser lo abre con un perfil propio, separado del tuyo
- macOS. Linux necesita `zenity` o `kdialog` para aprobar acciones. Linux y Windows están implementados, pero sin probar

## Instalación

**Con Node.js 20 o superior:**

```bash
npm install -g https://github.com/0sw2ld0/cuybrowser/releases/download/v0.1.0/cuybrowser-0.1.0.tgz
```

**Sin Node.js**, con el binario de tu plataforma, publicado en [Releases](https://github.com/0sw2ld0/cuybrowser/releases). Por ejemplo, en un Mac con Apple Silicon:

```bash
curl -fLo cuybrowser https://github.com/0sw2ld0/cuybrowser/releases/download/v0.1.0/cuybrowser-macos-arm64 && chmod +x cuybrowser
```

Usa `cuybrowser-macos-x64`, `cuybrowser-linux-x64`, `cuybrowser-linux-arm64` o `cuybrowser-windows-x64.exe` según tu equipo, y ejecútalo como `./cuybrowser`. Las sumas de comprobación están en `SHA256SUMS`.

## Uso

```bash
cuybrowser start
```

```bash
cuybrowser navigate https://example.com
```

```bash
cuybrowser snapshot
```

Las refs del snapshot sirven para actuar sobre la página:

```bash
cuybrowser click e6
```

Para ver solo lo que cambió, o buscar un elemento en una página grande:

```bash
cuybrowser snapshot --diff
```

```bash
cuybrowser find "Crear"
```

```bash
cuybrowser type e3 "hola@correo.com" --submit
```

```bash
cuybrowser screenshot --out captura.png
```

Si el texto empieza por un guion, sepáralo con `--`: `cuybrowser type e3 -- "-texto"`.

Añade `--json` a cualquier comando para obtener la respuesta completa. `cuybrowser --help` lista todos los comandos.

El daemon arranca solo y se detiene tras 30 minutos de inactividad. Para detenerlo antes, por ejemplo después de recompilar:

```bash
cuybrowser daemon stop
```

## MCP

Las herramientas se publican con el prefijo `browser_`, que se puede cambiar con `--prefix`. Instálalo antes de forma global o usa la ruta absoluta del binario.

**Claude Code:**

```bash
claude mcp add cuybrowser -- cuybrowser mcp
```

**Claude Desktop** (`claude_desktop_config.json`) y **Cursor** (`~/.cursor/mcp.json`) usan el mismo bloque:

```json
{
  "mcpServers": {
    "cuybrowser": {
      "command": "cuybrowser",
      "args": ["mcp"]
    }
  }
}
```

## API HTTP

Solo escucha en `127.0.0.1`, exige el token de `~/.cuybrowser/token` y rechaza las peticiones con cabecera `Origin`.

```bash
cuybrowser serve --http
```

```bash
curl -s -H "Authorization: Bearer $(cat ~/.cuybrowser/token)" -d '{"url":"https://example.com"}' http://127.0.0.1:47777/v1/tools/navigate
```

`GET /v1/tools` lista las herramientas con su JSON Schema y `GET /v1/events` emite eventos por SSE.

## Agentes sin MCP

[docs/AGENTS.md](docs/AGENTS.md) explica la herramienta a un agente con terminal. Se genera desde el registro:

```bash
cuybrowser docs --format agents-md
```

### GitHub Copilot CLI

Sin probar todavía con Copilot. Primero instala `cuybrowser` y asegúrate de que esté en tu `PATH`. Si lo compilaste, sigue [estos pasos](#instalarlo-en-tu-path). Luego crea una skill personal, disponible en todos tus proyectos:

```bash
mkdir -p ~/.copilot/skills/cuybrowser && cuybrowser docs --format skill-md > ~/.copilot/skills/cuybrowser/SKILL.md
```

Abre Copilot con `gh copilot` o `copilot`, comprueba que la skill aparece con `/skills list` y pídele una tarea:

```text
/cuybrowser abre example.com y dime qué dice el título
```

Si la sesión ya estaba abierta al crear la skill, ejecuta antes `/skills reload`. Copilot también puede usarla solo cuando tu petición lo requiera.

Para compartirla con quienes usen un repositorio, créala dentro de él:

```bash
mkdir -p .github/skills/cuybrowser && cuybrowser docs --format skill-md > .github/skills/cuybrowser/SKILL.md
```

Copilot puede pedirte permiso para cada comando. Las acciones delicadas siguen necesitando tu aprobación en el diálogo de CuyBrowser. Comprueba también que Copilot espera a que respondas: `confirm` no termina hasta entonces.

### Copilot en VS Code

Sin probar todavía en VS Code. Usa la misma skill personal de la sección anterior, sin configurar MCP.

VS Code tiene un navegador integrado y Copilot puede usarlo en lugar de CuyBrowser. Para evitarlo, ejecuta **Preferences: Open User Settings (JSON)** en la paleta de comandos y añade este ajuste. Afecta a todos tus proyectos: para recuperar ese navegador en el chat, bórralo:

```json
"workbench.browser.enableChatTools": false
```

Si creaste la skill con una versión anterior, vuelve a crearla para tener las instrucciones actuales. Después de crearla, reinicia VS Code por completo para que reciba el `PATH` actualizado y detecte la skill. Comprueba desde su terminal integrada que encuentra el binario:

```bash
cuybrowser --version
```

Abre el chat de Copilot en modo agente, escribe `/`, elige `cuybrowser` y añade tu tarea:

```text
/cuybrowser abre example.com y dime qué dice el título
```

Copilot ejecutará comandos como `cuybrowser navigate` en la terminal, y VS Code puede pedirte permiso para cada uno. Revisa que sean comandos de `cuybrowser` y no las herramientas de navegador integradas de VS Code.

## Seguridad

La política está en `~/.cuybrowser/policy.yaml`. Se crea en el primer arranque y los cambios se aplican en la siguiente acción. Si el archivo no es válido, se bloquean las acciones hasta corregirlo.

- **Aprobación:** con `CONFIRMATION_REQUIRED` la acción queda retenida y `confirm` te pregunta. El canal por defecto es `native-dialog`. `elicitation` y `cli` son opcionales y dan menos garantía, porque un cliente MCP o un agente con terminal podría responder por ti.
- **Dominios:** `domains.deny` gana a `domains.allow`, y `*.banco.com` incluye `banco.com` y sus subdominios. Con alguna regla activa, Chrome trabaja sin caché HTTP. Una redirección hacia un dominio prohibido se cancela al detectarla, así que ese servidor puede llegar a recibir la petición.
- **Auditoría:** cada acción se registra en `~/.cuybrowser/audit.jsonl`, sin guardar el texto escrito.
- **Descargas:** quedan en `~/.cuybrowser/quarantine/` hasta aprobarlas y pasan a `~/.cuybrowser/downloads/`.

**Límites conocidos:** un agente con acceso libre a tus archivos puede editar `policy.yaml`, así que para ese caso hay que aislarlo a nivel de sistema operativo. El aviso de prompt injection es orientativo y no detecta todos los ataques.

## Sesiones en sitios con inicio de sesión

El agente no puede escribir contraseñas. Inicia Chrome con ventana, entra a tu cuenta a mano y la sesión queda guardada en el perfil aislado:

```bash
cuybrowser start --profile trabajo
```

## Compilar el binario

Necesitas Git y Node.js 20 o superior. Para usar el binario, también Google Chrome.

```bash
git clone https://github.com/0sw2ld0/cuybrowser.git && cd cuybrowser && npm install
```

Compila solo para tu equipo. El resultado es `release/cuybrowser`:

```bash
npm run build:bin -- --current
```

Compruébalo:

```bash
./release/cuybrowser --version
```

### Instalarlo en tu `PATH`

No necesitas `sudo`. Copia el binario a una carpeta de tu usuario:

```bash
mkdir -p ~/.local/bin && cp release/cuybrowser ~/.local/bin/cuybrowser
```

Añade esa carpeta a tu `PATH`. Este comando es para zsh, el shell por defecto de macOS, y solo hace falta una vez:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
```

Comprueba que lo encuentra:

```bash
cuybrowser --version
```

Si tienes abierto un agente como Copilot, ciérralo y vuelve a abrirlo desde una terminal nueva para que reciba el `PATH` actualizado.

### Todas las plataformas

Para generar los binarios de todas las plataformas, con `SHA256SUMS`:

```bash
npm run build:bin
```

También puedes compilar con Yarn 1 en lugar de npm. Se ha probado con la versión 1.22. Necesitas npm igualmente, porque los scripts lo usan por dentro, y Yarn ignora `package-lock.json`, así que puede instalar versiones distintas de las dependencias:

```bash
git clone https://github.com/0sw2ld0/cuybrowser.git && cd cuybrowser && yarn install
```

```bash
yarn build:bin --current
```

Cada binario ocupa entre 97 y 123 MB, porque incluye su propio motor de ejecución. No están firmados: macOS bloqueará uno descargado con un navegador hasta que lo autorices en Ajustes del Sistema, y Windows puede mostrar un aviso. Solo el de macOS arm64 se ha probado.

## Desarrollo

Con el repositorio clonado e instalado:

```bash
npm test
```

Las pruebas E2E abren Chrome sin ventana contra fixtures locales y usan un directorio temporal, sin tocar `~/.cuybrowser`.

## Licencia

[MIT](LICENSE)
