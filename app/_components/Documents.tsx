import {
  excerptText,
  formatDate,
  referenceDate,
  relevantSources,
  stripDocHeader,
  type AnyRecord,
} from '../../src/ui-helpers';
import { Icon } from './Icon';

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const day = (d: string) => formatDate(d, false);

// DL1: where a cited chunk sits in its document's text. A chunk is "<title>[\n<heading>]\n\n<body>";
// the body is located from its first to its last paragraph. null = not found (shown apart, never
// guessed).
function citedRange(text: string, chunk: string): [number, number] | null {
  const body = chunk.split('\n\n').slice(1).filter(Boolean);
  if (!body.length) return null;
  const start = text.indexOf(body[0]);
  const last = start < 0 ? -1 : text.indexOf(body.at(-1)!, start);
  return last < 0 ? null : [start, last + body.at(-1)!.length];
}
// U11: markdown headings shown as headings, not "## ". Never applied inside the cited mark (DL1
// compares its text with the chunk body).
// `top`: the part starts the body, so a leading heading gets no top margin.
const headings = (part: string, top = false) =>
  part.split(/\n*^#{1,6} (.*)$\n*/m).map((t, i, parts) =>
    i % 2 ? (
      <strong className={`doc-heading${top && i === 1 && !parts[0] ? ' first' : ''}`} key={i}>
        {t}
      </strong>
    ) : (
      t
    ),
  );
// DL1: document text with the cited excerpt marked; an excerpt not found in the text is shown
// above it as the cited excerpt instead.
function DocumentText({ text, excerpt }: { text: string; excerpt: string | null }) {
  const range = excerpt ? citedRange(text, excerpt) : null;
  // U11: the title line and the "Document <id>. Version N. …" paragraph are shown as the reader
  // title and chips, not repeated in the body (stripped from the unmarked start only).
  if (!excerpt) return <div className="doc-text">{headings(stripDocHeader(text), true)}</div>;
  if (!range)
    return (
      <>
        <blockquote className="cited-excerpt" aria-label="Cited excerpt">
          {excerpt}
        </blockquote>
        <div className="doc-text">{headings(stripDocHeader(text), true)}</div>
      </>
    );
  return (
    <div className="doc-text">
      {headings(stripDocHeader(text.slice(0, range[0])), true)}
      <mark className="cited-excerpt" aria-label="Cited excerpt">
        {text.slice(...range)}
      </mark>
      {headings(text.slice(range[1]))}
    </div>
  );
}

function ValidityBadge({ validity }: { validity: string }) {
  return validity === 'current' ? (
    <span className="doc-badge positive">Current</span>
  ) : (
    <span className="doc-badge">Archived</span>
  );
}

type DocFilter = { product: string; validity: string };
export function Documents({
  operator,
  ingestBusy,
  onIngest,
  query,
  onQuery,
  searchBusy,
  onSearch,
  sources,
  onCloseResults,
  onOpenSource,
  docs,
  loading,
  products,
  docFilter,
  onFilter,
  document,
  onOpenDocument,
  cited,
  readerRef,
}: {
  operator: boolean;
  ingestBusy: boolean;
  onIngest(): void;
  query: string;
  onQuery(v: string): void;
  searchBusy: boolean;
  onSearch(): void;
  sources: AnyRecord[] | null;
  onCloseResults(): void;
  onOpenSource(id: string, chunkId?: string): void;
  docs: AnyRecord[];
  loading: boolean;
  products: string[];
  docFilter: DocFilter;
  onFilter(next: DocFilter): void;
  document: AnyRecord | null;
  onOpenDocument(id: string): void;
  cited: { documentId: string; text: string } | null;
  readerRef: React.RefObject<HTMLElement | null>;
}) {
  // U11: `loading` (page.tsx) replaces "0 sources" while the list is fetched; hits under the
  // relevance cut-off are not results.
  const relevant = relevantSources(sources ?? []);
  const groups = [...products, null]
    .map((p) => ({ p, items: docs.filter((d) => (d.product ?? null) === p) }))
    .filter((g) => g.items.length);
  return (
    <div className="documents-view">
      <div className="page-heading">
        <div>
          <div className="eyebrow">SOURCES AND POLICIES</div>
          <h1>Documents</h1>
          <p>The original documents the assistant reads, with their versions and dates.</p>
        </div>
        <div className="library-actions">
          {/* U9: the status line is "status as of <date>", no "(document reference date)". */}
          <span className="library-status">
            {loading
              ? 'Loading documents…'
              : `${docs.length} sources · status as of ${day(referenceDate)}`}
          </span>
          {operator && (
            <button className="secondary-button" disabled={ingestBusy} onClick={onIngest}>
              {ingestBusy ? 'Updating…' : 'Update index'}
            </button>
          )}
        </div>
      </div>
      <div className="library-toolbar">
        <form
          className="search-form"
          onSubmit={(e) => {
            e.preventDefault();
            onSearch();
          }}
        >
          <Icon name="search" size={16} />
          <input
            aria-label="Search documents"
            placeholder="Search a policy, fee or product…"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
          />
          <button className="primary-button" disabled={searchBusy || !query.trim()}>
            Search
          </button>
        </form>
        {/* DL1: filter by product and validity at the reference date. */}
        <span className="pill-select">
          <select
            aria-label="Filter by product"
            value={docFilter.product}
            onChange={(e) => onFilter({ ...docFilter, product: e.target.value })}
          >
            <option value="">All products</option>
            {products.map((p) => (
              <option key={p} value={p}>
                {cap(p)}
              </option>
            ))}
          </select>
          <Icon name="chevron" size={14} />
        </span>
        <span className="pill-select">
          <select
            aria-label="Filter by validity"
            value={docFilter.validity}
            onChange={(e) => onFilter({ ...docFilter, validity: e.target.value })}
          >
            <option value="">Current and archived</option>
            <option value="current">Current only</option>
            <option value="archived">Archived</option>
          </select>
          <Icon name="chevron" size={14} />
        </span>
      </div>
      {sources && (
        <section className="card search-results">
          <div className="results-head">
            <h2>Results for “{query}”</h2>
            <button className="text-button" onClick={onCloseResults}>
              Close results
            </button>
          </div>
          {/* U11: hits under the relevance cut-off are not results. */}
          {!relevant.length && (
            <p className="empty-state">
              No relevant results. Try other words, or browse the documents below.
            </p>
          )}
          {relevant.map((s) => (
            <article key={s.id}>
              <h3>{s.title || 'Untitled excerpt'}</h3>
              <small>
                Version {s.version} · Effective {day(s.validFrom)}
                {s.validTo ? ` to ${day(s.validTo)}` : ''}
              </small>
              {/* U11: scores and ids are for operators only. */}
              {operator && (
                <span className="result-meta">
                  <span className="doc-badge">Similarity {s.score.toFixed(3)}</span>
                  <span className="doc-id">{s.documentId}</span>
                </span>
              )}
              <p>{excerptText(s.text)}</p>
              <button className="text-button" onClick={() => onOpenSource(s.documentId, s.id)}>
                Open document →
              </button>
            </article>
          ))}
        </section>
      )}
      <div className="documents-layout">
        <section className="card document-list">
          {loading ? (
            <p className="empty-state">Loading documents…</p>
          ) : !docs.length ? (
            <p className="empty-state">No documents match these filters.</p>
          ) : (
            groups.map(({ p, items }) => (
              <div key={p ?? ''}>
                <h3 className="group-label">{p ? cap(p) : 'Other'}</h3>
                {items.map((d) => (
                  <button
                    key={d.id}
                    className={`doc-item${document?.id === d.id ? ' selected' : ''}`}
                    onClick={() => onOpenDocument(d.id)}
                  >
                    <Icon name="document" size={15} />
                    <span className="doc-text-col">
                      <strong>{d.title}</strong>
                      <small>
                        v{d.version} ·{' '}
                        {d.validity === 'archived' && d.validTo
                          ? `until ${day(d.validTo)}`
                          : `from ${day(d.validFrom)}`}
                      </small>
                    </span>
                    <ValidityBadge validity={d.validity} />
                    {operator && d.audience === 'internal' && (
                      <span className="doc-badge lime">Internal</span>
                    )}
                  </button>
                ))}
              </div>
            ))
          )}
        </section>
        <section className="card document-reader" ref={readerRef} tabIndex={-1}>
          {document ? (
            <>
              <header className="reader-head">
                <div className="reader-chips">
                  <ValidityBadge validity={document.validity} />
                  <span className="doc-chip">Version {document.version}</span>
                  <span className="doc-chip">
                    Effective {day(document.validFrom)}
                    {document.validTo ? ` – ${day(document.validTo)}` : ''}
                  </span>
                  <span className="doc-chip">
                    {document.audience === 'internal' ? 'Internal' : 'Customers'}
                  </span>
                </div>
                <h2>{document.title}</h2>
                {operator && <div className="doc-id">{document.id}</div>}
              </header>
              {cited?.documentId === document.id && (
                <p className="cited-note">
                  <Icon name="sparkle" size={14} />
                  Highlighted: the excerpt the assistant cited
                </p>
              )}
              <div className="doc-body">
                <DocumentText
                  text={document.text}
                  excerpt={cited && cited.documentId === document.id ? cited.text : null}
                />
              </div>
            </>
          ) : (
            <div className="empty-panel">
              <Icon name="document" size={28} />
              <h2>Open a document</h2>
              <p>Check policies, exceptions and dates in the original source.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
