# CuyBrowser 0.5.0 — pre-release

Esta versión añade un contrato de permisos por origen exacto para clientes MCP,
CLI y HTTP. Un origen distingue el esquema, el servidor y el puerto: permitir
`https://ejemplo.com` no permite otro esquema ni otro puerto.

- `origins.allow` y `origins.deny` limitan la navegación antes del contacto con
  el destino, incluidas las redirecciones HTTP. Una visita temporal con
  identificador caduca al confirmar otro origen; `status.consumed_visits`
  permite al cliente retirar los permisos consumidos.
- `local_network.allow_origins` autoriza la red local por separado. Un proxy
  privado autenticado valida DNS y conecta a la IP comprobada para HTTP,
  CONNECT y WebSocket; no descifra TLS.
- Los perfiles protegidos bloquean service workers, desactivan la restauración
  automática e impiden la salida UDP directa de WebRTC. Los marcos de otro
  origen y las ventanas que aún no tienen barrera se bloquean de forma
  conservadora.
- `policy_show.capabilities` declara las garantías disponibles. Al omitir los
  campos nuevos se mantiene la política anterior; el modo protegido necesita
  una ventana propia iniciada con `launch`.

El control estricto de todos los subrecursos todavía no está implementado
(`strictResources: false`). Los clientes que lo necesiten deben rechazar la
operación. `attach` sigue deshabilitado por defecto. No se importan cookies ni
sesiones personales, no se oculta la automatización y los captchas siguen
pasándose a la persona mediante `handoff`.

Se distribuyen los cinco binarios de macOS, Linux y Windows, el paquete `.tgz`
instalable con Node.js y `SHA256SUMS`. No se publica en el registro de npm. Es
una versión de prueba: el uso real se ha comprobado en macOS; Linux y Windows
se validan mediante la matriz de CI con aprobador simulado.

La validación local pasó las 204 pruebas de `npm test`, incluidas las de cero contactos al rechazar
redirecciones, red local, WebSocket y visitas caducadas, además de controles
positivos para las conexiones permitidas. La matriz de CI y los artefactos del
workflow Release deben verificarse antes de publicar esta pre-release.
