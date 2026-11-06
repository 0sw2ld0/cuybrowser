# Especificación de construcción: CuyBrowser

> Herramienta para que agentes de IA controlen Chrome, utilizable **vía MCP** y **sin MCP** (CLI y HTTP local), con un único núcleo compartido.

---

## 1. Objetivo

Construir una herramienta que permita a cualquier agente de IA navegar, leer e interactuar con páginas web en Chrome, con tres interfaces de acceso equivalentes:

| Interfaz | Para quién |
|---|---|
| **MCP (stdio)** | Clientes MCP: Claude Desktop, Claude Code, Cursor, orquestadores propios |
| **CLI** (`cuybrowser <comando>`) | Agentes con acceso a terminal, guiados por un `AGENTS.md` / `SKILL.md` |
| **HTTP local** (`curl`) | Scripts, automatizaciones, cualquier lenguaje |

**Principio rector:** toda la lógica vive en un núcleo (daemon). Las tres interfaces son adaptadores delgados sin lógica propia. Una herramienta se define **una sola vez** y aparece automáticamente en las tres interfaces y en la documentación generada.

### Diferenciadores (prioridad del producto)
1. **Snapshots eficientes en tokens**: formato compacto con referencias y modo diff.
2. **Seguridad como característica central**: políticas de dominios, compuertas de confirmación, bloqueo de campos sensibles, marcado de contenido no confiable y auditoría.
3. **Paridad total entre interfaces**: el mismo comando da el mismo resultado por MCP, CLI o HTTP.

---

## 2. Stack técnico (v1)

- **Lenguaje:** TypeScript sobre Node.js ≥ 20.
- **Control del navegador:** `playwright-core` (sin descargar navegadores; usa el Chrome instalado vía `channel: "chrome"`) más sesiones CDP directas donde haga falta (árbol de accesibilidad, `backendNodeId`).
- **Esquemas:** `zod` como fuente única de verdad para parámetros y respuestas.
- **MCP:** SDK oficial `@modelcontextprotocol/sdk`, transporte stdio.
- **CLI:** `commander` o equivalente ligero.
- **HTTP:** servidor nativo de Node o `fastify`; solo escucha en `127.0.0.1`.
- **Distribución:** paquete npm (`npx cuybrowser`) y, en un hito posterior, binarios únicos con `bun build --compile` para macOS, Linux y Windows.
- **Plataformas:** macOS primero; Linux y Windows se incorporan en el hito 3.

---

## 3. Arquitectura

```
                ┌──────────────── daemon (núcleo) ────────────────┐
                │ Gestor de navegador (launch / attach)           │
                │ Registro de herramientas (zod)                  │
                │ Motor de snapshots y refs                       │
                │ Motor de políticas de seguridad                 │
                │ Buffer de eventos (consola, red, diálogos)      │
                │ Log de auditoría (JSONL)                        │
                └──────┬──────────────────┬──────────────────┬────┘
                       │ IPC              │ IPC              │
                 MCP server (stdio)    CLI client        HTTP API
```

### 3.1 Daemon
- Proceso de larga duración que mantiene **una conexión persistente** con Chrome.
- IPC con los clientes: socket Unix (`~/.cuybrowser/daemon.sock`) en macOS/Linux y named pipe en Windows.
- **Autoarranque:** si el CLI o el servidor MCP no encuentran el daemon, lo inician automáticamente.
- Se apaga tras N minutos de inactividad (configurable, por defecto 30).
- Mantiene el estado entre comandos: pestaña activa, mapa de refs del último snapshot y buffers de eventos.

### 3.2 Modos de navegador
1. **`launch`** (por defecto): abre Chrome con un perfil aislado en `~/.cuybrowser/profiles/<nombre>` mediante `launchPersistentContext`. Las sesiones iniciadas manualmente por el usuario persisten en ese perfil.
2. **`attach`**: se conecta a un Chrome ya lanzado con `--remote-debugging-port` mediante `connectOverCDP(url)`. Está deshabilitado salvo que la política tenga `attach.enabled: true`, solo admite URLs de este equipo (`127.0.0.1`, `localhost` o `[::1]`), trabaja en una pestaña nueva para no tocar la que usa la persona y `stop` solo se desconecta.
3. *(Fuera de v1)* **`extension`**: control del Chrome real del usuario a través de una extensión. Dejar la interfaz `BrowserDriver` preparada para añadirlo.

Toda la interacción con el navegador pasa por una interfaz `BrowserDriver`, para poder añadir modos sin tocar las herramientas.

### 3.3 Registro de herramientas (fuente única de verdad)

Cada herramienta se define así:

```ts
defineTool({
  name: "click",
  description: "Hace clic en un elemento identificado por su ref del último snapshot.",
  params: z.object({ ref: z.string() }),
  risk: "action",            // "read" | "action" | "sensitive"
  handler: async (ctx, { ref }) => { ... }
})
```

A partir del registro se generan automáticamente:
- las herramientas MCP (nombre, descripción y JSON Schema);
- los subcomandos del CLI (`cuybrowser click --ref e12`, con argumentos posicionales donde tenga sentido: `cuybrowser click e12`);
- las rutas HTTP (`POST /v1/tools/click` con cuerpo JSON);
- la documentación: `cuybrowser docs --format agents-md|skill-md|markdown`.

**Prohibido** implementar lógica dentro de los adaptadores MCP, CLI o HTTP.

### 3.4 Formato de respuesta común

```json
{ "ok": true, "data": { ... }, "warnings": [] }
{ "ok": false, "error": { "code": "REF_NOT_FOUND", "message": "...", "hint": "Toma un snapshot nuevo" } }
```

- El CLI muestra una salida legible por defecto y JSON con `--json`.
- Las imágenes se devuelven como contenido de imagen nativo en MCP, como ruta de archivo en el CLI (o base64 con `--base64`) y como base64 en HTTP.

**Códigos de error mínimos:** `NO_BROWSER`, `NO_TAB`, `REF_NOT_FOUND`, `REF_STALE`, `TIMEOUT`, `NAVIGATION_FAILED`, `BLOCKED_BY_POLICY`, `NOT_INTERACTABLE`, `DIALOG_OPEN`, `CONFIRMATION_REQUIRED`, `CONFIRMATION_DENIED`, `APPROVAL_UNAVAILABLE`, `SENSITIVE_FIELD`, `INVALID_PARAMS`, `INTERNAL`.

---

## 4. Herramientas v1

### Sesión y pestañas
| Herramienta | Parámetros | Devuelve |
|---|---|---|
| `start` | `mode?`, `profile?`, `cdp_url?`, `headless?` | estado |
| `stop` | — | ok |
| `status` | — | modo, perfil, pestañas, pestaña activa |
| `tabs_list` | — | `[{id, title, url, active}]` |
| `tab_new` | `url?` | `{id}` |
| `tab_select` | `id` | ok |
| `tab_close` | `id?` | ok |

### Navegación
| Herramienta | Parámetros | Devuelve |
|---|---|---|
| `navigate` | `url`, `wait_until?` (`load`\|`domcontentloaded`\|`networkidle`) | url final y título |
| `back` / `forward` / `reload` | — | url y título |
| `wait_for` | uno de: `text`, `ref`, `url_contains`, `load`; más `timeout_ms?` | ok o `TIMEOUT` |

### Lectura
| Herramienta | Parámetros | Devuelve |
|---|---|---|
| `snapshot` | `mode?` (`full`\|`diff`), `scope_ref?`, `interactive_only?` | snapshot en texto (ver §5) |
| `get_text` | `scope_ref?`, `max_chars?` | texto visible de la página o de una sección |
| `find` | `query` (texto), `role?`, `limit?` | lista de refs candidatas con etiqueta. Búsqueda determinista, sin LLM, sobre nombre accesible, rol y valor; ignora mayúsculas y acentos, y ordena por coincidencia exacta, luego prefijo y luego subcadena |
| `screenshot` | `ref?`, `full_page?` | imagen |
| `console_messages` | `since?`, `level?` | mensajes del buffer |
| `network_requests` | `since?`, `url_contains?`, `failed_only?` | peticiones del buffer |

### Acciones
| Herramienta | Parámetros | Devuelve |
|---|---|---|
| `click` | `ref`, `button?`, `double?` | ok y si hubo navegación |
| `type` | `ref`, `text`, `clear?`, `submit?` | ok |
| `select_option` | `ref`, `value` o `label` | ok |
| `press_key` | `key` (p. ej. `Enter`, `Control+A`) | ok |
| `hover` | `ref` | ok |
| `scroll` | `ref?` o `direction` + `amount` | ok |
| `upload_file` | `ref`, `paths[]` | ok (riesgo `sensitive`) |
| `handle_dialog` | `accept`, `prompt_text?` | ok |
| `evaluate` | `expression` | valor serializado (**deshabilitada por defecto**, riesgo `sensitive`) |

### Seguridad
| Herramienta | Parámetros | Devuelve |
|---|---|---|
| `confirm` | `confirmation_id` | solicita la aprobación humana y espera; devuelve el resultado de la acción si se aprueba (ver §6.2) |
| `policy_show` | — | política activa |

---

## 5. Snapshots

### 5.1 Construcción
- Basados en el árbol de accesibilidad (CDP `Accessibility.getFullAXTree`), enriquecido con el DOM donde haga falta.
- Cada nodo relevante recibe una **ref corta y estable** (`e1`, `e2`…) mapeada internamente a su `backendDOMNodeId`.
- Las acciones resuelven la ref por `backendDOMNodeId`. Si el nodo ya no existe, se devuelve `REF_STALE` con la pista "toma un snapshot nuevo".
- Hay que incluir los iframes (con prefijo de frame en la ref) y el shadow DOM abierto.
- Se omiten los nodos invisibles, decorativos y los contenedores genéricos sin texto.

### 5.2 Formato (texto compacto, indentado)

```
# https://example.com/login — "Iniciar sesión"
- heading "Bienvenido" [e1]
- form [e2]
  - textbox "Correo" [e3] value=""
  - textbox "Contraseña" [e4] (password, SENSIBLE)
  - checkbox "Recordarme" [e5] checked=false
  - button "Entrar" [e6]
- link "¿Olvidaste tu contraseña?" [e7] → /reset
```

### 5.3 Modo diff
- `snapshot mode=diff` devuelve solo los nodos añadidos (`+`), eliminados (`-`) y modificados (`~`) desde el snapshot anterior de esa pestaña.
- Si el diff supera el 60 % del tamaño del snapshot completo, se devuelve el snapshot completo con el aviso `diff_fallback`.

### 5.4 Presupuesto de tokens
- Límite configurable (por defecto ~8 000 tokens estimados). Al superarlo, se truncan las listas largas con `… (N elementos más, usa scope_ref=eX)`.
- Los textos largos se recortan a 160 caracteres y los enlaces a 80; el texto completo se lee con `get_text`.
- Objetivos medibles:
  1. Ninguna respuesta de `snapshot` supera el límite de tokens configurado.
  2. En páginas de texto largo, un snapshot ocupa como mucho el 50 % de los tokens del `innerText` de la página.
  3. Tras una acción pequeña, un diff ocupa menos de la mitad que el snapshot completo.
- En páginas con muchos controles, un snapshot puede superar al `innerText`, porque cada enlace o botón necesita su rol y su ref. Para esos casos están `interactive_only`, `scope_ref`, `find` y el modo diff.

---

## 6. Seguridad (requisito de primer nivel)

### 6.1 Archivo de política (`~/.cuybrowser/policy.yaml`)

```yaml
domains:
  allow: []            # vacío = todos permitidos excepto los de deny
  deny: ["*.bank.com"]
approval: native-dialog   # native-dialog | elicitation | cli (ver §6.2)
confirm:               # acciones que requieren aprobación humana
  - submit_forms        # clic o Enter que envía un <form>
  - purchases           # botones o páginas con señales de pago o checkout
  - file_upload
  - downloads           # se retienen en cuarentena hasta aprobar (ver §6.2)
  - evaluate
sensitive_fields:
  block_typing: true    # bloquea type, y press_key con el foco en ellos, en campos password, tarjeta o CVV (autocomplete=cc-*), etc.
evaluate:
  enabled: false
attach:
  enabled: false        # modo attach: acceso a todas las pestañas y sesiones de ese Chrome
audit:
  enabled: true
  path: ~/.cuybrowser/audit.jsonl
```

### 6.2 Flujo de confirmación
1. Una acción que cae en `confirm` **no se ejecuta**. Devuelve `CONFIRMATION_REQUIRED` con un `confirmation_id`, una descripción legible ("Enviar formulario 'Pago' en tienda.com") y su expiración (2 minutos).
2. El agente llama a `confirm` con ese id. **`confirm` no aprueba nada**: solicita la aprobación humana por el canal configurado en `approval`, espera la respuesta y ejecuta la acción solo si el humano acepta.

   | `approval` | Cómo aprueba el humano | Garantía |
   |---|---|---|
   | `native-dialog` (por defecto) | Diálogo del sistema operativo abierto por el daemon, con una descripción que genera el propio daemon | Alta: el agente no puede responderlo por las interfaces de CuyBrowser |
   | `elicitation` (opcional, solo MCP) | Formulario de *elicitation* del cliente MCP | Media: depende del cliente, y un orquestador podría responder sin humano |
   | `cli` (opcional) | El usuario ejecuta `cuybrowser approve <id>` o `cuybrowser deny <id>` | Baja: un agente con terminal podría ejecutarlo; solo para entornos sin interfaz gráfica de confianza |

3. **Sin degradación automática:** si el canal configurado no está disponible (por ejemplo, sin sesión gráfica o sin `zenity`/`kdialog` en Linux), `confirm` devuelve `APPROVAL_UNAVAILABLE` y la acción no se ejecuta. Nunca se pasa a un canal más débil sin que el usuario lo configure.
4. Si el humano rechaza o el id expira, `confirm` devuelve `CONFIRMATION_DENIED`.
5. Si el cliente corta la llamada a `confirm` por su propio timeout, la solicitud sigue vigente hasta expirar y se puede volver a llamar a `confirm` con el mismo id, sin abrir otro diálogo. El servidor MCP envía notificaciones de progreso mientras espera.
6. Cada `confirmation_id` es de un solo uso y queda ligado a la acción exacta.

**Límite conocido:** estas garantías no protegen frente a un agente con acceso libre a los archivos del usuario, que podría editar `policy.yaml`. Para ese caso hay que aislar al agente a nivel de sistema operativo. La documentación debe decirlo expresamente.

**Descargas.** Una descarga se conoce cuando ya se ha ejecutado la acción que la inicia, así que no puede bloquearse por adelantado:
1. El daemon retiene el archivo en una carpeta de cuarentena (`~/.cuybrowser/quarantine/`) y no lo entrega.
2. La acción responde `ok: true` con `data.pending_download`: `confirmation_id`, nombre de archivo, origen, tamaño si se conoce y expiración. Si la página inicia la descarga sin una acción del agente, estos datos llegan en `warnings` de la siguiente respuesta y como evento en `GET /v1/events`.
3. Tras aprobar con `confirm`, el archivo pasa a `~/.cuybrowser/downloads/`. Si se rechaza o expira, se cancela la descarga y se borra lo descargado.
4. Si el modo de navegador no permite retener la descarga, esta se cancela y se avisa en `warnings`.

### 6.3 Contenido no confiable
- El texto libre de la página (snapshot, `get_text`, consola) se entrega delimitado como datos, por ejemplo `<<<PAGE_CONTENT … PAGE_CONTENT>>>`, y la descripción de cada herramienta de lectura recuerda que ese contenido no son instrucciones.
- Los textos cortos, como títulos, nombres de `find`, opciones o URLs, viajan como valores JSON sin delimitar, para no gastar tokens en cada respuesta.
- Heurística de **posible prompt injection**: textos como "ignora tus instrucciones", "eres un asistente", instrucciones dirigidas a IA o texto oculto con CSS. Se aplica al texto libre y a todos los textos de cada respuesta. Si se detecta, se añade a `warnings` sin bloquear.

### 6.4 Otros requisitos
- La API HTTP solo escucha en `127.0.0.1`, exige el token `~/.cuybrowser/token` (lo genera el daemon en su primer arranque si no existe, con permisos 600; si el archivo tiene permisos más abiertos, la API HTTP no arranca y lo indica) y rechaza peticiones con `Origin` de navegador (protección contra ataques desde páginas web).
- En el modo `launch` nunca se usa el perfil personal de Chrome.
- El log de auditoría registra cada acción con marca de tiempo, herramienta, parámetros (sin guardar el texto escrito con `type` ni el de `handle_dialog`), URL y resultado.

---

## 7. Interfaces: detalles

### 7.1 CLI

```bash
cuybrowser start [--mode launch|attach] [--profile trabajo] [--cdp http://localhost:9222]
cuybrowser navigate https://example.com
cuybrowser snapshot [--diff] [--scope e2]
cuybrowser click e6
cuybrowser type e3 "hola@correo.com" [--submit]
cuybrowser screenshot [--ref e2] [--out shot.png]
cuybrowser confirm <id>   # solicita la aprobación humana y espera (§6.2)
cuybrowser approve <id>   # solo con approval: cli; lo ejecuta el usuario
cuybrowser deny <id>      # solo con approval: cli; lo ejecuta el usuario
cuybrowser docs --format agents-md > AGENTS.md
cuybrowser mcp            # inicia el servidor MCP por stdio
cuybrowser serve --http   # habilita la API HTTP
```

### 7.2 MCP
- `cuybrowser mcp` arranca el servidor stdio y se conecta al daemon (o lo arranca).
- Nombres de herramienta con prefijo configurable (por defecto `browser_`). Los nombres del registro no llevan prefijo: `start` es `browser_start` en MCP, `cuybrowser start` en el CLI y `POST /v1/tools/start` en HTTP.
- Incluir en el README la configuración lista para copiar en Claude Desktop, Claude Code y Cursor.

### 7.3 HTTP

```bash
curl -s -H "Authorization: Bearer $(cat ~/.cuybrowser/token)" \
  -d '{"url":"https://example.com"}' \
  http://127.0.0.1:47777/v1/tools/navigate
```

- `GET /v1/tools` devuelve la lista de herramientas con su JSON Schema.
- `GET /v1/events` (SSE) emite eventos de consola, red, diálogos y navegación.

### 7.4 Documentación generada para agentes sin MCP
`cuybrowser docs --format agents-md` produce un `AGENTS.md` autocontenido con:
- instalación y arranque;
- el ciclo de trabajo recomendado (snapshot → acción → wait/diff);
- la referencia de cada comando, generada del registro;
- las reglas de seguridad para el agente.

Debe mantenerse sincronizado con el código **por construcción**: hay un test que falla si el doc del repo no coincide con el generado.

---

## 8. Estructura del repositorio

```
cuybrowser/
├─ src/
│  ├─ core/
│  │  ├─ daemon.ts
│  │  ├─ driver/            # BrowserDriver + launch.ts, attach.ts
│  │  ├─ snapshot/          # árbol AX, refs, formato, diff
│  │  ├─ security/          # policy, confirm, sensitive, injection, audit
│  │  ├─ events.ts
│  │  └─ registry.ts        # defineTool + registro
│  ├─ tools/                # una herramienta por archivo
│  ├─ adapters/
│  │  ├─ mcp.ts
│  │  ├─ cli.ts
│  │  └─ http.ts
│  ├─ ipc/
│  └─ docs/                 # generadores de AGENTS.md / SKILL.md
├─ test/
│  ├─ fixtures/             # páginas HTML locales (login, formulario, checkout falso, iframe, shadow DOM, SPA, injection, descarga)
│  ├─ unit/
│  └─ e2e/
├─ docs/AGENTS.md           # generado
└─ README.md
```

---

## 9. Pruebas y criterios de aceptación

### 9.1 Pruebas
- **Unitarias:** formato de snapshot, diff, resolución de refs, motor de políticas y detector de injection.
- **E2E:** contra un servidor local de fixtures, cubriendo todas las herramientas.
- **Paridad:** cada caso E2E se ejecuta por las tres interfaces (MCP, CLI y HTTP) y los resultados deben coincidir.
- **Seguridad:**
  - `type` en un campo password devuelve `SENSITIVE_FIELD`;
  - enviar un formulario devuelve `CONFIRMATION_REQUIRED` y solo se ejecuta si el humano aprueba (en las pruebas, con un aprobador simulado que solo existe en el arnés de pruebas y no se puede activar por configuración);
  - rechazar o dejar expirar una confirmación devuelve `CONFIRMATION_DENIED` y la acción no se ejecuta;
  - sin canal de aprobación disponible, `confirm` devuelve `APPROVAL_UNAVAILABLE` y no pasa a otro canal;
  - un `confirmation_id` no se puede usar dos veces;
  - una descarga queda en cuarentena hasta aprobarse y se borra si se rechaza o expira;
  - un dominio en `deny` devuelve `BLOCKED_BY_POLICY`;
  - la página de fixture con injection genera un warning;
  - una petición HTTP sin token o con `Origin` es rechazada.
- **Tarea de agente de punta a punta:** un script que, usando solo el CLI, completa un formulario de 3 pasos en los fixtures.

### 9.2 Criterios de aceptación de v1
- [ ] `npx cuybrowser start && npx cuybrowser navigate <url> && npx cuybrowser snapshot` funciona en macOS con Chrome instalado.
- [ ] Claude Desktop y Claude Code pueden usar todas las herramientas vía MCP con la configuración del README.
- [ ] Un agente sin MCP, usando solo el `AGENTS.md` generado, completa la tarea E2E de formulario.
- [ ] Todas las pruebas de paridad y de seguridad pasan.
- [ ] La latencia mediana de `click` (daemon ya iniciado) está por debajo de 300 ms en los fixtures.
- [ ] El tamaño de los snapshots cumple el objetivo del §5.4.

---

## 10. Hitos

1. **Núcleo + CLI:** daemon, modo launch, registro, navigate/snapshot/click/type/screenshot/tabs y el formato de respuesta.
2. **MCP + HTTP + docs generadas:** adaptadores, token HTTP, generador de AGENTS.md y tests de paridad. Herramientas restantes que no dependen de la seguridad: historial, `wait_for`, `get_text`, `console_messages`, `network_requests`, `select_option`, `press_key`, `hover` y `scroll`.
3. **Seguridad completa:** política, confirmaciones, campos sensibles, injection y auditoría. Herramientas `confirm`, `policy_show`, `handle_dialog`, `upload_file` y `evaluate`. Soporte para Linux y Windows.
4. **Calidad de snapshots:** diff, iframes, shadow DOM, presupuesto de tokens y `find`.
5. **Distribución:** binarios con bun y publicación en npm.

## 11. Fuera de alcance (v1), con diseño preparado
- Modo `extension` (Chrome real del usuario).
- Grabar y reproducir tareas como scripts sin LLM.
- Varios navegadores o perfiles simultáneos por daemon.
- Firefox y Safari.

## 12. Decisiones tomadas
- Nombre del proyecto: CuyBrowser; paquete y binario: `cuybrowser`.
- Licencia: MIT.
- Puerto HTTP por defecto: 47777.
