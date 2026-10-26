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
- `--model-dir <ruta>`: ubicación del modelo Laya (predeterminada: `./models/laya-multilingual`).
- `--output <directorio>`: destino de los archivos (predeterminado: `./semantica-output`).
- `--title`, `--author`, `--publisher`, `--year` y `--cover`: metadata opcional para el libro.

Los archivos se procesan uno por uno. Si pasas varios PDFs, cada uno obtiene su propia carpeta dentro del directorio de salida. Laya es opcional; si se activa y no encuentra el modelo, Semantica descarga el checkpoint oficial y prepara el formato compatible antes de continuar. Esa preparación requiere Bash, Git, Python 3.11 o posterior, conexión a internet, almacenamiento y memoria suficientes. Sin `--laya`, la conversión usa las reglas locales.

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
  modelDirectory: "./models/laya-multilingual",
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

El constructor acepta opciones compartidas con el motor, incluyendo `useOcr`, `useLaya`, `modelDirectory`, `inferenceSettings`, `bookMetadata`, `onReview`, `onClassification` y callbacks de progreso. También puedes pasar ajustes particulares en el segundo argumento de `convert(pdfPath, overrides)`.

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

El modelo no está incluido en el paquete npm. La ejecución con `useLaya: true` o la opción CLI `--laya` busca primero los archivos preparados en `modelDirectory`. Si faltan, el core descarga el checkpoint multilingüe oficial de ConvAI Innovations y prepara un modelo ONNX local. Para preparar el modelo por separado usa:

```bash
npm run model:download
```

También puedes preparar el modelo desde cualquier directorio con `semanticabook model download --model-dir ./models/laya-multilingual`.

La preparación del checkpoint necesita recursos adicionales y tarda más que una conversión normal. Después, los pesos se reutilizan desde el directorio local. La inferencia ocurre en el equipo del usuario.

## Desarrollo

```bash
npm install
npm run build
npm pack --dry-run
```

El tarball no incluye los pesos de Laya ni PDFs de prueba. Para publicar una nueva versión, incrementa `version`, inicia sesión con `npm login` y ejecuta `npm publish` desde el directorio del paquete.
