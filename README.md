# Dialogue Forge

App vibecodeada para hacer los dialogos de mi jueguito. 
El nombre de la app la eligió la IA al peo.

## Caracteristicas

* Lienzo visual interactivo para creacion y conexion de nodos de dialogo.
* Gestion de personajes, variables del sistema y condiciones de flujo.
* Integracion de IA via OpenRouter para ayudar en la redaccion de dialogos.
* Traduccion y localizacion ES -> EN porque el juego va a estar en inglés.
* Exportacion e importacion de proyectos en JSON.
* Construido sobre Electron, Vite y JS vanilla.

## Requisitos

- Node.js.

## Instalacion

```bash
npm install
```

## Comandos

* **Desarrollo local:** Ejecuta el servidor de Vite y abre la aplicacion de escritorio en modo de desarrollo.
  ```bash
  npm run dev
  ```

* **Compilar frontend:** Genera el build de produccion de los recursos web.
  ```bash
  npm run build
  ```

* **Empaquetar aplicacion:** Compila el frontend y genera el instalador ejecutable para Windows utilizando electron-builder.
  ```bash
  npm run dist
  ```
