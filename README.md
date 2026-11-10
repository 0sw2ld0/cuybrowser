# CuyBrowser

Control de un navegador del motor de Chrome para agentes de IA, con un único núcleo y varias interfaces. La especificación completa está en [ESPEC-cuybrowser.md](ESPEC-cuybrowser.md).

> **Estado: versión 0.4.0, de prueba. No está en npm.** Antes de enviar formularios, comprar, subir o descargar archivos, o ejecutar JavaScript, CuyBrowser pide tu aprobación en un diálogo del sistema. Esa detección es una heurística: un botón de una aplicación web que no pertenezca a un formulario ni parezca una compra se pulsa sin preguntar, así que supervisa al agente en cuentas importantes. El uso real solo se ha probado en macOS. En Linux y Windows se ejecutan las pruebas automáticas, que usan un aprobador simulado en lugar del diálogo del sistema.

## Requisitos

- Node.js 20 o superior
- Un navegador del motor de Chrome: Google Chrome, Microsoft Edge, Brave, Chromium o Arc. Si no tienes ninguno, CuyBrowser puede descargar su propio Chromium una sola vez, cuando tú se lo pidas ([más abajo](#navegador)). No hace falta ninguna extensión: lo abre con un perfil propio, separado del tuyo
- macOS. Linux necesita `zenity` o `kdialog` para aprobar acciones. En Linux y Windows solo se ejecutan las pruebas automáticas; el uso real no se ha probado

## Instalación

**Con Node.js 20 o superior:**

```bash
npm install -g https://github.com/0sw2ld0/cuybrowser/releases/download/v0.4.0/cuybrowser-0.4.0.tgz
```

**Sin Node.js**, con el binario de tu plataforma, publicado en [Releases](https://github.com/0sw2ld0/cuybrowser/releases). Por ejemplo, en un Mac con Apple Silicon:

```bash
curl -fLo cuybrowser https://github.com/0sw2ld0/cuybrowser/releases/download/v0.4.0/cuybrowser-macos-arm64 && chmod +x cuybrowser
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

## Navegador

`cuybrowser start` abre Google Chrome. Si no está instalado, prueba en este orden los que haya: Microsoft Edge, Brave, Chromium, Arc y, por último, el Chromium de Playwright si lo descargaste. Si uno no se abre, pasa al siguiente y lo avisa. La respuesta de `start` y la de `status` dicen cuál se usa en `browser` y dónde está en `browser_path`.

Cada navegador tiene su propio perfil aislado en `~/.cuybrowser/profiles/`. El de Chrome sigue en la misma carpeta que en las versiones anteriores, así que conserva tus sesiones. Los demás llevan el nombre del navegador detrás, como `default.msedge`. Nunca se usa tu perfil personal.

Para ver qué navegadores encuentra y cuál usará, marcado con `*`:

```bash
cuybrowser browsers
```

Para fijar uno, usa `--browser` con `chrome`, `msedge`, `brave`, `chromium`, `arc` o la ruta del ejecutable. Así solo se prueba ese; `chromium` abarca el del sistema y, después, el de Playwright:

```bash
cuybrowser start --browser brave
```

```bash
cuybrowser start --browser "/Applications/Vivaldi.app"
```

También puedes fijarlo con la variable `CUYBROWSER_BROWSER`, por ejemplo en la configuración MCP de tu agente. `--browser` tiene preferencia.

**Sin ningún navegador compatible**, `start` responde `NO_BROWSER` y explica qué hacer. CuyBrowser nunca descarga nada por su cuenta. Para descargar una sola vez el Chromium de Playwright, unos 190 MB de descarga y 370 MB en disco, ejecuta:

```bash
cuybrowser install-browser
```

Te pide confirmación; con `--yes` no la pide. Se guarda en `~/.cuybrowser/browsers/`, o en `PLAYWRIGHT_BROWSERS_PATH` si la tienes definida. En Linux puede necesitar además las bibliotecas del sistema que lista `npx playwright install-deps chromium`.

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

Si creaste la skill con una versión anterior, vuelve a crearla para tener las instrucciones actuales. Después de crearla, reinicia VS Code por completo para que reciba el `PATH` actualizado y detecte la skill. Comprueba desde su terminal integrada que encuentra el binario:

```bash
cuybrowser --version
```

Abre el chat de Copilot en modo agente, escribe `/`, elige `cuybrowser` y añade tu tarea:

```text
/cuybrowser abre example.com y dime qué dice el título
```

Copilot ejecutará comandos como `cuybrowser navigate` en la terminal, y VS Code puede pedirte permiso para cada uno. Revisa que sean comandos de `cuybrowser` y no las herramientas de navegador integradas de VS Code.

Si se abre el navegador integrado de VS Code en lugar del de CuyBrowser, abre primero un chat nuevo, porque un chat ya abierto puede no haber cargado la skill. Solo si sigue pasando, ejecuta **Preferences: Open User Settings (JSON)** en la paleta de comandos y añade este ajuste. Afecta a todos tus proyectos: para recuperar ese navegador en el chat, bórralo:

```json
"workbench.browser.enableChatTools": false
```

## Seguridad

La política está en `~/.cuybrowser/policy.yaml`. Se crea en el primer arranque y los cambios se aplican en la siguiente acción. Si el archivo no es válido, se bloquean las acciones hasta corregirlo.

- **Aprobación:** con `CONFIRMATION_REQUIRED` la acción queda retenida y `confirm` te pregunta. El canal por defecto es `native-dialog`. `elicitation` y `cli` son opcionales y dan menos garantía, porque un cliente MCP o un agente con terminal podría responder por ti.
- **Dominios:** `domains.deny` gana a `domains.allow`, y `*.banco.com` incluye `banco.com` y sus subdominios. Con alguna regla activa, el navegador trabaja sin caché HTTP. Con la política tradicional de dominios, una redirección prohibida se cancela al detectarla y ese servidor puede llegar a recibir la petición. Para detenerla antes del contacto, usa la política por origen de abajo.
- **Auditoría:** cada acción se registra en `~/.cuybrowser/audit.jsonl`, sin guardar el texto escrito.
- **Descargas:** quedan en `~/.cuybrowser/quarantine/` hasta aprobarlas y pasan a `~/.cuybrowser/downloads/`.

**Límites conocidos:** un agente con acceso libre a tus archivos puede editar `policy.yaml`, así que para ese caso hay que aislarlo a nivel de sistema operativo. El aviso de prompt injection es orientativo y no detecta todos los ataques.

### Orígenes exactos y red local

Los clientes que necesitan separar esquema, dominio y puerto pueden añadir estas secciones opcionales:

```yaml
origins:
  allow: ["https://example.com", "http://127.0.0.1:8000"]
  deny: []
local_network:
  allow_origins: ["http://127.0.0.1:8000"]
```

Un origen no admite rutas, credenciales ni comodines. `https://example.com`,
`http://example.com` y `https://example.com:8443` son permisos distintos.
`origins.deny` gana; las reglas de `domains` también se siguen aplicando.
Si `origins` está presente con `allow: []`, no se autoriza ningún documento HTTP(S).
Si se omite, se mantiene la compatibilidad con la política anterior.

Esta barrera requiere `launch` con un perfil propio y se instala antes de navegar.
Cada documento y cada salto HTTP se comprueban antes de contactar con su destino.
Las ventanas nuevas que aún no tienen la barrera y los marcos de otro origen se
bloquean de forma conservadora. Se desactivan los service workers y la restauración
automática de pestañas de ese perfil; se conservan sus cookies. Activarla sobre un
navegador ya abierto lo detiene y exige volver a iniciarlo. No está disponible en `attach`.

El permiso de sitio no concede acceso a la red local. Si `local_network` está
presente, un proxy privado autenticado controla HTTP, CONNECT y WebSocket,
incluidos los workers, fija la IP después de resolver DNS y bloquea destinos
privados salvo aprobación explícita. No descifra TLS ni instala certificados.
WebRTC no puede abrir UDP directo fuera de ese proxy en un perfil protegido.
En HTTP se admite también una petición de una página local aprobada; en CONNECT,
que no muestra el origen de la página, hace falta aprobar el destino por host y
puerto. Esta protección cubre esas conexiones, no es un cortafuegos del sistema.

Para una visita temporal, el cliente puede enviar `origins.visit` con un `id`
único y un `origin` exacto. Caduca al confirmar una navegación a otro origen o al
cerrar la pestaña; un intento bloqueado no la consume. `status.consumed_visits`
permite retirar el permiso del archivo de política antes de reiniciar el servicio.
Los identificadores consumidos no vuelven a autorizar dentro del mismo servicio.

`policy_show.capabilities` anuncia `exactOrigins`, `localNetwork` y `visitLeases`.
`strictResources` es `false`: esta versión no restringe todos los subrecursos
públicos al origen de la página. Un cliente que necesite ese modo debe rechazarlo.

## Sesiones en sitios con inicio de sesión

El agente no puede escribir contraseñas. Inicia el navegador con ventana, entra a tu cuenta a mano y la sesión queda guardada en el perfil aislado:

```bash
cuybrowser start --profile trabajo
```

## Conectar con un Chrome ya abierto

Con el modo `attach`, CuyBrowser controla un Chrome que abriste tú, en lugar de abrir el suyo. El agente verá todas las pestañas y sesiones de ese Chrome, así que está deshabilitado por defecto. Para habilitarlo, añade esto a `~/.cuybrowser/policy.yaml`:

```yaml
attach:
  enabled: true
```

Abre Chrome con el puerto de depuración. Desde la versión 136, Chrome ignora ese puerto en tu perfil habitual, así que necesita una carpeta de datos propia. En macOS:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/.chrome-attach"
```

Conecta CuyBrowser. Sin `--cdp`, usa `http://127.0.0.1:9222`:

```bash
cuybrowser start --mode attach
```

- El agente trabaja en una pestaña nueva y puede elegir otra con `tab_select`.
- `cuybrowser stop` solo se desconecta: Chrome sigue abierto con sus pestañas.
- Mientras está conectado, las reglas de dominios afectan a todas las pestañas, también a las que uses tú. Lo mismo pasa con las descargas: todas quedan en cuarentena hasta que las apruebas.
- No se ha comprobado que Chrome vuelva a guardar las descargas como siempre después de desconectar. Si no lo hace, reinícialo.
- Solo se admite un Chrome de este equipo. El puerto de depuración permite controlar ese Chrome a cualquier programa de tu equipo, así que cierra Chrome cuando termines.

## Compilar el binario

Necesitas Git y Node.js 20 o superior. Para usar el binario, también un [navegador compatible](#navegador).

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

No necesitas `sudo`. Copia el binario a una carpeta de tu usuario. El `rm -f` evita que macOS mate el binario nuevo si el anterior sigue en ejecución:

```bash
mkdir -p ~/.local/bin && rm -f ~/.local/bin/cuybrowser && cp release/cuybrowser ~/.local/bin/cuybrowser
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

### Actualizar

Desde la carpeta que clonaste, detén el proceso en segundo plano. También cierra el navegador:

```bash
cuybrowser daemon stop
```

Trae los cambios, recompila y reemplaza el binario:

```bash
git pull && npm install && npm run build:bin -- --current && rm -f ~/.local/bin/cuybrowser && cp release/cuybrowser ~/.local/bin/cuybrowser
```

Con Yarn:

```bash
git pull && yarn install && yarn build:bin --current && rm -f ~/.local/bin/cuybrowser && cp release/cuybrowser ~/.local/bin/cuybrowser
```

Regenera la skill por si cambiaron sus instrucciones, y abre un chat nuevo en tu agente:

```bash
cuybrowser docs --format skill-md > ~/.copilot/skills/cuybrowser/SKILL.md
```

Si `cuybrowser` termina con `zsh: killed`, el binario se copió encima de uno que seguía en ejecución. Cierra los procesos que queden y vuelve a copiarlo:

```bash
pkill -f '\.local/bin/cuybrowser'; rm -f ~/.local/bin/cuybrowser && cp release/cuybrowser ~/.local/bin/cuybrowser
```

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

### Relevo a la persona

Con una ventana de CuyBrowser abierta, `cuybrowser handoff "Inicia sesión en esta página"` cede la pestaña activa a la persona. Un diálogo del sistema muestra el sitio y el motivo: haz tu parte en el navegador y pulsa **Continuar**, o **Cancelar**. El relevo termina como máximo a los dos minutos y devuelve la URL y el título actuales como datos de la página.

Durante la espera, las acciones del agente se rechazan con `HANDOFF_ACTIVE`; `status` permite consultar el estado y `stop` cancela el relevo. Funciona con el diálogo nativo aunque la política use otro canal de aprobación. No funciona con `headless`. Para contraseñas, 2FA y captchas, usa este relevo: el agente no los completa ni resuelve por su cuenta.

Con el repositorio clonado e instalado:

```bash
npm test
```

Las pruebas E2E abren el primer navegador compatible, sin ventana, contra fixtures locales y usan un directorio temporal, sin tocar `~/.cuybrowser`.

La CI de GitHub Actions ejecuta las pruebas en macOS, Linux y Windows en cada pull request y en cada push a `main`.

### Publicar una versión

Cambia la versión en `package.json` y `package-lock.json`:

```bash
npm version 0.4.0 --no-git-tag-version
```

Pon la misma en `src/core/version.ts`, porque una prueba comprueba que coinciden. Actualiza también las URLs de instalación de este README y haz commit.

El PR de versión se revisa y se fusiona antes de etiquetar. La etiqueta y la publicación requieren el visto bueno explícito de la persona responsable. Hasta entonces, deja preparados estos comandos sin ejecutarlos:

Crea el tag y súbelo solo tras esa aprobación:

```bash
git tag v0.4.0 && git push origin v0.4.0
```

El workflow `Release` comprueba que el tag coincide con la versión, ejecuta las pruebas y compila los binarios y el paquete `.tgz` con su `SHA256SUMS`. Después crea un borrador de release en GitHub: revísalo y publícalo desde allí.

## Licencia

[MIT](LICENSE)
