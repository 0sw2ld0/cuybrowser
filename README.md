# CuyBrowser

Control de Chrome para agentes de IA, con un único núcleo y varias interfaces. La especificación completa está en [ESPEC-cuybrowser.md](ESPEC-cuybrowser.md).

> **Estado: versión 0.1.0, de prueba. No está en npm.** Antes de enviar formularios, comprar, subir o descargar archivos, o ejecutar JavaScript, CuyBrowser pide tu aprobación en un diálogo del sistema. Esa detección es una heurística: un botón de una aplicación web que no pertenezca a un formulario ni parezca una compra se pulsa sin preguntar, así que supervisa al agente en cuentas importantes. Solo se ha probado en macOS; Linux y Windows están implementados pero sin probar.

## Requisitos

- Node.js 20 o superior
- Google Chrome instalado
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

## Binarios

Son ejecutables únicos que no necesitan Node.js, aunque sí Google Chrome. Para compilarlos desde el código, en `release/` y junto con `SHA256SUMS`:

```bash
npm run build:bin
```

Cada uno ocupa entre 97 y 123 MB. Los binarios no están firmados: macOS bloqueará uno descargado con un navegador hasta que lo autorices en Ajustes del Sistema, y Windows puede mostrar un aviso. Solo el de macOS arm64 se ha probado.

## Desarrollo

```bash
git clone https://github.com/0sw2ld0/cuybrowser.git && cd cuybrowser && npm install
```

```bash
npm test
```

Las pruebas E2E abren Chrome sin ventana contra fixtures locales y usan un directorio temporal, sin tocar `~/.cuybrowser`.

## Licencia

[MIT](LICENSE)
