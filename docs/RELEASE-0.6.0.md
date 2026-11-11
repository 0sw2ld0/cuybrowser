# CuyBrowser 0.6.0 · pre-release

- `audit_recent` permite a clientes CLI, MCP y HTTP consultar la actividad reciente del perfil propio mediante un cursor. Devuelve metadatos acotados y saneados, con el origen de la acción y su resultado. `policy_show.capabilities.auditRecent` indica que el servidor admite la consulta. [PR #8](https://github.com/0sw2ld0/cuybrowser/pull/8)
- El ejecutable autónomo incorpora los recursos de Playwright y puede iniciar su daemon y Chromium desde el archivo descargado. La CI prueba el arranque, la navegación a una página ficticia, la lectura y el cierre en macOS, Linux y Windows. [PR #9](https://github.com/0sw2ld0/cuybrowser/pull/9)

La descarga incluye cinco ejecutables autónomos, el paquete `cuybrowser-0.6.0.tgz` para Node.js 20 o superior y `SHA256SUMS` para comprobar los archivos.
