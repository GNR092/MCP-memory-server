import assert from 'node:assert/strict';

const offsets = [-0.018, -0.014, -0.010, -0.006, -0.002, 0, 0.002, 0.006, 0.010, 0.014, 0.018, 0.009];
const pairs = [0.3, 0.5, 0.7, 0.9].flatMap((center, bucket) => offsets.map((offset, index) => ({
    id: `bucket-${center}-${index + 1}`,
    similarity: center + offset,
    lexicalHit: bucket < 2 && index < 2,
    relevant: bucket >= 2 || (bucket < 2 && index < 2)
})));
pairs.push(
    { id: 'near-compat-0.34', similarity: 0.34, lexicalHit: false, relevant: false },
    { id: 'near-compat-0.36', similarity: 0.36, lexicalHit: false, relevant: false },
    { id: 'near-strict-0.9375', similarity: 0.9375, lexicalHit: false, relevant: true },
    { id: 'near-strict-0.9385', similarity: 0.9385, lexicalHit: false, relevant: true },
    { id: 'near-strict-0.939', similarity: 0.939, lexicalHit: false, relevant: true },
    { id: 'near-strict-0.94', similarity: 0.94, lexicalHit: false, relevant: true }
);

assert.ok(pairs.length >= 50 && pairs.length <= 100);

function metrics(accepted) {
    let truePositives = 0;
    let falsePositives = 0;
    let falseNegatives = 0;
    for (const pair of pairs) {
        const hit = accepted(pair);
        if (hit && pair.relevant) truePositives += 1;
        if (hit && !pair.relevant) falsePositives += 1;
        if (!hit && pair.relevant) falseNegatives += 1;
    }
    return {
        truePositives,
        falsePositives,
        falseNegatives,
        precision: truePositives / (truePositives + falsePositives),
        recall: truePositives / (truePositives + falseNegatives),
        f1: 2 * truePositives / (2 * truePositives + falsePositives + falseNegatives)
    };
}

const thresholds = [0.35, 0.5, 0.7, 0.75, 0.8, 0.9, 1.0, 1.140175];
const results = thresholds.map(threshold => {
    const vectorHit = pair => 1 - pair.similarity <= threshold ** 2 / 2;
    return {
        threshold,
        vector: metrics(vectorHit),
        hybrid: metrics(pair => vectorHit(pair) || pair.lexicalHit)
    };
});

assert.equal(pairs.length, 54);
assert.deepEqual(results.map(({ vector, hybrid }) => [
    [vector.truePositives, vector.falsePositives, vector.falseNegatives],
    [hybrid.truePositives, hybrid.falsePositives, hybrid.falseNegatives]
]), [
    [[2, 0, 30], [6, 0, 26]],
    [[16, 0, 16], [20, 0, 12]],
    [[16, 0, 16], [20, 0, 12]],
    [[16, 0, 16], [20, 0, 12]],
    [[28, 0, 4], [32, 0, 0]],
    [[28, 0, 4], [32, 0, 0]],
    [[28, 7, 4], [32, 7, 0]],
    [[30, 11, 2], [32, 11, 0]]
]);

function bestF1(channel) {
    const max = Math.max(...results.map(result => result[channel].f1));
    const best = results.filter(result => Math.abs(result[channel].f1 - max) < 1e-12);
    return {
        thresholds: best.map(result => result.threshold),
        ...best[0][channel]
    };
}

const report = {
    pairs: pairs.length,
    labeling: 'synthetic: semantic buckets 0.3/0.5 are negative and 0.7/0.9 positive; four explicit exact-FTS pairs are positive in hybrid metrics',
    metricColumns: ['TP', 'FP', 'FN', 'precision', 'recall', 'F1'],
    results,
    bestTradeoffInThisDataset: {
        criterion: 'maximum synthetic F1; descriptive only, not a product-default selection',
        vector: bestF1('vector'),
        hybrid: bestF1('hybrid'),
        elbow: '0.8 and 0.9 tie; moving to 1.0 adds 7 false positives in each channel without increasing recall. The hybrid reaches all labeled positives at 0.8 because exact-FTS pairs are included.'
    },
    limitation: 'These synthetic labels do not estimate recall or precision on a real linguistic corpus.'
};

console.log('threshold | vector TP/FP/FN P/R | hybrid TP/FP/FN P/R');
for (const { threshold, vector, hybrid } of results) {
    const fmt = ({ truePositives, falsePositives, falseNegatives, precision, recall }) =>
        `${truePositives}/${falsePositives}/${falseNegatives} ${precision.toFixed(3)}/${recall.toFixed(3)}`;
    console.log(`${String(threshold).padEnd(9)} | ${fmt(vector).padEnd(23)} | ${fmt(hybrid)}`);
}
console.log(JSON.stringify(report, null, 2));
