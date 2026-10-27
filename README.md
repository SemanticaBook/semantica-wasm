# semanticabook

Semantica convierte PDFs a EPUB y Markdown con un solo procesamiento compartido. Extrae texto digital, puede usar OCR en páginas escaneadas y aplica reglas semánticas o Laya para recuperar títulos, párrafos, índices e ilustraciones.

El paquete ofrece dos formas de uso: una API para proyectos Node.js y el comando `semanticabook` para trabajar directamente desde la terminal. Requiere Node.js 22 o posterior. El código de Semantica se distribuye bajo MIT; consulta [LICENSE](./LICENSE) y [NOTICE](./NOTICE.md) para los avisos de terceros.

## CLI

Instálalo globalmente:

```bash
npm install --global semanticabook
semanticabook --help
```

Convierte uno o varios PDFs desde la terminal:

```bash
semanticabook convert libro.pdf --format both --output ./resultado
semanticabook convert *.pdf --ocr --laya --format epub --output ./epubs
semanticabook convert libro.pdf --title "Mi libro" --author "Una autora" --cover ./portada.jpg
semanticabook model download --model-dir ./models/laya-multilingual
```

Opciones principales:

- `--format epub|markdown|both`: formatos a guardar (predeterminado: ambos).
- `--ocr`: activa Tesseract para páginas con contenido visual no representado por la capa de texto.
- `--laya`: clasifica la estructura con el modelo local Laya.
- `--model-dir <ruta>`: ubicación del modelo Laya (predeterminada: caché del usuario; también se puede definir `SEMANTICA_MODEL_DIR`).
- `--output <directorio>`: destino de los archivos (predeterminado: `./semantica-output`).
- `--title`, `--author`, `--publisher`, `--year` y `--cover`: metadata opcional para el libro.

Los archivos se procesan uno por uno. Si pasas varios PDFs, cada uno obtiene su propia carpeta dentro del directorio de salida. Laya es opcional; si se activa y no encuentra el modelo, Semantica descarga el ONNX ya preparado, verifica sus bloques y continúa. No necesita Bash, Git, Python ni PyTorch para convertir. La primera descarga requiere conexión a Internet, unos 370 MB de almacenamiento y memoria adicional al iniciar el runtime; las siguientes ejecuciones reutilizan la caché. Sin `--laya`, la conversión usa las reglas locales.

## API de Node.js

Instala el paquete en tu proyecto:

```bash
npm install semanticabook
```

Procesa una vez y guarda uno o ambos resultados:

```js
import Semantica from "semanticabook";

const semantica = new Semantica({
  useOcr: true,
  useLaya: true,
  inferenceSettings: {
    minContextLevel: 3,
    maxContextLevel: 5,
    autoAcceptThreshold: 0.85,
  },
  onProgress: (percent, label) => console.log(`[${percent}%] ${label}`),
  onModelProgress: (label, percent) => console.log(`[Laya ${percent}%] ${label}`),
});

const content = await semantica.convert("./libro.pdf");
await semantica.convertPDFtoMarkdown(content).save("./resultado");
await semantica.convertPDFtoEPUB(content).save("./resultado");
```

`convert()` procesa el PDF una sola vez y devuelve contenido reutilizable para ambas salidas. `save(ruta)` acepta una carpeta o una ruta de archivo con extensión `.md` o `.epub`; devuelve la ruta guardada. La conversión también expone `content.pages`, `content.pdfFilename`, `content.markdownFilename` y `content.epubFilename`.

La clase se puede importar como default o como export nombrado:

```js
import Semantica, { Semantica as SemanticaNamed } from "semanticabook";
```

Para acceso avanzado a las funciones de bajo nivel de Node, importa `semanticabook/node`. El subpath `semanticabook/browser` conserva la entrada para navegadores y bundlers compatibles con Vite.

### Opciones

El constructor acepta opciones compartidas con el motor, incluyendo `useOcr`, `useLaya`, `modelDirectory`, `modelBaseUrl` (espejo opcional del modelo), `inferenceSettings`, `bookMetadata`, `onReview`, `onClassification` y callbacks de progreso. También puedes pasar ajustes particulares en el segundo argumento de `convert(pdfPath, overrides)`. Si se activa `useLaya`, la primera conversión descarga el modelo si hace falta; requiere conexión a Internet y no necesita preparación manual.

Para especificar metadata y portada local desde código:

```js
const semantica = new Semantica({
  bookMetadata: {
    mode: "manual",
    metadata: { title: "Mi libro", authors: ["Una autora"], language: "es" },
    cover: { path: "./portada.jpg" },
  },
});
```

## Modelo Laya

El modelo no está incluido en el paquete npm. La ejecución con `useLaya: true` o la opción CLI `--laya` busca primero una instalación válida en la caché local. Si no existe, descarga automáticamente los pesos ONNX preparados: intenta primero la fuente configurada y luego el respaldo versionado de Semantica en GitHub. Verifica tamaño y SHA-256 por bloque antes de dejar listo el manifiesto. No exporta el checkpoint ni instala herramientas de desarrollo durante una conversión normal.

La caché predeterminada es `~/.cache/semantica/models/laya-multilingual` en Linux/macOS y `%LOCALAPPDATA%/semantica/models/laya-multilingual` en Windows. Puedes elegir otra carpeta mediante la opción `modelDirectory` o la variable `SEMANTICA_MODEL_DIR`. Para usar una fuente primaria alternativa define `SEMANTICA_LAYA_MODEL_BASE_URL`. El respaldo oficial versionado se intenta automáticamente si la fuente primaria no está disponible.

La descarga se inicia automáticamente cuando el flujo necesita clasificar con Laya. También se puede descargar manualmente antes de una conversión:

```bash
npm run model:download
```

También puedes descargarlo desde cualquier directorio con `semanticabook model download --model-dir ./models/laya-multilingual`. Ese comando obtiene el mismo artefacto listo para ejecutar; no necesita Python, Bash, Git ni PyTorch.

La construcción de una nueva variante desde el checkpoint upstream es una tarea de desarrollo separada y puede requerir Python, PyTorch y recursos adicionales. No forma parte de la ruta de uso de la librería. La inferencia de cada libro ocurre localmente en el equipo del usuario.

## Desarrollo

```bash
npm install
npm run build
npm pack --dry-run
```

El tarball no incluye los pesos de Laya ni PDFs de prueba. Para publicar una nueva versión, incrementa `version`, inicia sesión con `npm login` y ejecuta `npm publish` desde el directorio del paquete.
