# Dialogue Forge

Editor visual de árboles de diálogo construido para el desarrollo de videojuegos. Crea conversaciones ramificadas, gestiona NPCs y quests, traduce entre idiomas y genera diálogos con IA — todo desde una sola aplicación de escritorio.

Construido con Electron, Vite y JavaScript vanilla. Sin frameworks.

---

## Funcionalidades

### Editor Visual de Diálogos
- Canvas basado en nodos para crear y conectar líneas de diálogo
- Posicionamiento de nodos con arrastrar y soltar, con auto-layout para árboles ramificados
- Edición de texto inline en el canvas o en el panel inspector
- Ramificación condicional con condiciones `IF` y acciones `DO` en las conexiones
- Multi-selección, duplicación y eliminación en lote de nodos
- Historial completo de deshacer/rehacer (Ctrl+Z / Ctrl+Y)

### Gestión de Proyecto
- Gestión de NPCs, Quests y Diálogos desde una barra lateral colapsable
- Reordenamiento con arrastrar y soltar de NPCs, Quests y Diálogos
- Colores personalizados para NPCs para identificación visual en el canvas
- Asignación de diálogos a NPCs y Quests
- Guardar/cargar proyectos como archivos `.json` con auto-guardado en localStorage
- Exportar/importar para respaldo y control de versiones

### Soporte Bilingüe (ES / EN)
- Cada nodo de diálogo admite texto en español e inglés
- El toggle de idioma en la barra de herramientas cambia la vista de edición
- Traducción en lote con IA (ES a EN) para el diálogo activo
- Traducción por nodo desde el panel inspector

### Integración de IA (via OpenRouter)
- **Generación de diálogos**: Describe una conversación y la IA crea un árbol de diálogo ramificado completo con nodos y conexiones
- **Extensión de diálogos**: Extiende diálogos existentes desde nodos hoja
- **Traducción**: Traduce nodos individuales o diálogos completos
- **Asistente de chat**: Un panel de chat integrado que puede leer el diálogo activo, crear nodos, actualizar texto y modificar conexiones mediante acciones estructuradas
- **Modelos separados por tarea**: Configura diferentes LLMs para generación (ej. Claude Sonnet), traducción (ej. Gemini Flash) y chat de forma independiente
- **Archivos de contexto**: Sube archivos PDF, Markdown o texto con lore del mundo que se inyectan en los prompts de IA

### Audio Slicer
Herramienta integrada para dividir grabaciones de voz en clips de diálogo individuales:
- Carga archivos de audio (.wav, .mp3, .ogg) mediante arrastrar y soltar o selector de archivos
- Visualización de la forma de onda renderizada en canvas
- Clic para colocar marcadores de corte, arrastrar para ajustar, clic derecho para eliminar
- Shift+Clic para establecer la posición de inicio de reproducción (playhead)
- Previsualización de segmentos individuales antes de exportar
- Nombres de segmentos editables
- Exportar todos los segmentos como un .zip de archivos .wav, o descargar individualmente
- Zoom y scroll horizontal para navegar grabaciones largas

---

## Requisitos

- Node.js (v18 o posterior recomendado)

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
    main.js          Gestión de ventanas, IPC, diálogos de archivo
    preload.js       Puente seguro entre renderer y main
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
      ai.js          Integración con la API de OpenRouter, traducción, generación
      chat.js        Asistente de chat con IA y acciones estructuradas
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
  "npcs": [{ "id": "...", "name": "Guard", "color": "#6c5ce7" }],
  "quests": [{ "id": "...", "name": "The Lost Sword" }],
  "dialogues": [{
    "id": "...",
    "title": "Guard Warning",
    "npcId": "...",
    "questId": "...",
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