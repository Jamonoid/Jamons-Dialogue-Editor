# Jamon's Dialogue Editor

Editor visual de árboles de diálogo construido para el desarrollo de videojuegos. Crea conversaciones ramificadas, gestiona NPCs y quests, traduce entre idiomas y genera diálogos con IA.

---

## Funcionalidades

### Editor Visual de Diálogos
- Canvas basado en nodos para crear y conectar líneas de diálogo
- Posicionamiento de nodos con arrastrar y soltar, con auto-layout para árboles ramificados
- Edición de texto inline en el canvas o en el panel inspector
- Ramificación condicional con condiciones `IF` y acciones `DO` en las conexiones (Solo visual)
- Multi-selección, duplicación y eliminación en lote de nodos
- Historial completo de deshacer/rehacer (Ctrl+Z / Ctrl+Y)

### Gestión de Proyecto
- Gestión de NPCs, Quests y Diálogos desde una barra lateral.
- Colores personalizados para NPCs para identificación visual en el canvas
- Asignación de diálogos a NPCs y Quests
- **Notas del autor**: cada NPC, quest y diálogo admite una nota de contexto (p. ej. "Diálogo que se ejecuta al final de la quest X") que se expone a la IA en el chat, la generación, la memoria vectorial (RAG) y las herramientas MCP
- **Agrupar, ordenar y filtrar diálogos**: agrupa la lista por NPC o por Quest, ordena por orden manual o título (A→Z / Z→A) y filtra por texto (título, NPC o Quest). Las preferencias de agrupación y orden se recuerdan entre sesiones
- Reordenamiento de la lista mediante arrastrar y soltar (en modo manual sin agrupar)
- Guardar/cargar proyectos como archivos `.json` con auto-guardado en localStorage
- Exportar/importar para respaldo y control de versiones

### Soporte Bilingüe (ES / EN)
- Cada nodo de diálogo admite texto en español e inglés
- El toggle de idioma en la barra de herramientas cambia la vista de edición
- Traducción en lote con IA (ES a EN) para el diálogo activo
- Traducción por nodo desde el panel inspector

### Integración de IA (multi-proveedor)
- **Dos proveedores, seleccionables por tarea**:
  - **OpenRouter** — API HTTP, requiere API key, pago por token, acceso a cientos de modelos
  - **Claude Code** — usa el CLI `claude` instalado localmente con tu suscripción Claude
- **Generación de diálogos**: Describe una conversación y la IA crea un árbol de diálogo ramificado completo con nodos y conexiones
- **Extensión de diálogos**: Extiende diálogos existentes desde nodos hoja
- **Traducción**: Traduce nodos individuales o diálogos completos
- **Asistente de chat**: Un panel de chat integrado que puede leer el diálogo activo, crear nodos, actualizar texto y modificar conexiones mediante acciones estructuradas
- **Proveedor y modelo separados por tarea**: Configura proveedor + LLM distintos para generación, traducción y chat de forma independiente, con sugerencias de modelos y botón "🔌 Probar conexión"
- **Archivos de contexto**: Sube archivos PDF, Markdown o texto con lore del mundo. Con la memoria vectorial indexada, la IA recupera solo los fragmentos relevantes a cada petición (RAG); sin índice, se inyectan directamente en los prompts

### Memoria Vectorial y Mapa Neuronal
- **Embeddings 100% locales** con transformers.js — en GPU vía WebGPU cuando está disponible (fallback a CPU/WASM). El modelo se descarga una vez (50 MB–1 GB según cuál elijas) y luego funciona offline, sin API key. Modelo configurable en la Configuración de IA, con soporte específico para Qwen3-Embedding, familia E5 y BGE-M3 (pooling y prefijos correctos por modelo)
- **Indexa todo el proyecto**: nodos de diálogo, archivos de contexto (troceados), NPCs, quests e historial del chat. Los vectores viven en IndexedDB, fuera del estado del proyecto
- **RAG en chat y generación**: cada mensaje del chat y cada generación de diálogo recupera los fragmentos semánticamente más relevantes en lugar de volcar toda la documentación (menos tokens, mejores respuestas, documentación sin límite de tamaño)
- **Mapa neuronal 3D** (botón 🧠 Memoria): visualización 3D de toda la memoria (proyección PCA a 3 componentes) con cámara orbital (arrastrar = rotar, Shift/clic derecho = mover, rueda = zoom), rotación automática, conexiones por similitud, filtros por tipo y tooltips. Clic en un punto abre un **panel de detalles** (texto completo, metadatos, vecinos más similares y botón para ir al nodo/diálogo en el editor)
- **Prueba de calidad del RAG**: buscador integrado en el mapa que ejecuta la misma búsqueda semántica que usan el chat y la generación, mostrando los resultados rankeados con su similitud y resaltándolos en el espacio 3D
- **Feedback de carga del modelo**: barra de progreso con MB descargados al bajar el modelo de embeddings, y indicador del backend activo (GPU/CPU) en el pie del mapa
- **Indexación incremental**: la primera indexación es manual ("⚡ Indexar proyecto"); después se refresca sola en segundo plano al editar
- El botón 🗑 del chat borra el historial y su memoria vectorial

### Control externo vía MCP
La app expone un servidor MCP embebido (`http://127.0.0.1:4747/mcp`) mientras está abierta, para que un Claude Code externo (p. ej. desde el repo del GDD) pueda leer y editar diálogos directamente sobre el canvas en vivo:

```bash
claude mcp add --transport http --scope user dialogue-forge http://127.0.0.1:4747/mcp
```

### Audio Slicer
Herramienta integrada para dividir grabaciones de voz en clips de diálogo individuales:
- Carga archivos de audio (.wav, .mp3, .ogg) mediante arrastrar y soltar o selector de archivos
- Visualización de la forma de onda renderizada en canvas
- Clic para colocar marcadores de corte, arrastrar para ajustar, clic derecho para eliminar
- Shift+Clic para establecer la posición de inicio de reproducción (playhead)
- Previsualización de segmentos individuales antes de exportar
- Nombres de segmentos editables (los cambios manuales se conservan al mover marcadores)
- **Patrón de nombres configurable** con tokens: `{file}` (nombre del audio), `{num}` (01, 02...), `{num3}` (001, 002...). Por defecto `{file}_{num}` → `dialogo_01.wav`, `dialogo_02.wav`
- **Renombrado en lote**: "↻ Aplicar a todos" (re-aplica el patrón) y buscar/reemplazar sobre todos los nombres. Los duplicados se desambiguan solos al exportar y los nombres se sanitizan para el sistema de archivos
- Exportar todos los segmentos como un .zip de archivos .wav, o descargar individualmente
- Zoom y scroll horizontal para navegar grabaciones largas

---

## Requisitos

- Node.js (v18 o posterior recomendado)
- Opcional: CLI de [Claude Code](https://claude.com/claude-code) instalado y logueado, para usar el proveedor "Claude Code" sin API key

## Instalación

```bash
npm install
```

## Comandos

| Comando | Descripción |
|---------|-------------|
| `npm run dev` | Inicia el servidor de desarrollo Vite + Electron en paralelo |
| `npm run build` | Compila el frontend para producción (`dist/`) |
| `npm run dist` | Compila el frontend + empaqueta como instalador para Windows (NSIS) |

## Atajos de Teclado

| Atajo | Acción |
|-------|--------|
| Ctrl+S | Guardar proyecto en archivo |
| Ctrl+O | Abrir archivo de proyecto |
| Ctrl+Z | Deshacer |
| Ctrl+Y | Rehacer |
| Ctrl+D | Duplicar nodos seleccionados |
| Ctrl+A | Seleccionar todos los nodos |
| Delete | Eliminar nodos seleccionados |
| Escape | Deseleccionar / cerrar overlay |
| Espacio | Reproducir/pausar (en Audio Slicer) |

## Estructura del Proyecto

```
Dialogues/
  electron/          Proceso principal de Electron
    main.js          Gestión de ventanas, IPC, diálogos de archivo, spawn de Claude Code
    preload.js       Puente seguro entre renderer y main
    mcp-server.js    Servidor MCP embebido (HTTP en 127.0.0.1:4747)
  src/
    main.js          Punto de entrada de la app, conexión de módulos
    style.css        Todos los estilos (custom properties CSS, sin frameworks)
    utils/
      helpers.js     Helpers de DOM, escape de strings, generación de UIDs
    modules/
      state.js       Gestión central del estado, deshacer/rehacer, persistencia
      canvas.js      Renderizado del canvas, pan/zoom, layout de nodos
      nodes.js       Renderizado de nodos en DOM, edición inline, resize
      inspector.js   Panel derecho para editar propiedades de nodo/NPC/quest
      sidebar.js     Panel izquierdo con listas de NPCs/quests/diálogos
      ai.js          IA multi-proveedor (OpenRouter + Claude Code), traducción, generación
      chat.js        Asistente de chat con IA, acciones estructuradas, retrieval RAG
      vector-memory.js Memoria semántica local: embeddings transformers.js + IndexedDB
      memory-map.js  Mapa neuronal: proyección PCA 2D de la memoria vectorial
      mcp-bridge.js  Ejecutor de herramientas MCP contra el estado en vivo
      prompts.js     System prompts para generación y extensión de diálogos
      lang.js        Toggle de idioma (ES/EN)
      ui.js          Modales, toasts, menús contextuales, UI de configuración
      audio-slicer.js  Herramienta de división de audio
      wav-encoder.js   Codificador de archivos WAV en JS puro
  index.html         Shell de la aplicación
  vite.config.js     Configuración de Vite
  package.json       Dependencias y scripts de compilación
```

## Formato de Datos

Los proyectos se guardan como JSON con la siguiente estructura:

```json
{
  "npcs": [{ "id": "...", "name": "Guard", "color": "#6c5ce7", "comment": "Guardia de la puerta norte" }],
  "quests": [{ "id": "...", "name": "The Lost Sword", "comment": "Quest secundaria del acto 1" }],
  "dialogues": [{
    "id": "...",
    "title": "Guard Warning",
    "npcId": "...",
    "questId": "...",
    "comment": "Se ejecuta la primera vez que el jugador cruza la puerta",
    "nodes": [{
      "id": "...",
      "text": { "es": "Hola viajero.", "en": "Hello traveler." },
      "npcId": "...",
      "x": 100, "y": 200,
      "connections": [{ "targetId": "...", "condition": "", "action": "" }]
    }],
    "startNodeId": "..."
  }]
}
```