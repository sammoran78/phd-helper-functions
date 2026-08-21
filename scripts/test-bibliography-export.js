const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const { __test } = require('../src/functions/references');

async function run() {
    const references = Array.from({ length: 445 }, (_, index) => {
        const number = index + 1;
        return {
            id: `ref-${number}`,
            authors: `Author ${String(number).padStart(3, '0')}`,
            year: '2026',
            title: `Complete export entry ${number}`,
            apa7: `Author ${String(number).padStart(3, '0')} (2026). Complete export entry ${number}.`
        };
    });
    references[444].apa7 = `Author 445 (2026). ${'Full citation content '.repeat(70)}END-OF-LONG-CITATION.`;

    const buffer = await __test.createBibliographyDocxBuffer(references);
    const zip = new AdmZip(buffer);
    const documentXml = zip.readAsText('word/document.xml');

    assert.match(documentXml, /Complete export entry 1/);
    assert.match(documentXml, /Complete export entry 400/);
    assert.match(documentXml, /END-OF-LONG-CITATION/);
    assert.doesNotMatch(documentXml, /Export truncated/);

    console.log('Complete bibliography DOCX export test passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
