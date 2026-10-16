import { ingest, saveInitialIndex } from '../src/ingestion/pipeline';
try {
  console.log(await ingest(console.log));
  if (process.argv.includes('--export')) {
    saveInitialIndex();
    console.log('Index exported to fixtures/embeddings/index.json.gz');
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : 'Ingestion failed.');
  process.exitCode = 1;
}
