# @semantica/semantica-wasm

Core compartido de Semantica: extracción PDF, OCR opcional, recuperación de ilustraciones, clasificación con Laya, reglas de estructura/índice y generación de EPUB y Markdown. La web y Node usan el mismo pipeline de `src/conversion.ts` y la misma implementación de clasificación de `src/index.ts`.

La entrada `@semantica/semantica-wasm/browser` configura PDF.js y los assets WASM para navegador. Vite debe procesar las importaciones `?url` de los binarios de ONNX Runtime con un alias hacia `onnxruntime-web/dist` (consulta la configuración de `apps/web/vite.config.ts`); no se deben importar módulos WASM desde `public/`. La entrada principal y `@semantica/semantica-wasm/node` se pueden usar desde Node.js 22 o posterior; Node emplea `@napi-rs/canvas` para renderizar páginas y la misma sesión de ONNX Runtime WebAssembly para Laya. El modelo Laya se entrega por separado y se proporciona como una carpeta local.

La función de visión recibe cajas de texto de PDF.js o Tesseract, las enmascara y agrupa los píxeles restantes con componentes conectados; recorta las regiones candidatas y las añade al Markdown y EPUB. Es una heurística ligera de visión en canvas, sin OpenCV.js.

## Uso desde Node.js

```js
import { convertPdfPath, loadLayaModel } from "@semantica/semantica-wasm";
import { writeFile } from "node:fs/promises";

const laya = await loadLayaModel("./models/laya-multilingual");
const result = await convertPdfPath(
  "./libro.pdf",
  "epub",
  true,
  (progress, label) => console.log(`${progress}% ${label}`),
  { classifier: laya },
);
await writeFile("./libro.epub", Buffer.from(await result.epubBlob.arrayBuffer()));
await writeFile("./libro.md", Buffer.from(await result.markdownBlob.arrayBuffer()));
```

Una conversión procesa el PDF una sola vez y devuelve `pdfBlob`, `epubBlob` y `markdownBlob`, además de nombres y cantidad de páginas. `convertPdfPath` recibe la ruta PDF, formato preferido (`epub` o `markdown`), opción OCR, callback de progreso y las opciones compartidas con la web. Al llamar `loadLayaModel`, si faltan el manifiesto o los pesos requeridos, Node descarga el checkpoint multilingüe oficial, prepara el ONNX compatible y espera a que esté listo antes de inicializar la sesión. Para no usar Laya, omite `classifier`; para PDFs digitales se puede desactivar OCR.

Para varios archivos, `convertPdfPaths(paths, ...)` en Node y `convertPdfBatch(files, ...)` en el core procesan los PDFs en orden. `processPdfBatch(files, ..., { onResult })` permite consumir y guardar cada resultado antes de iniciar el siguiente, sin retener todos los EPUB en memoria. La app web usa este flujo y registra un estado por archivo.

La extracción intenta primero usar la capa de texto del PDF. Tesseract se reserva para páginas con poco texto extraíble y contenido visual que no está explicado por esa capa; la interfaz distingue «Extrayendo texto del PDF» de «Reconociendo texto con OCR». En PDFs digitales, Semantica analiza el tamaño y el estilo tipográfico de los bloques: si detecta una jerarquía consistente de títulos y encabezados, la conserva y omite Laya; si el texto es plano, usa Laya para proponer la estructura.

## Portadas y metadatos

Node no consulta servicios externos por defecto. Configura `bookMetadata.mode: "auto"` para buscar la primera coincidencia compatible en Open Library, descargar su portada y añadir la metadata encontrada. En modo manual puedes pasar metadata y una portada por URL o ruta local:

```js
await convertPdfPath("./libro.pdf", "epub", true, onProgress, {
  classifier: laya,
  bookMetadata: {
    mode: "manual",
    metadata: { title: "Mi libro", authors: ["Autor"], publishedDate: "2024", language: "es" },
    cover: { path: "./portada.jpg" }, // También admite { url: "https://…" }
  },
});
```

En la app web, al generar un EPUB, Semantica propone hasta tres portadas y metadata de Open Library, además de la primera página original del PDF. Solo el título del archivo se envía para buscar; el PDF permanece local. La persona puede corregir título, autores, editorial, año, idioma, ISBN y descripción, subir una portada o indicar una URL. La selección sugerida queda resaltada y se confirma sola a los tres minutos; ese temporizador se puede pausar. Las portadas remotas deben permitir acceso CORS desde el navegador y ser JPEG o PNG para poder integrarse en el EPUB.

Google Books puede habilitarse opcionalmente con `googleBooksApiKey` en Node o `VITE_GOOGLE_BOOKS_API_KEY` en el entorno del build web; la búsqueda pública exige una clave de API según su documentación. Restringe la clave a la API de Books y a los orígenes de Semantica. Open Library se usa sin clave para la búsqueda normal. La metadata se escribe en el paquete OPF del EPUB y en el front matter YAML de Markdown.

## Desarrollo y publicación

```bash
npm install
npm run build --workspace @semantica/semantica-wasm
npm test --workspace @semantica/semantica-wasm
npm run build --workspace @semantica/semantica-wasm
npm pack --dry-run --workspace @semantica/semantica-wasm
```

Para ejecutar además la prueba real de Laya con el modelo local:

```bash
SEMANTICA_MODEL_PATH="$PWD/semantica_wasm/build-multilingual/model" npm test --workspace @semantica/semantica-wasm
```

El paquete no incluye el modelo de 358 MB. Antes de publicar, confirma el acceso al scope npm `@semantica`, la licencia del proyecto y que el modelo se distribuya por separado. `npm pack --dry-run` sirve para revisar el contenido del tarball.

## Descargar y preparar el modelo

Un usuario externo puede descargar y preparar el modelo compatible desde el repositorio de la librería:

```bash
npm run model:download
```

Requiere Git y Python 3.11 o posterior. El script crea un entorno virtual bajo la caché del usuario, instala ahí las herramientas de exportación, descarga el checkpoint original desde [ConvAI Innovations en Hugging Face](https://huggingface.co/convaiinnovations/laya/tree/main/multilingual), lo exporta a ONNX, lo cuantiza a `q8e8` y prepara los archivos que consume este runtime. El checkpoint original ocupa unos 644 MB y la exportación requiere espacio en disco y memoria adicionales. No se usa directamente un ONNX de terceros: su arquitectura de entradas/salidas y cuantización no coinciden con el manifiesto `q8e8` que espera la librería.

En el checkout monorepo, el resultado se guarda en `apps/web/public/models/laya-multilingual/`; en un checkout independiente de `semantica-wasm`, queda en `models/laya-multilingual/`. Se puede cambiar con `WEB_MODEL_DIR` y seleccionar el Python con `PYTHON_BIN`, por ejemplo:

```bash
PYTHON_BIN="$PWD/.venv/bin/python" npm run model:download
```

El modelo es un artefacto descargable y no se incluye en Git ni en el tarball npm. `BookcliWasm.load()` y `BookcliWasmClient.load()` descargan los archivos ONNX ya preparados desde el modelo público `SemanticaBook/semantica-laya-multilingual-onnx` en Hugging Face Hub, verifican sus hashes, los guardan en Cache Storage e inicializan ONNX Runtime dentro del navegador. Puedes pasar otra URL base como argumento o configurar `VITE_LAYA_MODEL_BASE_URL` al construir la web. La conversión del checkpoint oficial `safetensors` a ONNX requiere PyTorch/ONNX, memoria y almacenamiento considerables; se hace fuera del navegador en la acción `Build and publish Laya browser model`, no durante la carga. La descarga de los pesos y la inferencia sí ocurren en el dispositivo del usuario.

Para publicar o actualizar el modelo desde GitHub Actions, configura el secreto `HF_TOKEN` con un token de Hugging Face con permiso de escritura y ejecuta manualmente el workflow `Build and publish Laya browser model` en el repositorio web. Opcionalmente define la variable `LAYA_MODEL_REPO` si quieres usar otro repositorio público de modelos. El workflow compila desde el checkpoint multilingüe oficial, incluye los avisos de licencia y publica el artefacto fuera del build de Pages. La acción normal de deploy publica solo la web. Si usas una URL distinta, configura `VITE_LAYA_MODEL_BASE_URL` como variable de Actions para la compilación de la web.

El empaquetado agrega un SHA-256 por chunk. El navegador verifica cada parte por separado en vez de pedirle a Web Crypto un búfer adicional del tamaño completo del modelo, lo que reduce el pico de memoria en Android. Si se cambia o vuelve a empaquetar el modelo, `build-model.sh` regenera los hashes. En errores de memoria, la web muestra el tamaño de los pesos, la RAM total estimada del dispositivo y, si Chromium la expone, el heap JS aproximado disponible. El navegador no ofrece una API estándar para consultar la RAM libre exacta del sistema.

El checkpoint se toma del subdirectorio `multilingual` del repositorio oficial, que usa mmBERT-base, idioma multilingüe y límites de 1024/256 tokens. No se sustituye por el checkpoint inglés de la demo. La cuantización reduce el peso, por lo que antes de distribuir un modelo conviene comparar salidas cuantizadas contra PyTorch con el conjunto propio de libros y OCR.

## Uso desde TypeScript

```ts
import { BookcliWasm } from "@semantica/semantica-wasm";

const classifier = await BookcliWasm.load();
const result = await classifier.classifyText(
  text,
  onProgress,
  async (question) => {
    // Mostrar la pregunta en la interfaz y devolver una etiqueta de BOOKCLI_LABELS.
    return question.suggested_label;
  },
);
```

La clasificación usa las categorías de BookCLI (`title`, `heading`, `subheading`, `paragraph`, `list_item`, `caption`, `noise`, `other`), comienza por defecto con contexto de nivel 3 (tres bloques a cada lado), amplía hasta el nivel 5 y conserva decisiones manuales recientes. Las instrucciones, niveles mínimo/máximo, confianza de autoaceptación, conservación de ruido y lenguas OCR se ajustan en la página **Inferencia** de la app web y se guardan en el navegador. El umbral predeterminado de autoaceptación es 0.85. Cuando el navegador expone WebGPU (`navigator.gpu`), la sesión se crea con `["webgpu", "wasm"]` para preferir la GPU y caer a WASM si no está disponible. El backend WASM usa varios hilos solo cuando `crossOriginIsolated` es verdadero, por lo que el servidor debe enviar `Cross-Origin-Opener-Policy: same-origin` y `Cross-Origin-Embedder-Policy: require-corp`. Vite ya envía esos encabezados en dev y preview; el hosting de producción debe configurarlos también.

En móviles y dispositivos que reportan 4 GB de memoria o menos, la carga fuerza WASM con un hilo para reducir presión sobre la memoria y evita reservar una copia del modelo en WebGPU. Si Cache Storage está lleno, bloqueado o no disponible, la sesión puede continuar sin persistir los pesos. Un fallo de descarga o de inicialización conserva el mensaje técnico para la interfaz.

El clasificador reconoce secciones de índice/tabla de contenido, separa entradas OCR concatenadas, elimina líderes de puntos y folios impresos y fuerza sus entradas a `list_item`. Después compara los títulos con encabezados del cuerpo; las coincidencias confiables se convierten en enlaces internos con anclas compartidas en Markdown y EPUB. Los destinos ambiguos permanecen como elementos de lista sin enlace.

La versión web usa pesos cuantizados (`q8e8`) y una implementación TypeScript de las reglas. Por eso la salida no es idéntica a Python, que carga el checkpoint Laya y su prompt de perfil; conviene comparar con los mismos bloques de texto ya extraídos para separar diferencias del OCR de diferencias del clasificador.

## Licencias y notices

El código portado de inferencia/ONNX usado por el exportador se mantiene en el checkout temporal Apache-2.0 de layaForWeb; los modelos exportados incluyen su `LICENSE` y `NOTICE.md`. Los pesos pertenecen a ConvAI Innovations (Apache-2.0), se basan en mmBERT y se distribuyen con los avisos incluidos en el paquete generado. `onnxruntime-web` es MIT y `@huggingface/tokenizers` es Apache-2.0; cada paquete conserva sus notices en el árbol npm. Esta adaptación no está afiliada a ConvAI Innovations.
# semantica-wasm
