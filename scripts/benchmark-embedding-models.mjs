#!/usr/bin/env node
/**
 * Benchmark de recuperación semántica para decidir si migrar el embedder.
 *
 * Solo mide el fixture sintético versionado en test/fixtures/embedding-eval/.
 * No lee memorydata, no escribe bases de datos, no modifica package.json ni el
 * embedder de producción.
 *
 * Uso:
 *   TRANSFORMERS_MODULE=/ruta/@xenova/transformers/src/transformers.js \
 *   TRANSFORMERS_CACHE=/tmp/embedding-eval-cache \
 *   node scripts/benchmark-embedding-models.mjs --out /tmp/resultados.json
 *
 * Por defecto carga negatives-extended.json si existe. Usa --no-extended para
 * evaluar solo el core 36/18 o --extended-negatives <ruta> para otro archivo.
 * --thresholds 0.30,0.35,... evalúa una lista propia (validada: finita, [0,2],
 * ascendente y sin duplicados) sin editar el dataset.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, '..', 'test', 'fixtures', 'embedding-eval');
const DEFAULT_DATASET = path.join(FIXTURE_DIR, 'dataset.json');
const DEFAULT_EXTENDED_NEGATIVES = path.join(FIXTURE_DIR, 'negatives-extended.json');
const TOP_K = 8;
const GLOBAL_RANK_LIMIT = 50;
const DEFAULT_THRESHOLDS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 1.0, 1.140175];
const PRODUCTION_THRESHOLD = 0.75;
const REQUIRED_KNOWN_AMBIGUOUS = 'memory-test-hybrid-smoke-20261106-a7f3c9';
const EPSILON = 1e-12;

const MODELS = [
    {
        key: 'minilm',
        label: 'MiniLM',
        model: 'Xenova/all-MiniLM-L6-v2',
        docPrefix: '',
        queryPrefix: ''
    },
    {
        key: 'e5-small',
        label: 'E5-small',
        model: 'Xenova/multilingual-e5-small',
        docPrefix: 'passage: ',
        queryPrefix: 'query: '
    },
    {
        key: 'bge-small',
        label: 'BGE-small',
        model: 'Xenova/bge-small-en-v1.5',
        docPrefix: '',
        queryPrefix: 'Represent this sentence for searching relevant passages: '
    }
];

function parseThresholds(raw) {
    assert(typeof raw === 'string' && raw.trim().length > 0, '--thresholds requiere una lista separada por comas');
    const tokens = raw.split(',').map(token => token.trim()).filter(token => token.length > 0);
    assert(tokens.length > 0, '--thresholds requiere al menos un threshold');
    const values = tokens.map(token => Number(token));
    for (let index = 0; index < values.length; index += 1) {
        assert(Number.isFinite(values[index]), `Threshold no finito en --thresholds: ${tokens[index]}`);
        assert(values[index] >= 0 && values[index] <= 2, `Threshold fuera de [0,2]: ${tokens[index]}`);
        if (index > 0) {
            assert(
                values[index] > values[index - 1],
                `--thresholds debe ser estrictamente ascendente sin duplicados: ${tokens[index - 1]} >= ${tokens[index]}`
            );
        }
    }
    return values;
}

function parseArgs(argv) {
    const options = {
        dataset: DEFAULT_DATASET,
        extendedNegatives: fs.existsSync(DEFAULT_EXTENDED_NEGATIVES) ? DEFAULT_EXTENDED_NEGATIVES : null,
        cache: process.env.TRANSFORMERS_CACHE || fs.mkdtempSync(path.join(os.tmpdir(), 'embedding-eval-cache-')),
        out: null,
        thresholds: DEFAULT_THRESHOLDS.slice(),
        thresholdsExplicit: false
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--dataset') options.dataset = path.resolve(argv[++index]);
        else if (arg === '--extended-negatives') options.extendedNegatives = path.resolve(argv[++index]);
        else if (arg === '--no-extended') options.extendedNegatives = null;
        else if (arg === '--cache') options.cache = path.resolve(argv[++index]);
        else if (arg === '--out') options.out = path.resolve(argv[++index]);
        else if (arg === '--thresholds') {
            options.thresholds = parseThresholds(argv[++index]);
            options.thresholdsExplicit = true;
        } else if (arg === '--help' || arg === '-h') {
            console.log(
                'Uso: node scripts/benchmark-embedding-models.mjs [--dataset ruta] ' +
                '[--extended-negatives ruta | --no-extended] [--thresholds 0.5,0.75,0.9] ' +
                '[--cache ruta] [--out ruta]'
            );
            process.exit(0);
        } else {
            throw new Error(`Argumento desconocido: ${arg}`);
        }
    }
    options.cache = path.resolve(options.cache);
    return options;
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function readDatasetFile(filePath, label) {
    assert(fs.existsSync(filePath), `${label} no existe: ${filePath}`);
    const raw = fs.readFileSync(filePath);
    const dataset = JSON.parse(raw.toString('utf8'));
    const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
    return { dataset, sha256 };
}

function validateProtocol(dataset, label, { enforceThresholds = true } = {}) {
    assert(dataset.synthetic === true, `${label} debe declararse synthetic=true`);
    assert(dataset.protocol?.topK === TOP_K, `${label}: protocol.topK debe ser ${TOP_K}`);
    if (enforceThresholds) {
        assert(
            JSON.stringify(dataset.protocol.thresholds) === JSON.stringify(DEFAULT_THRESHOLDS),
            `${label}: protocol.thresholds debe ser exactamente ${JSON.stringify(DEFAULT_THRESHOLDS)} ` +
            '(usa --thresholds para evaluar otra lista)'
        );
    } else {
        // Con --thresholds la lista efectiva es la de la CLI; la del dataset solo se conserva como metadato.
        assert(Array.isArray(dataset.protocol?.thresholds), `${label}: protocol.thresholds debe ser una lista`);
    }
}

function loadCoreDataset(datasetPath, protocolOptions) {
    const { dataset, sha256 } = readDatasetFile(datasetPath, 'Dataset core');
    validateProtocol(dataset, 'Dataset core', protocolOptions);
    assert(Array.isArray(dataset.corpus) && dataset.corpus.length > 0, 'El corpus debe tener al menos un documento');
    assert(Array.isArray(dataset.positives) && dataset.positives.length > 0, 'Debe haber al menos una consulta positiva');
    assert(Array.isArray(dataset.negatives) && dataset.negatives.length > 0, 'Debe haber al menos una consulta negativa');

    const docIds = new Set();
    for (const doc of dataset.corpus) {
        assert(typeof doc.id === 'string' && doc.id.length > 0, 'Documento sin id');
        assert(typeof doc.text === 'string' && doc.text.trim().length > 0, `Documento ${doc.id} sin texto`);
        assert(!docIds.has(doc.id), `Documento duplicado: ${doc.id}`);
        docIds.add(doc.id);
    }

    const difficultyCounts = { easy: 0, medium: 0, hard: 0 };
    const targets = new Set();
    const positiveIds = new Set();
    const positiveQueries = new Set();
    for (const positive of dataset.positives) {
        assert(typeof positive.id === 'string' && positive.id.length > 0, 'Consulta positiva sin id');
        assert(!positiveIds.has(positive.id), `Consulta positiva con id duplicado: ${positive.id}`);
        positiveIds.add(positive.id);
        assert(positive.difficulty in difficultyCounts, `Dificultad desconocida en ${positive.id}`);
        difficultyCounts[positive.difficulty] += 1;
        assert(docIds.has(positive.target), `Target inexistente en ${positive.id}: ${positive.target}`);
        assert(!targets.has(positive.target), `Target repetido: ${positive.target}`);
        targets.add(positive.target);
        assert(typeof positive.query === 'string' && positive.query.trim().length > 0, `Consulta vacía en ${positive.id}`);
        assert(!positiveQueries.has(positive.query), `Consulta positiva duplicada: ${positive.query}`);
        positiveQueries.add(positive.query);
    }
    for (const difficulty of Object.keys(difficultyCounts)) {
        assert(difficultyCounts[difficulty] >= 1, `Se requiere al menos una consulta positiva de dificultad ${difficulty}`);
    }
    assert(targets.size === docIds.size, 'Cada documento debe ser objetivo de exactamente una consulta positiva');

    const negativeKinds = { general: 0, 'near-miss': 0, ambiguous: 0 };
    const negativeIds = new Set();
    const negativeQueries = new Set();
    for (const negative of dataset.negatives) {
        assert(typeof negative.id === 'string' && negative.id.length > 0, 'Consulta negativa sin id');
        assert(!negativeIds.has(negative.id), `Consulta negativa con id duplicado: ${negative.id}`);
        negativeIds.add(negative.id);
        assert(negative.kind in negativeKinds, `Tipo de negativa desconocido en ${negative.id}`);
        negativeKinds[negative.kind] += 1;
        assert(typeof negative.query === 'string' && negative.query.trim().length > 0, `Consulta negativa vacía en ${negative.id}`);
        assert(!positiveQueries.has(negative.query), `Negativa repetida como positiva: ${negative.query}`);
        assert(!negativeQueries.has(negative.query), `Consulta negativa duplicada: ${negative.query}`);
        negativeQueries.add(negative.query);
    }
    assert(negativeKinds.general >= 1, 'Se requiere al menos una negativa general');
    assert(negativeKinds['near-miss'] >= 2, 'Se requieren al menos 2 negativas temáticamente cercanas');
    assert(negativeKinds.ambiguous >= 1, 'Se requiere al menos una negativa ambigua');
    assert(
        dataset.negatives.some(negative => negative.query === REQUIRED_KNOWN_AMBIGUOUS),
        `Falta la consulta ambigua conocida ${REQUIRED_KNOWN_AMBIGUOUS}`
    );

    return {
        dataset,
        sha256,
        docIds,
        positiveIds,
        negativeIds,
        querySet: new Set([...positiveQueries, ...negativeQueries]),
        counts: {
            corpus: dataset.corpus.length,
            positives: dataset.positives.length,
            negatives: dataset.negatives.length,
            difficulties: difficultyCounts,
            negativeKinds
        }
    };
}

function loadExtendedDataset(extendedPath, core) {
    const { dataset, sha256 } = readDatasetFile(extendedPath, 'Dataset extended');
    assert(dataset.synthetic === true, 'El dataset extended debe declararse synthetic=true');
    assert(Array.isArray(dataset.negatives) && dataset.negatives.length > 0, 'El dataset extended debe tener negativas');

    const negativeKinds = { general: 0, 'near-miss': 0, ambiguous: 0 };
    const negativeIds = new Set();
    const negativeQueries = new Set();
    for (const negative of dataset.negatives) {
        assert(typeof negative.id === 'string' && negative.id.length > 0, 'Consulta extended sin id');
        assert(!negativeIds.has(negative.id), `Consulta extended con id duplicado: ${negative.id}`);
        assert(!core.negativeIds.has(negative.id), `Id extended repetido en core: ${negative.id}`);
        negativeIds.add(negative.id);
        assert(negative.kind in negativeKinds, `Tipo de negativa extended desconocido en ${negative.id}`);
        negativeKinds[negative.kind] += 1;
        assert(typeof negative.query === 'string' && negative.query.trim().length > 0, `Consulta extended vacía en ${negative.id}`);
        assert(!core.querySet.has(negative.query), `Consulta extended duplicada en core/positivas: ${negative.query}`);
        assert(!negativeQueries.has(negative.query), `Consulta extended duplicada: ${negative.query}`);
        negativeQueries.add(negative.query);
    }
    assert(negativeKinds['near-miss'] >= 10, 'El extended requiere al menos 10 negativas near-miss');
    assert(negativeKinds.general >= 8, 'El extended requiere al menos 8 negativas generales');
    assert(negativeKinds.ambiguous >= 4, 'El extended requiere al menos 4 negativas ambiguas');

    return {
        dataset,
        sha256,
        negativeIds,
        querySet: negativeQueries,
        counts: {
            negatives: dataset.negatives.length,
            negativeKinds
        }
    };
}

function applyPrefix(text, prefix, label) {
    if (!prefix) return text;
    if (text.startsWith(prefix)) {
        throw new Error(`Prefijo duplicado en ${label}: el texto ya empieza por "${prefix}"`);
    }
    return prefix + text;
}

function normalize(vector) {
    let normSquared = 0;
    for (const value of vector) {
        assert(Number.isFinite(value), 'Embedding con valor no finito');
        normSquared += value * value;
    }
    assert(normSquared > 0, 'Embedding con norma cero');
    const norm = Math.sqrt(normSquared);
    const result = new Float32Array(vector.length);
    for (let index = 0; index < vector.length; index += 1) result[index] = vector[index] / norm;
    return result;
}

function cosineDistance(left, right) {
    assert(left.length === right.length, 'Dimensiones de embedding incompatibles');
    let dot = 0;
    for (let index = 0; index < left.length; index += 1) dot += left[index] * right[index];
    // vec_distance_cosine puede devolver un negativo ínfimo por redondeo; se acota a [0, 2].
    return Math.min(2, Math.max(0, 1 - dot));
}

function distanceToL2(cosine) {
    return Math.sqrt(2 * cosine);
}

function rankDocuments(queryVector, documents) {
    // La distancia no depende del threshold: se calcula y ordena una vez por consulta.
    return documents
        .map(document => ({
            id: document.id,
            cosineDistance: cosineDistance(queryVector, document.vector)
        }))
        .sort((left, right) => left.cosineDistance - right.cosineDistance || left.id.localeCompare(right.id));
}

function computeThresholdPoints({ positives, negatives }, documentVectors, positiveVectors, negativeVectors, thresholds) {
    const positiveRuns = positives.map((positive, index) => ({
        positive,
        ranked: rankDocuments(positiveVectors[index], documentVectors)
    }));
    const negativeRuns = negatives.map((negative, index) => ({
        negative,
        ranked: rankDocuments(negativeVectors[index], documentVectors)
    }));

    const negativeKindTotals = { general: 0, 'near-miss': 0, ambiguous: 0 };
    for (const negative of negatives) negativeKindTotals[negative.kind] += 1;
    const trueNoiseTotal = negativeKindTotals.general + negativeKindTotals.ambiguous;

    return thresholds.map(threshold => {
        const maxCosineDistance = threshold ** 2 / 2;
        const isAccepted = result => result.cosineDistance <= maxCosineDistance + EPSILON;

        let hits = 0;
        let retrieved = 0;
        let relevantRetrieved = 0;
        const missedPositives = [];
        for (const { positive, ranked } of positiveRuns) {
            const results = ranked.filter(isAccepted).slice(0, TOP_K);
            const found = results.some(result => result.id === positive.target);
            if (found) {
                hits += 1;
                relevantRetrieved += 1;
            } else {
                const targetIndex = ranked.findIndex(result => result.id === positive.target);
                assert(targetIndex >= 0, `Target no encontrado en el ranking de ${positive.id}: ${positive.target}`);
                const targetEntry = ranked[targetIndex];
                const rank = targetIndex + 1;
                const withinThreshold = isAccepted(targetEntry);
                missedPositives.push({
                    id: positive.id,
                    difficulty: positive.difficulty,
                    target: positive.target,
                    rank: rank <= GLOBAL_RANK_LIMIT ? rank : null,
                    rankBeyondLimit: rank > GLOBAL_RANK_LIMIT,
                    cosineDistanceToTarget: targetEntry.cosineDistance,
                    distanceToTarget: distanceToL2(targetEntry.cosineDistance),
                    withinThreshold
                });
            }
            retrieved += results.length;
        }

        let falsePositiveQueries = 0;
        let negativeResults = 0;
        const falsePositiveByKind = { general: 0, 'near-miss': 0, ambiguous: 0 };
        const falsePositives = [];
        for (const { negative, ranked } of negativeRuns) {
            const results = ranked.filter(isAccepted).slice(0, TOP_K);
            if (results.length > 0) {
                falsePositiveQueries += 1;
                falsePositiveByKind[negative.kind] += 1;
                falsePositives.push({
                    id: negative.id,
                    kind: negative.kind,
                    topId: results[0].id,
                    cosineDistance: results[0].cosineDistance,
                    distance: distanceToL2(results[0].cosineDistance)
                });
            }
            negativeResults += results.length;
        }

        const falsePositiveRateByKind = {};
        for (const kind of Object.keys(negativeKindTotals)) {
            falsePositiveRateByKind[kind] = negativeKindTotals[kind] > 0
                ? falsePositiveByKind[kind] / negativeKindTotals[kind]
                : null;
        }
        const trueNoiseFalsePositiveQueries = falsePositiveByKind.general + falsePositiveByKind.ambiguous;
        const trueNoiseFalsePositiveRate = trueNoiseTotal > 0
            ? trueNoiseFalsePositiveQueries / trueNoiseTotal
            : null;
        const nearMissFalsePositiveRate = negativeKindTotals['near-miss'] > 0
            ? falsePositiveByKind['near-miss'] / negativeKindTotals['near-miss']
            : null;
        const trueNoiseFalsePositiveIds = falsePositives
            .filter(entry => entry.kind !== 'near-miss')
            .map(entry => entry.id);

        const recallAt8 = hits / positives.length;
        const falsePositiveRate = falsePositiveQueries / negatives.length;
        const precisionProxy = retrieved > 0 ? relevantRetrieved / retrieved : 0;
        const f1 = precisionProxy + recallAt8 > 0
            ? (2 * precisionProxy * recallAt8) / (precisionProxy + recallAt8)
            : 0;
        const guardPass = recallAt8 >= 0.8 - EPSILON && falsePositiveRate <= 0.1 + EPSILON;
        // Reporte adicional, no sustituye guardPass ni la regla A/B pre-registrada.
        const trueNoiseGuardPass = recallAt8 >= 0.8 - EPSILON &&
            (trueNoiseFalsePositiveRate === null || trueNoiseFalsePositiveRate <= 0.1 + EPSILON);

        return {
            threshold,
            hits,
            misses: positives.length - hits,
            recallAt8,
            falsePositiveQueries,
            falsePositiveRate,
            falsePositiveByKind,
            falsePositiveRateByKind,
            trueNoiseFalsePositiveQueries,
            trueNoiseFalsePositiveRate,
            nearMissFalsePositiveRate,
            trueNoiseFalsePositiveIds,
            negativeResults,
            retrieved,
            relevantRetrieved,
            precisionProxy,
            f1,
            guardPass,
            trueNoiseGuardPass,
            falsePositiveIds: falsePositives.map(entry => entry.id),
            falsePositives,
            missedPositiveIds: missedPositives.map(entry => entry.id),
            missedPositives
        };
    });
}

function bestF1(points) {
    const maximum = Math.max(...points.map(point => point.f1));
    const ties = points.filter(point => Math.abs(point.f1 - maximum) <= EPSILON);
    const selected = ties.reduce((best, point) => point.threshold < best.threshold ? point : best);
    return {
        maxF1: maximum,
        thresholds: ties.map(point => point.threshold),
        selectedThreshold: selected.threshold,
        selected: selected
    };
}

function dirStats(directory) {
    if (!fs.existsSync(directory)) return { files: 0, bytes: 0 };
    let files = 0;
    let bytes = 0;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            const child = dirStats(fullPath);
            files += child.files;
            bytes += child.bytes;
        } else if (entry.isFile()) {
            files += 1;
            bytes += fs.statSync(fullPath).size;
        }
    }
    return { files, bytes };
}

function findPackageVersion(moduleUrl) {
    if (!moduleUrl.startsWith('file:')) return null;
    let directory = path.dirname(fileURLToPath(moduleUrl));
    for (let depth = 0; depth < 8; depth += 1) {
        const packagePath = path.join(directory, 'package.json');
        if (fs.existsSync(packagePath)) {
            const metadata = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
            if (metadata.name === '@xenova/transformers') return metadata.version;
        }
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
    }
    return null;
}

async function loadTransformers() {
    const override = process.env.TRANSFORMERS_MODULE;
    const specifier = override ? pathToFileURL(path.resolve(override)).href : '@xenova/transformers';
    let resolved = specifier;
    if (!override) {
        try {
            resolved = import.meta.resolve(specifier);
        } catch {
            // El import de abajo produce el error accionable.
        }
    }
    try {
        const module = await import(specifier);
        return { module, resolved, version: findPackageVersion(resolved) };
    } catch (cause) {
        throw new Error(
            'No se pudo cargar @xenova/transformers. Instálalo en el proyecto o define ' +
            'TRANSFORMERS_MODULE con la ruta absoluta a src/transformers.js.',
            { cause }
        );
    }
}

async function evaluateModel({ config, dataset, extended, transformers, cacheDir, thresholds }) {
    const { pipeline, env } = transformers;
    env.cacheDir = cacheDir;
    env.allowRemoteModels = true;
    env.allowLocalModels = true;

    const modelCacheDir = path.join(cacheDir, 'Xenova', config.model.split('/').at(-1));
    const cacheBefore = dirStats(modelCacheDir);

    const loadStart = performance.now();
    const extractor = await pipeline('feature-extraction', config.model, { quantized: true });
    const loadMs = performance.now() - loadStart;

    const warmupStart = performance.now();
    await extractor('warmup', { pooling: 'mean', normalize: true });
    const warmupMs = performance.now() - warmupStart;

    async function embedTexts(texts) {
        const vectors = [];
        const started = performance.now();
        for (const text of texts) {
            const output = await extractor(text, { pooling: 'mean', normalize: true });
            const vector = normalize(Float32Array.from(output.data));
            assert(vector.length === 384, `Dimensión inesperada en ${config.model}: ${vector.length}`);
            vectors.push(vector);
        }
        return { vectors, ms: performance.now() - started };
    }

    const documentInputs = dataset.corpus.map(document =>
        applyPrefix(document.text, config.docPrefix, document.id)
    );
    const positiveInputs = dataset.positives.map(positive =>
        applyPrefix(positive.query, config.queryPrefix, positive.id)
    );
    const coreNegatives = dataset.negatives;
    const extendedNegatives = extended ? extended.negatives : [];
    const negativeInputs = [...coreNegatives, ...extendedNegatives].map(negative =>
        applyPrefix(negative.query, config.queryPrefix, negative.id)
    );

    const documentResult = await embedTexts(documentInputs);
    const queryResult = await embedTexts([...positiveInputs, ...negativeInputs]);

    const documentVectors = dataset.corpus.map((document, index) => ({
        id: document.id,
        vector: documentResult.vectors[index]
    }));
    const positiveVectors = positiveInputs.map((_, index) => queryResult.vectors[index]);
    const negativeVectors = negativeInputs.map((_, index) =>
        queryResult.vectors[positiveInputs.length + index]
    );
    const coreNegativeVectors = negativeVectors.slice(0, coreNegatives.length);
    const extendedNegativeVectors = negativeVectors.slice(coreNegatives.length);

    function buildSet(name, positives, negatives, negativeVectorList) {
        const points = computeThresholdPoints(
            { positives, negatives },
            documentVectors,
            positiveVectors,
            negativeVectorList,
            thresholds
        );
        const negativeKindTotals = { general: 0, 'near-miss': 0, ambiguous: 0 };
        for (const negative of negatives) negativeKindTotals[negative.kind] += 1;
        const set = {
            name,
            positives: positives.length,
            negatives: negatives.length,
            negativeKindTotals,
            thresholds: points,
            bestF1: bestF1(points),
            guard: {
                requirement: 'recall@8 >= 0.80 y FP-rate <= 0.10',
                pass: points.some(point => point.guardPass),
                thresholds: points.filter(point => point.guardPass).map(point => point.threshold)
            }
        };
        if (name === 'extended') {
            set.note = 'Diagnóstico solo de negativas: recall/F1 usan las mismas 36 positivas que core.';
        }
        return set;
    }

    const sets = {
        core: buildSet('core', dataset.positives, coreNegatives, coreNegativeVectors)
    };
    if (extended) {
        sets.combined = buildSet(
            'combined',
            dataset.positives,
            [...coreNegatives, ...extendedNegatives],
            negativeVectors
        );
        sets.extended = buildSet('extended', dataset.positives, extendedNegatives, extendedNegativeVectors);
    }

    const cacheAfter = dirStats(modelCacheDir);
    const totalTexts = documentInputs.length + positiveInputs.length + negativeInputs.length;

    return {
        key: config.key,
        label: config.label,
        model: config.model,
        prefixes: { documents: config.docPrefix, queries: config.queryPrefix },
        cost: {
            cacheState: cacheBefore.files > 0 ? 'warm' : 'cold',
            loadMs,
            warmupMs,
            texts: totalTexts,
            documentTexts: documentInputs.length,
            queryTexts: positiveInputs.length + negativeInputs.length,
            documentEmbedMs: documentResult.ms,
            queryEmbedMs: queryResult.ms,
            embedMs: documentResult.ms + queryResult.ms,
            perTextMs: (documentResult.ms + queryResult.ms) / totalTexts,
            modelCacheDir,
            modelCacheBefore: cacheBefore,
            modelCacheAfter: cacheAfter
        },
        sets
    };
}

function compareWithBaseline(baseline, candidate) {
    const baselineByThreshold = new Map(baseline.thresholds.map(point => [point.threshold, point]));
    return candidate.thresholds.map(point => {
        const reference = baselineByThreshold.get(point.threshold);
        const recallDelta = point.recallAt8 - reference.recallAt8;
        const fpDelta = point.falsePositiveRate - reference.falsePositiveRate;
        const baselineGuardPass = reference.recallAt8 >= 0.8 - EPSILON &&
            reference.falsePositiveRate <= 0.1 + EPSILON;
        const clauseA = recallDelta >= 0.30 - EPSILON && fpDelta <= 0.05 + EPSILON;
        const clauseB = point.recallAt8 >= 0.8 - EPSILON &&
            point.falsePositiveRate <= 0.1 + EPSILON && !baselineGuardPass;
        const noMigrateGuard = recallDelta < 0.15 - EPSILON || fpDelta > 0.10 + EPSILON;
        const verdict = clauseA || clauseB
            ? 'MIGRATE'
            : (noMigrateGuard ? 'NO_MIGRATE' : 'INCONCLUSIVE');
        return {
            threshold: point.threshold,
            recallDelta,
            fpDelta,
            baselineGuardPass,
            clauseA,
            clauseB,
            noMigrateGuard,
            verdict
        };
    });
}

function summarizeSetRecommendation(modelResults, setName) {
    const baseline = modelResults.find(result => result.key === 'minilm');
    const baselineSet = baseline.sets[setName];
    assert(baselineSet, `MiniLM no tiene el set ${setName}`);
    const defaultThreshold = PRODUCTION_THRESHOLD;
    const baselineDefault = baselineSet.thresholds.find(point => point.threshold === defaultThreshold) ?? null;
    const candidates = [];

    for (const result of modelResults) {
        if (result.key === 'minilm') continue;
        const set = result.sets[setName];
        assert(set, `${result.label} no tiene el set ${setName}`);
        const comparisons = compareWithBaseline(baselineSet, set);
        set.comparisonVsMiniLM = comparisons;

        const migrationPoints = comparisons.filter(comparison => comparison.verdict === 'MIGRATE');
        const noMigrationPoints = comparisons.filter(comparison => comparison.verdict === 'NO_MIGRATE');
        const inconclusivePoints = comparisons.filter(comparison => comparison.verdict === 'INCONCLUSIVE');
        const qualifyingGuard = set.thresholds
            .filter(point => point.guardPass)
            .sort((left, right) =>
                right.recallAt8 - left.recallAt8 ||
                left.falsePositiveRate - right.falsePositiveRate ||
                left.threshold - right.threshold
            );
        const bestMigration = migrationPoints
            .map(comparison => ({
                comparison,
                point: set.thresholds.find(point => point.threshold === comparison.threshold)
            }))
            .sort((left, right) =>
                right.point.recallAt8 - left.point.recallAt8 ||
                left.point.falsePositiveRate - right.point.falsePositiveRate ||
                left.point.threshold - right.point.threshold
            )[0] || null;
        const defaultComparison = comparisons.find(comparison => comparison.threshold === defaultThreshold) ?? null;
        const defaultPoint = set.thresholds.find(point => point.threshold === defaultThreshold) ?? null;

        candidates.push({
            key: result.key,
            label: result.label,
            anyMigrate: migrationPoints.length > 0,
            verdict: migrationPoints.length > 0
                ? 'MIGRATE'
                : (noMigrationPoints.length === comparisons.length ? 'NO_MIGRATE' : 'INCONCLUSIVE'),
            migrationThresholds: migrationPoints.map(comparison => comparison.threshold),
            noMigrationThresholds: noMigrationPoints.map(comparison => comparison.threshold),
            inconclusiveThresholds: inconclusivePoints.map(comparison => comparison.threshold),
            bestMigration: bestMigration
                ? {
                    threshold: bestMigration.comparison.threshold,
                    recallAt8: bestMigration.point.recallAt8,
                    falsePositiveRate: bestMigration.point.falsePositiveRate,
                    precisionProxy: bestMigration.point.precisionProxy,
                    f1: bestMigration.point.f1,
                    recallDelta: bestMigration.comparison.recallDelta,
                    fpDelta: bestMigration.comparison.fpDelta,
                    clauseA: bestMigration.comparison.clauseA,
                    clauseB: bestMigration.comparison.clauseB
                }
                : null,
            guard: {
                pass: set.guard.pass,
                thresholds: set.guard.thresholds,
                bestQualifyingThreshold: qualifyingGuard[0]
                    ? {
                        threshold: qualifyingGuard[0].threshold,
                        recallAt8: qualifyingGuard[0].recallAt8,
                        falsePositiveRate: qualifyingGuard[0].falsePositiveRate
                    }
                    : null
            },
            defaultThreshold: defaultPoint && defaultComparison && baselineDefault
                ? {
                    threshold: defaultThreshold,
                    recallAt8: defaultPoint.recallAt8,
                    falsePositiveRate: defaultPoint.falsePositiveRate,
                    baselineRecallAt8: baselineDefault.recallAt8,
                    baselineFalsePositiveRate: baselineDefault.falsePositiveRate,
                    recallDelta: defaultComparison.recallDelta,
                    fpDelta: defaultComparison.fpDelta,
                    verdict: defaultComparison.verdict
                }
                : null
        });
    }

    const migrating = candidates.filter(candidate => candidate.anyMigrate);
    const recommended = migrating
        .map(candidate => ({ candidate, point: candidate.bestMigration }))
        .sort((left, right) =>
            right.point.recallAt8 - left.point.recallAt8 ||
            left.point.falsePositiveRate - right.point.falsePositiveRate ||
            left.point.threshold - right.point.threshold
        )[0] || null;

    return {
        set: setName,
        positives: baselineSet.positives,
        negatives: baselineSet.negatives,
        rule: 'MIGRATE si A (dRecall>=0.30 y dFP<=0.05) o B (recall>=0.80, FP<=0.10 y MiniLM no cumple); NO_MIGRATE si no A/B y (dRecall<0.15 o dFP>0.10); si no, INCONCLUSIVE. B tiene precedencia sobre el mínimo de 0.15.',
        baseline: 'minilm',
        defaultThreshold,
        anyMigrate: migrating.length > 0,
        recommended: recommended
            ? {
                key: recommended.candidate.key,
                label: recommended.candidate.label,
                threshold: recommended.point.threshold,
                recallAt8: recommended.point.recallAt8,
                falsePositiveRate: recommended.point.falsePositiveRate,
                recallDelta: recommended.point.recallDelta,
                fpDelta: recommended.point.fpDelta
            }
            : null,
        note: migrating.length > 0
            ? 'La decisión aplica al threshold indicado; no se cambia el default de producción en este trabajo.'
            : 'Ningún candidato cumple el criterio pre-registrado en ningún threshold. No migrar con este fixture.',
        candidates
    };
}

function summarizeRecommendation(modelResults, setNames) {
    const bySet = {};
    for (const setName of setNames) {
        bySet[setName] = summarizeSetRecommendation(modelResults, setName);
    }
    const basis = setNames.includes('combined') ? 'combined' : 'core';
    const primary = bySet[basis];
    return {
        basis,
        availableSets: setNames,
        note: basis === 'combined'
            ? `Recomendación basada en combined (${primary.positives}/${primary.negatives}); ` +
              `core (${bySet.core.positives}/${bySet.core.negatives}) se conserva como referencia histórica.`
            : 'Recomendación basada en core (no se cargó el set extended).',
        bySet
    };
}

function formatPercent(value) {
    return `${(value * 100).toFixed(1)}%`;
}

function formatRate(value) {
    return value === null ? 'n/a' : formatPercent(value);
}

function formatIds(ids) {
    return ids.length > 0 ? ids.join(',') : '-';
}

function printKindTable(set) {
    const totals = set.negativeKindTotals;
    const trueNoiseTotal = totals.general + totals.ambiguous;
    console.log(
        'por tipo: threshold | recall@8 | FP gen | FP near | FP amb | FP ruido | rate ruido | ' +
        'rate near | guard ruido | ids ruido'
    );
    for (const point of set.thresholds) {
        const byKind = point.falsePositiveByKind;
        console.log(
            `${String(point.threshold).padEnd(9)} | ${formatPercent(point.recallAt8).padEnd(8)} | ` +
            `${`${byKind.general}/${totals.general}`.padEnd(6)} | ${`${byKind['near-miss']}/${totals['near-miss']}`.padEnd(8)} | ` +
            `${`${byKind.ambiguous}/${totals.ambiguous}`.padEnd(6)} | ` +
            `${`${point.trueNoiseFalsePositiveQueries}/${trueNoiseTotal}`.padEnd(8)} | ` +
            `${formatRate(point.trueNoiseFalsePositiveRate).padEnd(10)} | ` +
            `${formatRate(point.nearMissFalsePositiveRate).padEnd(8)} | ` +
            `${(point.trueNoiseGuardPass ? 'CUMPLE' : 'no cumple').padEnd(11)} | ` +
            `${formatIds(point.trueNoiseFalsePositiveIds)}`
        );
    }
}

function printSetTable(set) {
    console.log(`--- set ${set.name} (${set.positives} positivas / ${set.negatives} negativas) ---`);
    if (set.note) console.log(`nota: ${set.note}`);
    console.log('threshold | recall@8 | FP-rate | precision | F1 | guard | FP ids | missed ids');
    for (const point of set.thresholds) {
        console.log(
            `${String(point.threshold).padEnd(9)} | ${formatPercent(point.recallAt8).padEnd(8)} | ` +
            `${formatPercent(point.falsePositiveRate).padEnd(7)} | ${point.precisionProxy.toFixed(3).padEnd(9)} | ` +
            `${point.f1.toFixed(3)} | ${(point.guardPass ? 'CUMPLE' : 'no cumple').padEnd(9)} | ` +
            `${formatIds(point.falsePositiveIds)} | ${formatIds(point.missedPositiveIds)}`
        );
    }
    console.log(
        `mejor F1: ${set.bestF1.maxF1.toFixed(3)} en threshold(s) ${set.bestF1.thresholds.join(', ')}`
    );
    console.log(
        `guard recall>=0.80 y FP<=0.10: ${set.guard.pass ? `CUMPLE en ${set.guard.thresholds.join(', ')}` : 'NO CUMPLE'}`
    );
    const trueNoiseGuardThresholds = set.thresholds
        .filter(point => point.trueNoiseGuardPass)
        .map(point => point.threshold);
    console.log(
        `guard ruido verdadero (general+ambiguous) recall>=0.80 y FP<=0.10: ` +
        `${trueNoiseGuardThresholds.length > 0
            ? `CUMPLE en ${trueNoiseGuardThresholds.join(', ')}`
            : 'NO CUMPLE'}`
    );
    printKindTable(set);
}

function printExtendedSummary(set) {
    console.log(`--- set extended (diagnóstico: ${set.positives} positivas / ${set.negatives} negativas) ---`);
    console.log(`nota: ${set.note}`);
    console.log(
        'FP-rate por threshold: ' +
        set.thresholds.map(point => `${point.threshold}=${formatPercent(point.falsePositiveRate)}`).join(' | ')
    );
    const defaultPoint = set.thresholds.find(point => point.threshold === PRODUCTION_THRESHOLD);
    if (defaultPoint) console.log(`FP ids @0.75: ${formatIds(defaultPoint.falsePositiveIds)}`);
    printKindTable(set);
    console.log('detalle completo por consulta: JSON de salida.');
}

function printRecommendationSection(label, recommendation) {
    console.log(`=== Recomendación pre-registrada (${label}: ${recommendation.positives}/${recommendation.negatives}) ===`);
    console.log(recommendation.note);
    if (recommendation.recommended) {
        const recommended = recommendation.recommended;
        console.log(
            `MIGRAR a ${recommended.label} en threshold ${recommended.threshold}: ` +
            `recall@8 ${formatPercent(recommended.recallAt8)}, FP ${formatPercent(recommended.falsePositiveRate)}, ` +
            `dRecall ${recommended.recallDelta.toFixed(3)}, dFP ${recommended.fpDelta.toFixed(3)}`
        );
    } else {
        console.log('NO MIGRAR: ningún candidato cumple A ni B.');
    }
    for (const candidate of recommendation.candidates) {
        console.log(
            `- ${candidate.label}: ${candidate.verdict}; guard ${candidate.guard.pass ? 'CUMPLE' : 'NO CUMPLE'}; ` +
            (candidate.defaultThreshold
                ? `default 0.75: recall ${formatPercent(candidate.defaultThreshold.recallAt8)}, ` +
                  `FP ${formatPercent(candidate.defaultThreshold.falsePositiveRate)}, ` +
                  `veredicto ${candidate.defaultThreshold.verdict}`
                : 'default 0.75: no evaluado (lista --thresholds sin 0.75)')
        );
    }
}

function printReport(report) {
    const core = report.dataset.core;
    const extended = report.dataset.extended;
    console.log(`Dataset core: ${core.path}`);
    console.log(`SHA-256 core: ${core.sha256}`);
    console.log(
        `Core (canónico): ${core.corpus} corpus | ${core.positives} positivas | ${core.negatives} negativas ` +
        `(${core.negativeKinds.general} general, ${core.negativeKinds['near-miss']} near-miss, ` +
        `${core.negativeKinds.ambiguous} ambiguous)`
    );
    if (extended) {
        console.log(`Dataset extended: ${extended.path}`);
        console.log(`SHA-256 extended: ${extended.sha256}`);
        console.log(
            `Extended: ${extended.negatives} negativas (${extended.negativeKinds.general} general, ` +
            `${extended.negativeKinds['near-miss']} near-miss, ${extended.negativeKinds.ambiguous} ambiguous)`
        );
        console.log(
            `Combined: ${report.dataset.combined.corpus} corpus | ${report.dataset.combined.positives} positivas | ` +
            `${report.dataset.combined.negatives} negativas`
        );
    } else {
        console.log('Extended: no cargado (--no-extended o archivo ausente); solo set core.');
    }
    console.log(`Node: ${report.environment.node} | @xenova/transformers: ${report.environment.transformersVersion ?? 'desconocida'}`);
    console.log(`Caché: ${report.environment.cacheDir} (${report.environment.cacheBytes} bytes, ${report.environment.cacheFiles} archivos)`);
    console.log(`Rank global máximo registrado en misses: ${report.protocol.globalRankLimit}; si se supera, rank=null y rankBeyondLimit=true.`);
    console.log('');

    for (const model of report.models) {
        const cost = model.cost;
        console.log(`=== ${model.label} (${model.model}) ===`);
        console.log(`prefijos: docs="${cost.documentsPrefix}" queries="${cost.queriesPrefix}"`);
        console.log(
            `coste: load ${cost.loadMs.toFixed(0)} ms (${cost.cacheState}) | warmup ${cost.warmupMs.toFixed(0)} ms | ` +
            `embed ${cost.texts} textos ${cost.embedMs.toFixed(0)} ms (${cost.perTextMs.toFixed(2)} ms/texto) | ` +
            `caché ${cost.modelCacheDir} ${cost.modelCacheAfter.bytes} bytes`
        );
        for (const setName of ['core', 'combined']) {
            const set = model.sets[setName];
            if (set) printSetTable(set);
        }
        if (model.sets.extended) printExtendedSummary(model.sets.extended);
        console.log('');
    }

    for (const setName of report.recommendation.availableSets) {
        console.log(`=== Comparación vs MiniLM (${setName}, mismo threshold) ===`);
        console.log('modelo | threshold | dRecall | dFP | veredicto');
        for (const model of report.models) {
            const comparisons = model.sets[setName]?.comparisonVsMiniLM;
            if (!comparisons) continue;
            for (const comparison of comparisons) {
                console.log(
                    `${model.label.padEnd(9)} | ${String(comparison.threshold).padEnd(9)} | ` +
                    `${comparison.recallDelta >= 0 ? '+' : ''}${comparison.recallDelta.toFixed(3)} | ` +
                    `${comparison.fpDelta >= 0 ? '+' : ''}${comparison.fpDelta.toFixed(3)} | ${comparison.verdict}`
                );
            }
        }
        console.log('');
    }

    console.log(report.recommendation.note);
    printRecommendationSection(`base ${report.recommendation.basis}`, report.recommendation.bySet[report.recommendation.basis]);
    if (report.recommendation.basis !== 'core') {
        console.log('');
        printRecommendationSection('referencia core', report.recommendation.bySet.core);
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const core = loadCoreDataset(options.dataset, { enforceThresholds: !options.thresholdsExplicit });
    const extended = options.extendedNegatives
        ? loadExtendedDataset(options.extendedNegatives, core)
        : null;
    fs.mkdirSync(options.cache, { recursive: true });
    const { module: transformers, version } = await loadTransformers();

    const models = [];
    for (const config of MODELS) {
        console.error(`[eval] cargando ${config.model} (caché ${options.cache})...`);
        const result = await evaluateModel({
            config,
            dataset: core.dataset,
            extended: extended?.dataset ?? null,
            transformers,
            cacheDir: options.cache,
            thresholds: options.thresholds
        });
        result.cost.documentsPrefix = config.docPrefix;
        result.cost.queriesPrefix = config.queryPrefix;
        models.push(result);
        const coreDefault = result.sets.core.thresholds.find(point => point.threshold === PRODUCTION_THRESHOLD);
        const combinedDefault = result.sets.combined?.thresholds.find(point => point.threshold === PRODUCTION_THRESHOLD);
        const describeDefault = point => point
            ? `recall@0.75=${formatPercent(point.recallAt8)}, FP=${formatPercent(point.falsePositiveRate)}`
            : 'threshold 0.75 no evaluado';
        console.error(
            `[eval] ${config.label}: core ${describeDefault(coreDefault)}` +
            (result.sets.combined ? ` | combined ${describeDefault(combinedDefault)}` : '')
        );
    }

    const cacheStats = dirStats(options.cache);
    const recommendationSets = extended ? ['core', 'combined'] : ['core'];
    const report = {
        dataset: {
            core: {
                path: options.dataset,
                sha256: core.sha256,
                version: core.dataset.version,
                synthetic: core.dataset.synthetic,
                language: core.dataset.language,
                corpus: core.counts.corpus,
                positives: core.counts.positives,
                negatives: core.counts.negatives,
                difficulties: core.counts.difficulties,
                negativeKinds: core.counts.negativeKinds
            },
            extended: extended
                ? {
                    path: options.extendedNegatives,
                    sha256: extended.sha256,
                    version: extended.dataset.version,
                    synthetic: extended.dataset.synthetic,
                    language: extended.dataset.language,
                    negatives: extended.counts.negatives,
                    negativeKinds: extended.counts.negativeKinds
                }
                : null,
            combined: {
                corpus: core.counts.corpus,
                positives: core.counts.positives,
                negatives: core.counts.negatives + (extended ? extended.counts.negatives : 0)
            }
        },
        protocol: {
            ...core.dataset.protocol,
            thresholds: options.thresholds,
            datasetThresholds: core.dataset.protocol.thresholds,
            thresholdSource: options.thresholdsExplicit ? 'cli' : 'dataset',
            globalRankLimit: GLOBAL_RANK_LIMIT
        },
        environment: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            transformersVersion: version,
            cacheDir: options.cache,
            cacheBytes: cacheStats.bytes,
            cacheFiles: cacheStats.files
        },
        models,
        recommendation: summarizeRecommendation(models, recommendationSets)
    };

    printReport(report);

    if (options.out) {
        fs.mkdirSync(path.dirname(options.out), { recursive: true });
        fs.writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
        console.log(`\nJSON: ${options.out}`);
    } else {
        console.log('\nJSON:');
        console.log(JSON.stringify(report, null, 2));
    }
}

main().catch(error => {
    console.error(`[eval] ERROR: ${error?.message ?? error}`);
    if (error?.cause) console.error(`[eval] Causa: ${error.cause.message ?? error.cause}`);
    process.exitCode = 1;
});
