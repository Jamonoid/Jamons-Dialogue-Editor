# Análisis de Usabilidad y Propuestas de Mejora
## Dialogue Forge (Perspectiva del Usuario)

Este documento recopila un análisis exhaustivo del flujo de trabajo, la usabilidad y las características del editor de diálogos **Dialogue Forge**, proponiendo mejoras de sentido común organizadas por prioridad e impacto en la experiencia de usuario (UX).

---

### 1. BUGS, PROBLEMAS DE DISEÑO Y UX

#### A. El Comportamiento Frustrante del Deshacer/Rehacer (`Ctrl+Z` / `Ctrl+Y`) en Textos
* **El Problema**: El manejador de teclado global ignora los atajos de deshacer/rehacer cuando el usuario está enfocado en un campo de texto (`input` o `textarea`) para permitir el comportamiento nativo del navegador. Sin embargo:
  * El editor solo guarda un checkpoint en el historial de deshacer (`State.pushUndoCheckpoint()`) en el momento en que el campo de texto recibe el foco (`focus`).
  * Si un usuario escribe un párrafo largo y comete un error, presionar `Ctrl+Z` dentro del input deshace los caracteres nativos. Pero si sale del input (pierde el foco) y presiona `Ctrl+Z` en el canvas, **se revierte absolutamente todo el párrafo al estado previo a enfocar el input**, perdiendo valiosos minutos de escritura en un solo paso.
  * No hay un guardado intermedio de checkpoints del historial (debouncing por palabras o pausas) mientras se escribe.
  * Estando dentro de un campo de texto, no es posible presionar `Ctrl+Z` para revertir una acción física del canvas (como haber movido un nodo o eliminado una conexión por accidente hace unos instantes).
* **Solución Propuesta**: Implementar un sistema de debouncing para la escritura en el que se capture un checkpoint de deshacer tras 1.5 segundos de inactividad de escritura, evitando pérdidas masivas de texto. Unificar el historial de navegación/canvas con el del texto de forma inteligente.

#### B. Flechas de Conexión sin Dirección Visual
* **El Problema**: Las conexiones entre nodos en el canvas se renderizan como curvas Bezier planas. No hay cabezas de flecha (markers SVG) ni animaciones sutiles que muestren la dirección del flujo.
* **El Impacto**: Aunque el flujo general es de arriba (salida) a abajo (entrada), en árboles de diálogo complejos y cruzados, es muy fácil perder de vista cuál es el nodo de origen y cuál el de destino. Se siente como una "sopa de cables".
* **Solución Propuesta**: Añadir marcadores de punta de flecha (`<marker>`) en los extremos de los paths SVG de las conexiones para dejar perfectamente clara la jerarquía visual del diálogo.

#### C. Nodos de Colores con Conexiones Genéricas
* **El Problema**: Los nodos adoptan colores personalizados según el NPC que habla (lo cual es excelente para identificar de un vistazo quién habla). Sin embargo, todas las conexiones del canvas se dibujan con la variable fija `--accent-primary` (morado por defecto).
* **El Impacto**: Se pierde una gran oportunidad de continuidad visual. Si las líneas de conexión tuvieran el color del NPC del nodo de origen, sería increíblemente fácil seguir la conversación de un personaje específico a través del mapa de nodos.
* **Solución Propuesta**: Modificar el renderizado de conexiones para que la propiedad `stroke` del path visible adopte el color del NPC del nodo emisor (`sourceNode`), cayendo en el color de acento por defecto si no hay NPC asignado.

#### D. Edición Masiva Inexistente en el Inspector (Bulk Editing)
* **El Problema**: El editor cuenta con selección múltiple en el canvas (Shift+Arrastrar, Shift+Click) y permite mover los nodos juntos o borrarlos en lote. Sin embargo, al seleccionar múltiples nodos, el inspector de propiedades solo muestra la opción "Eliminar N nodos".
* **El Impacto**: Si un diseñador narrativo quiere asignar un NPC, una condición de Narrative Tales, o una Quest a un grupo de 15 nodos seleccionados simultáneamente, tiene que hacer clic en cada nodo individualmente y repetir la misma acción 15 veces.
* **Solución Propuesta**: Permitir que el inspector muestre campos de edición comunes (como un selector de NPC, campos para condiciones/acciones, o limpieza de estos) cuando hay varios nodos seleccionados, aplicando los cambios a toda la selección.

---

### 2. MEJORAS DE CALIDAD DE VIDA (QoL)

#### A. Botones Visuales de Deshacer (Undo) / Rehacer (Redo) en la Barra de Herramientas
* **Razón**: Actualmente el deshacer/rehacer es una función oculta que solo se activa por teclado (`Ctrl+Z` / `Ctrl+Y`). Si un usuario prefiere usar el ratón o no conoce los atajos, no tiene forma de revertir sus acciones.
* **Propuesta**: Añadir dos botones clásicos con iconos de flechas de retorno en la Toolbar (deshabilitados cuando sus respectivos stacks en `state.js` estén vacíos) para dar feedback visual inmediato al usuario de que tiene control sobre sus errores.

#### B. Atajos Estándar de Zoom y Centrado de Vista
* **Razón**: La navegación rápida por el canvas es clave. Solo contar con botones en la esquina inferior izquierda y la rueda del ratón se siente limitado.
* **Propuesta**:
  * Implementar los atajos estándar `Ctrl` + `+` y `Ctrl` + `-` para controlar el zoom.
  * Implementar `Ctrl` + `0` para restablecer el zoom y centrado (`resetView`).
  * Implementar una combinación rápida (como `F` o `Ctrl` + `F`) para enfocar la cámara en el nodo seleccionado.

#### C. Copiar y Pegar Nodos (`Ctrl+C` / `Ctrl+V`) en el Canvas
* **Razón**: Actualmente la duplicación (`Ctrl+D`) genera una copia con un desplazamiento diagonal fijo de +40px. Si el usuario quiere copiar un nodo o un conjunto de nodos y colocarlos en otra región lejana del canvas, tiene que duplicarlos en la posición actual y arrastrarlos pacientemente a través del mapa.
* **Propuesta**: Añadir comandos para copiar nodos al portapapeles en memoria y pegarlos donde se encuentre la posición del cursor o el centro actual de la pantalla.

#### D. Indicador de Localización Faltante (Advertencia de Traducción)
* **Razón**: Al crear diálogos bilingües, es común olvidar rellenar el texto en el idioma secundario (ES o EN) de algunos nodos intermedios.
* **Propuesta**: Dibujar un sutil icono de advertencia (como un globo de texto con un signo de interrogación) o un borde con líneas punteadas amarillas en los nodos que tengan texto en un idioma pero no en el otro, facilitando el control de calidad antes de exportar el proyecto.

---

### 3. NUEVAS CARACTERÍSTICAS PROPUESTAS (FEATURES)

#### A. Simulador de Diálogos Interactivo (Playtest Mode)
* **Descripción**: La característica de sentido común más importante que falta. Un botón de "Simular" o "Reproducir" en la barra de herramientas que abra un modal interactivo donde el usuario pueda jugar el diálogo creado.
* **Detalles**:
  * Interfaz estilo novela visual o chat (caja de diálogo inferior, nombre del NPC emisor, texto con animación sutil de aparición).
  * Los botones de respuesta corresponden a las conexiones salientes (ramificaciones) del nodo actual.
  * Si un nodo tiene una condición de Narrative Tales (`condition`), el simulador podría evaluar si se cumple (mostrando la opción deshabilitada o directamente ocultándola).
* **Razón**: Permite al escritor probar el flujo, el ritmo y el tono del diálogo de inmediato, sin tener que exportar el archivo JSON, abrir el motor de videojuegos e implementar la lógica de lectura solo para probar una conversación.

#### B. Buscador Global de Nodos
* **Descripción**: Un panel de búsqueda rápido que permita filtrar nodos en tiempo real.
* **Detalles**:
  * Buscar por texto del diálogo (independiente de si es ES o EN).
  * Buscar por ID del nodo o nombre del NPC asignado.
  * Buscar por palabras clave dentro de condiciones (`condition`) o acciones (`action`).
  * Al hacer clic en un nodo de la lista de resultados, el canvas hace un panning suave hacia el nodo y lo selecciona automáticamente.
* **Razón**: Cuando un diálogo supera los 30 nodos, se vuelve extremadamente difícil localizar un punto de control específico de la conversación. Un buscador soluciona esto instantáneamente.

#### C. Exportación Avanzada a Formatos de Lectura (Markdown / CSV)
* **Descripción**: Actualmente solo se puede exportar en formato JSON de la aplicación.
* **Detalles**:
  * **Exportación CSV/Excel**: Organizado con columnas como `ID_Nodo`, `NPC`, `Texto_ES`, `Texto_EN`, `Conexiones`, `Condiciones`. Ideal para enviar las líneas de diálogo a traductores externos, correctores de estilo o actores de doblaje.
  * **Exportación Markdown**: Genera un archivo estructurado jerárquicamente donde cada nodo es un encabezado y los enlaces enlazan a otros encabezados del archivo. Excelente para leer todo el guion corrido de principio a fin.
* **Razón**: El formato JSON es el idóneo para que los programadores lo integren en el código, pero es hostil para escritores o colaboradores externos que necesitan revisar el texto sin usar el editor gráfico.

#### D. Validación Automática del Diálogo y Detección de Huérfanos
* **Descripción**: Un panel de "Salud del Proyecto" o "Validación de Errores" que alerte al diseñador sobre inconsistencias lógicas.
* **Errores a Detectar**:
  * **Nodos Huérfanos**: Nodos que no tienen ninguna conexión de entrada y no son el nodo inicial (inaccesibles en el juego).
  * **Callejones sin Salida Involuntarios**: Nodos que no tienen conexiones salientes pero que el escritor no marcó explícitamente como finales.
  * **Ciclos Infinitos**: Bucles lógicos que atrapan al jugador sin opción de terminar la conversación.
  * **NPCs o Quests sin Usar**: Elementos en la barra lateral que no están referenciados por ningún nodo del proyecto, para poder depurarlos fácilmente.
* **Razón**: Garantiza la integridad lógica de la base de datos de diálogos antes de pasar los archivos a producción, evitando bugs de progresión en el juego.
